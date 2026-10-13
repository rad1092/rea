"""Offline loop-policy tests. Actual model and gateway validation is separate."""
import json
import unittest
from unittest.mock import patch

from rea_assistant import decision, encode, observation, parse_decision, references, run_assistant, model_catalog
from rea_connector import ReaConfig, ReaError


class OwnedSessionFixture:
    instances = []
    def __init__(self, config):
        self.session_id = 'owned-session'
        self.tools = [{'name':name,'inputSchema':{'type':'object'}} for name in ('rea_analyze','rea_discover','rea_call','rea_read_result')]
        self.calls = []
        self.closed = False
        self.instances.append(self)
    async def __aenter__(self): return self
    async def call(self, name, arguments, *, owner_session_id):
        assert owner_session_id == self.session_id
        self.calls.append((name, arguments))
        if name == 'rea_discover':
            value = {'name':arguments['tool'],'inputSchema':{'type':'object'}}
        else:
            value = {'result_id':'result-owned','sha256':'a'*64,'bytes':100,'result':{'data':{
                'evidence_id':'ev_'+'b'*64,
                'normalized_result':{'parent_evidence_id':'ev_'+'c'*64,'summary':{'fixture':True}},
            }}}
        return {'content':[{'type':'text','text':encode(value)}]}
    async def close(self): self.closed = True


