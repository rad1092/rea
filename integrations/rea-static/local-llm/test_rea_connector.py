"""Owned transport fixtures only; these tests do not prove REA or model behavior."""
import asyncio
from dataclasses import replace
import json
from pathlib import Path
import sys
import tempfile
import unittest

from rea_connector import ReaConfig, ReaError, ReaSession, summary_messages

FIXTURE = '''
import json, os, sys, time
names=['rea_analyze','rea_discover','rea_call','rea_read_result']
for line in sys.stdin:
 message=json.loads(line)
 if 'id' not in message: continue
 method=message['method']
 if method=='initialize': result={'serverInfo':{'name':'rea-static-gateway'}}
 elif method=='tools/list': result={'tools':[{'name':name,'inputSchema':{'type':'object'}} for name in names]}
 else:
  args=message['params'].get('arguments',{})
  if args.get('fixture_sleep'): time.sleep(60)
  if args.get('fixture_large'):
   print('x'*17000, flush=True); continue
  result={'content':[{'type':'text','text':json.dumps({'fixture':True,'environment':dict(os.environ)})}]}
 print(json.dumps({'jsonrpc':'2.0','id':message['id'],'result':result}), flush=True)
'''


class ConnectorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='rea-connector-')
        self.root = Path(self.temp.name)
        for name in ('bin', 'source', 'analysis', 'state'):
            (self.root / name).mkdir()
        (self.root / 'bin/rea-static-mcp.mjs').write_text(FIXTURE)
        (self.root / 'runtime.json').write_text('{}')
        self.config = ReaConfig(enabled=True, node=sys.executable,
            wrapper=str(self.root / 'bin/rea-static-mcp.mjs'),
            upstream_root=str(self.root / 'source'), analysis_root=str(self.root / 'analysis'),
            state_root=str(self.root / 'state'), runtime_manifest=str(self.root / 'runtime.json'))

    async def asyncTearDown(self):
        self.temp.cleanup()

    async def test_disabled_and_missing_roots_never_launch(self):
        with self.assertRaisesRegex(ReaError, 'disabled'):
            async with ReaSession(ReaConfig()): pass
        with self.assertRaisesRegex(ReaError, 'explicit absolute'):
            async with ReaSession(replace(self.config, analysis_root='')): pass

    async def test_real_protocol_discovery_call_and_clean_environment(self):
        async with ReaSession(self.config) as session:
            self.assertEqual(len(session.tools), 4)
            result = await session.call('rea_analyze', {'input_path': '.'}, owner_session_id=session.session_id)
            value = json.loads(result['content'][0]['text'])
            # Python/macOS may add interpreter locale bookkeeping after exec.
            actual = {k:v for k,v in value['environment'].items() if k not in ('LC_CTYPE','__CF_USER_TEXT_ENCODING')}
            self.assertEqual(set(actual), {'PATH','REA_ANALYSIS_ROOT','REA_STATE_ROOT','REA_UPSTREAM_ROOT','REA_RUNTIME_MANIFEST'})
            self.assertEqual(actual['PATH'], '/usr/bin:/bin')
            with self.assertRaisesRegex(ReaError, 'not exposed'):
                await session.call('open_binary', {}, owner_session_id=session.session_id)
            with self.assertRaisesRegex(ReaError, 'does not belong'):
                await session.call('rea_analyze', {}, owner_session_id='another-session')
        self.assertIsNotNone(session._process.returncode)
        with self.assertRaisesRegex(ReaError, 'closed'):
            await session.call('rea_discover', {}, owner_session_id=session.session_id)

    async def test_cancellation_closes_process_and_invalidates_connection(self):
        session = await ReaSession(self.config).__aenter__()
        task = asyncio.create_task(session.call('rea_call', {'fixture_sleep':True}, owner_session_id=session.session_id))
        await asyncio.sleep(0.05)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError): await task
        self.assertIsNotNone(session._process.returncode)
        with self.assertRaisesRegex(ReaError, 'closed'):
            await session.call('rea_discover', {}, owner_session_id=session.session_id)

    async def test_oversized_response_closes_connection(self):
        async with ReaSession(self.config) as session:
            with self.assertRaisesRegex(ReaError, 'exceeds'):
                await session.call('rea_call', {'fixture_large':True}, owner_session_id=session.session_id)
        self.assertIsNotNone(session._process.returncode)

    async def test_summary_input_is_bounded_and_has_no_tools(self):
        messages = summary_messages('이 기능을 설명해 주세요.', {'result_id':'owned-id','location':'index.js:4','complete':False})
        self.assertEqual([m['role'] for m in messages], ['system','user'])
        self.assertEqual(json.loads(messages[1]['content'])['untrusted_rea_evidence']['result_id'], 'owned-id')
        with self.assertRaisesRegex(ReaError, 'smaller retained evidence'):
            summary_messages('Explain it.', {'text':'a'*12001})


if __name__ == '__main__':
    unittest.main()
