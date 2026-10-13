"""Offline loop-policy tests. Actual model and gateway validation is separate."""
import json
import unittest
from unittest.mock import patch

from rea_assistant import decision, encode, observation, references, run_assistant
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
        self.assertEqual(references(shown)['evidence_id'], 'ev_1')
        self.assertEqual(shown['result_id'], 'result-owned')


if __name__ == '__main__': unittest.main()