class AssistantTests(unittest.TestCase):
    def test_advertised_page_limit_matches_host_without_changing_gateway_schema(self):
        original = [{'name':'rea_read_result', 'inputSchema':{'properties':{'limit':{'maximum':6000}}}}]
        narrowed = model_catalog(original)
        self.assertEqual(narrowed[0]['inputSchema']['properties']['limit']['maximum'], 2000)
        self.assertEqual(original[0]['inputSchema']['properties']['limit']['maximum'], 6000)
        with self.assertRaises(ReaError):
            decision({'action':'tool','tool':'rea_read_result','arguments':{'result_id':'r','limit':2001}}, 'owned', set())

    def test_accepts_exact_whole_json_fence(self):
        value = {'action':'tool','tool':'rea_discover','arguments':{'tool':'trace_application_feature'}}
        self.assertEqual(parse_decision('```json\n'+encode(value)+'\n```', 'owned', set()), value)
        self.assertEqual(parse_decision(' \n```json\r\n'+encode(value)+'\r\n```\n ', 'owned', set()), value)
        self.assertEqual(parse_decision(encode(value), 'owned', set()), value)

    def test_rejects_prose_and_multiple_fenced_blocks(self):
        block = '```json\n{"action":"finish"}\n```'
        for raw in ('Here it is:\n'+block, block+'\nDone.', block+'\n'+block,
                    '```python\n{"action":"finish"}\n```',
                    '```json\n```json\n{"action":"finish"}\n```\n```'):
            with self.subTest(raw=raw), self.assertRaises((ReaError, ValueError)):
                parse_decision(raw, 'owned', set())

    def test_receipt_preserves_bounded_raw_before_parse(self):
        for raw in ('not-json', '가'*4000):
            with self.subTest(length=len(raw)), patch('rea_assistant.ReaSession', OwnedSessionFixture):
                with self.assertRaises(ReaError) as caught:
                    run_assistant(ReaConfig(), 'owned', '설명', lambda *_:raw, max_steps=1)
                record = caught.exception.rea_receipt['decisions'][0]
                self.assertLessEqual(len(record['raw_model_decision'].encode()), 8192)
                self.assertEqual(record['raw_model_decision_truncated'], len(raw.encode()) > 8192)
                self.assertNotIn('choice', record)

    def test_model_choices_drive_calls_and_references_survive_discovery(self):
        replies = iter([
            encode({'action':'tool','tool':'rea_analyze','arguments':{'input_path':'owned'}}),
            encode({'action':'tool','tool':'rea_discover','arguments':{'tool':'trace_application_feature'}}),
            encode({'action':'tool','tool':'rea_call','arguments':{'tool':'trace_application_feature','arguments':{'fixture':True}}}),
            encode({'action':'finish'}),
            '실제 fixture 결과에 근거한 요약',
        ])
        prompts = []
        def model(text, tokens):
            prompts.append(text)
            return next(replies)
        with patch('rea_assistant.ReaSession', OwnedSessionFixture):
            result = run_assistant(ReaConfig(), 'owned', '설명', model)
        session = OwnedSessionFixture.instances[-1]
        self.assertEqual([item[0] for item in session.calls], ['rea_analyze','rea_discover','rea_call'])
        self.assertIn('ev_'+'c'*64, prompts[2])
        context = json.loads(prompts[2].split('\n', 1)[1])
        self.assertEqual(context['completed_calls'][1]['arguments'], {'tool':'trace_application_feature'})
        self.assertEqual(context['completed_calls'][0]['analysis_reference'],
                         {'kind':'retained-evidence','evidence_id':'ev_'+'c'*64})
        self.assertNotIn('evidence_id', context['completed_calls'][0])
        self.assertNotIn('view_evidence_id', context['completed_calls'][0])
        self.assertTrue(result['model_directed'])
        self.assertTrue(session.closed)
        self.assertEqual(len(result['tool_results']), 3)

    def test_model_cannot_change_target_or_invoke_unadvertised_tools(self):
        with self.assertRaises(ReaError):
            decision({'action':'tool','tool':'rea_analyze','arguments':{'input_path':'elsewhere'}}, 'owned', set())
        with self.assertRaises(ReaError):
            decision({'action':'tool','tool':'open_binary','arguments':{}}, 'owned', set())
        with self.assertRaises(ReaError):
            decision({'action':'tool','tool':'rea_call','arguments':{'tool':'inspect_analysis_view','arguments':{}}}, 'owned', set())

    def test_repeat_and_early_finish_are_not_reported_as_completion(self):
        for text in (encode({'action':'finish'}), encode({'action':'tool','tool':'rea_analyze','arguments':{'input_path':'owned'}})):
            with self.subTest(text=text), patch('rea_assistant.ReaSession', OwnedSessionFixture):
                with self.assertRaises(ReaError):
                    run_assistant(ReaConfig(), 'owned', '설명', lambda *_:text, max_steps=2)
                self.assertTrue(OwnedSessionFixture.instances[-1].closed)

    def test_step_limit_forces_summary_without_extra_tool_action(self):
        count = 0
        def model(text, tokens):
            nonlocal count
            count += 1
            if count == 1: return encode({'action':'tool','tool':'rea_analyze','arguments':{'input_path':'owned'}})
            return '한 번 실행한 결과 요약'
        with patch('rea_assistant.ReaSession', OwnedSessionFixture):
            result = run_assistant(ReaConfig(), 'owned', '설명', model, max_steps=1)
        self.assertEqual(count, 2)
        self.assertEqual(len(result['tool_results']), 1)

    def test_normalizes_real_gateway_envelope_and_preserves_ids(self):
        value = {'result_id':'result-owned','result':{'data':{'evidence_id':'ev_1','normalized_result':{'parent_evidence_id':'ev_2'}}}}
        shown = observation({'content':[{'type':'text','text':json.dumps(value)}]})
        self.assertEqual(references(shown)['parent_evidence_id'], 'ev_2')
        self.assertEqual(references(shown)['analysis_reference'], {'kind':'retained-evidence','evidence_id':'ev_2'})
        self.assertNotIn('evidence_id', references(shown))
        self.assertEqual(shown['result']['data']['view_evidence_id'], 'ev_1')
        self.assertNotIn('evidence_id', shown['result']['data'])
        self.assertEqual(shown['result_id'], 'result-owned')
        self.assertEqual(value['result']['data']['evidence_id'], 'ev_1')

    def test_large_projection_separates_view_from_tool_ready_reference(self):
        value = {'result_id':'result-owned','result':{'data':{
            'evidence_id':'ev_view','raw_result':'x'*9500,
            'normalized_result':{'parent_evidence_id':'ev_parent','summary':{'count':2}},
        }}}
        original = {'content':[{'type':'text','text':json.dumps(value)}]}
        before = encode(original)
        shown = observation(original)
        self.assertEqual(shown['view_evidence_id'], 'ev_view')
        self.assertEqual(shown['analysis_reference'], {'kind':'retained-evidence','evidence_id':'ev_parent'})
        self.assertNotIn('evidence_id', shown)
        self.assertNotIn('evidence_id', references(shown))
        self.assertEqual(encode(original), before)

    def test_model_argument_ids_are_never_rewritten(self):
        choice = {'action':'tool','tool':'rea_call','arguments':{
            'tool':'trace_application_feature','arguments':{
                'application':{'kind':'retained-evidence','evidence_id':'ev_wrong_view'},
                'seed':{'kind':'route','value':'/quote'},
            }}}
        accepted_envelope = decision(choice, 'owned', {'trace_application_feature'})
        self.assertEqual(accepted_envelope['arguments']['arguments']['application']['evidence_id'], 'ev_wrong_view')


if __name__ == '__main__': unittest.main()
