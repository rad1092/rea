#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { publicTools, ALLOWED_TOOLS, getSchema, getToolSummary, validateCall, validatePublicCall } from '../lib/contracts.mjs';
import { PIN, NODE, cleanEnvironment, sandboxProfile } from '../lib/sandbox.mjs';
import { UpstreamClient } from '../lib/upstream-client.mjs';
import { verifyRuntime } from '../lib/attestation.mjs';
import { admitToolCallParams } from '../lib/protocol-meta.mjs';

const PACKAGE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAX_INPUT = 32768, MAX_OUTPUT = 16384, MAX_STORED = 32 * 1024 * 1024;
const evidence = new Set(), results = new Map();
let session, upstream, active, dead = false, snapshots = 0, storedBytes = 0;
const within = (root, target) => target === root || target.startsWith(root + path.sep);
const textResult = value => ({ content: [{type:'text',text:JSON.stringify(value)}] });
const errorResult = message => ({isError:true,...textResult({error:String(message).slice(0,3000)})});
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function keys(value, allowed, required = []) {
  if (!plain(value) || Object.keys(value).some(k=>!allowed.includes(k)) || required.some(k=>!Object.hasOwn(value,k))) throw new Error('Invalid or unsupported arguments');
}
function boundedResultProjection(value) {
  const normalized = value?.normalized_result;
  const projection = {
    summary:normalized?.summary, coverage:normalized?.coverage, limitations:normalized?.limitations,
    authority:value?.authority, confidence:value?.confidence,
    source_evidence_id:normalized?.source_evidence_id, trace_id:normalized?.trace_id,
  };
  const omitted = reason => ({projection_omitted:true,projection_omission_reason:reason});
  if(!Object.values(projection).some(item=>item!==undefined)) return omitted('Upstream result has no supported summary fields.');
  if(Buffer.byteLength(JSON.stringify(projection))<=6000) return {projection};
  if(projection.limitations!==undefined) {
    projection.limitations_omitted=true;
    projection.omitted_limitations_count=Array.isArray(projection.limitations)?projection.limitations.length:null;
    delete projection.limitations;
  }
  if(Buffer.byteLength(JSON.stringify(projection))<=6000) return {projection};
  return omitted('Selected summary fields exceed 6000 UTF-8 bytes even without limitations; read the complete retained result.');
}
async function canonicalDir(key) {
  const value = process.env[key];
  if (!value || !path.isAbsolute(value)) throw new Error(`${key} must be an explicit absolute directory`);
  const canonical = await fs.realpath(value);
  if (!(await fs.stat(canonical)).isDirectory()) throw new Error(`${key} must be a directory`);
  return canonical;
}
function runSandbox(args, profile, env, cwd, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const signal = active?.controller.signal;
    signal?.throwIfAborted();
    const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, NODE, ...args], {env,cwd,stdio:['ignore','pipe','pipe']});
    let stdout = '', stderr = '', size = 0;
    const timer = setTimeout(()=>child.kill('SIGKILL'), timeout);
    const cancel = ()=>child.kill('SIGKILL');
    signal?.addEventListener('abort', cancel, {once:true});
    child.stdout.on('data', chunk=>{ size += chunk.length; if(size > 128*1024) child.kill('SIGKILL'); else stdout += chunk.toString(); });
    child.stderr.on('data', chunk=>{stderr=(stderr+chunk.toString()).slice(-3000);});
    child.once('error', error=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);reject(error);});
    child.once('close', (code, sig)=>{
      clearTimeout(timer); signal?.removeEventListener('abort',cancel);
      if(code !== 0 || signal?.aborted) reject(new Error(`Restricted snapshot failed (${code ?? sig}): ${stderr}`));
      else resolve(stdout);
    });
  });
}
function halt(reason) {
  dead = true; evidence.clear(); results.clear();
  upstream?.close(reason); active?.controller.abort();
}
async function main() {
  process.umask(0o077);
  const major = +process.versions.node.split('.')[0], minor = +process.versions.node.split('.')[1];
  if (!((major===22 && minor>=19)||(major===24 && minor>=11)||major>=26)) throw new Error('Unsupported Node version');
  const root = await canonicalDir('REA_ANALYSIS_ROOT');
  const runtime = await canonicalDir('REA_UPSTREAM_ROOT');
  const state = await canonicalDir('REA_STATE_ROOT');
  if (within(root, state) || within(state, root) || within(root, runtime) || within(runtime, root) || within(runtime,state) || within(state,runtime)) throw new Error('Analysis, runtime and state directories must not overlap');
  const manifest = process.env.REA_RUNTIME_MANIFEST;
  if (!manifest || !path.isAbsolute(manifest)) throw new Error('REA_RUNTIME_MANIFEST must identify a reviewed runtime attestation');
  await verifyRuntime(runtime, manifest);
  session = await fs.mkdtemp(path.join(state, 'rea-session-'));
  for (const dir of ['home','tmp','snapshots','results']) await fs.mkdir(path.join(session,dir), {mode:0o700});
  const env = cleanEnvironment(session);
  const profile = sandboxProfile({read:[...['dist','node_modules','package.json','package-lock.json'].map(name=>path.join(runtime,name)),session],write:[path.join(session,'home'),path.join(session,'tmp')]});
  upstream = new UpstreamClient({command:'/usr/bin/sandbox-exec',args:['-p',profile,NODE,'--max-old-space-size=256',path.join(runtime,'dist/main.js')], env, cwd:session,onFatal:error=>halt(error.message)});
  const initialized = await upstream.request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'rea-static-gateway',version:'0.1.0'}});
  if(!initialized?.serverInfo) throw new Error('Upstream did not initialize');
  upstream.notify('notifications/initialized');
  const inventory = await upstream.request('tools/list');
  for(const tool of ALLOWED_TOOLS) if(!inventory.tools?.some(t=>t.name===tool)) throw new Error(`Pinned upstream missing ${tool}`);

  async function acquire(args) {
    keys(args,['input_path','source_paths'],['input_path']);
    const normalized = validateCall('analyze_javascript_application',args,evidence);
    if (snapshots >= 8) throw new Error('Eight analyses per process; restart for a new session');
    if (path.isAbsolute(normalized.input_path) || normalized.input_path.includes('\\') || normalized.input_path.split('/').some(p=>p==='..')) throw new Error('input_path must be relative to the configured analysis root');
    const candidate = path.resolve(root, normalized.input_path);
    if (!within(root,candidate)) throw new Error('Input path escaped the analysis root');
    // Reject symlinks in every selected path component, even links pointing inward.
    let cursor = root;
    for(const segment of path.relative(root,candidate).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor,segment);
      if((await fs.lstat(cursor)).isSymbolicLink()) throw new Error('Symlink input paths are not accepted');
    }
    const source = await fs.realpath(candidate);
    if (!within(root,source) || !(await fs.stat(source)).isDirectory()) throw new Error('Input must be a directory inside the analysis root');
    snapshots++;
    const destination = path.join(session,'snapshots',randomUUID());
    await fs.mkdir(destination,{mode:0o700});
    const snapshotProfile = sandboxProfile({read:[source,path.join(PACKAGE,'lib')],write:[destination]});
    let manifestText;
    try { manifestText = await runSandbox([path.join(PACKAGE,'lib/snapshot-worker.mjs'),source,destination], snapshotProfile,env,session); }
    catch(error) {await fs.rm(destination,{recursive:true,force:true});throw error;}
    const snapshot = JSON.parse(manifestText);
    await fs.writeFile(path.join(session,`snapshot-${snapshots}.json`),manifestText,{flag:'wx',mode:0o600});
    const response = await upstream.request('tools/call',{name:'analyze_javascript_application',arguments:{...normalized,input_path:destination}},15000);
    return retain(response, 'analyze_javascript_application', {input_path:args.input_path,snapshot_files:snapshot.files.length,snapshot_bytes:snapshot.bytes});
  }
  async function retain(response, tool, context) {
    // Upstream may send both structuredContent and an identical text rendering.
    // Retain one full value without duplicating it in the local model context.
    let value = response.structuredContent;
    if (value === undefined) {
      const texts = response.content?.filter(c=>c.type==='text').map(c=>c.text) ?? [];
      if (texts.length===1) { try {value=JSON.parse(texts[0]);} catch {value={text:texts[0]};} }
      else value={content:response.content};
    }
    const full = JSON.stringify({isError:response.isError===true,tool,...(context?{snapshot:context}:{}),data:value});
    const bytes = Buffer.byteLength(full);
    if (bytes>2*1024*1024 || storedBytes+bytes>MAX_STORED || results.size>=128) {halt('Result retention limit exceeded');throw new Error('Result storage limit exceeded; session invalidated');}
    // Acquire authority only from actual successful analyze receipts; IDs seen in
    // caller arguments or arbitrary nested strings never grant access.
    if(tool==='analyze_javascript_application' && !response.isError) {
      const parent = value?.normalized_result?.parent_evidence_id;
      if (typeof parent==='string' && /^ev_[a-f0-9]{64}$/.test(parent)) evidence.add(parent);
    }
    const resultId = randomUUID();
    const resultPath=path.join(session,'results',resultId+'.json');
    await fs.writeFile(resultPath,full,{flag:'wx',mode:0o600});
    results.set(resultId,{path:resultPath,chars:full.length,bytes}); storedBytes+=bytes;
    const receipt={result_id:resultId,bytes,sha256:createHash('sha256').update(full).digest('hex'),upstream_tool:tool,complete_inline:true};
    const inline={isError:response.isError===true,...textResult({...receipt,result:JSON.parse(full)})};
    if(Buffer.byteLength(JSON.stringify(inline))+1024<=MAX_OUTPUT) return inline;
    receipt.complete_inline=false;
    // This is a projection of already-retained data, never a new evidence grant.
    const body={...receipt,parent_evidence_id:value?.normalized_result?.parent_evidence_id ?? null,evidence_id:value?.evidence_id ?? null,
      ...boundedResultProjection(value),notice:'Complete response retained. The projection, when present, contains selected upstream summary fields. Use rea_read_result with this process-local result_id for the complete result; omissions are explicit.'};
    let output={isError:response.isError===true,...textResult(body)};
    if(Buffer.byteLength(JSON.stringify(output))+1024>MAX_OUTPUT) {
      delete body.projection;
      body.projection_omitted=true;
      body.projection_omission_reason='Projection omitted because the encoded receipt exceeds the transport budget; read the complete retained result.';
      output={isError:response.isError===true,...textResult(body)};
    }
    if(Buffer.byteLength(JSON.stringify(output))+1024>MAX_OUTPUT) throw new Error('Retained result receipt exceeds the transport budget');
    return output;
  }
  async function call(name,args) {
    if(dead) throw new Error('Session invalidated; restart the wrapper');
    args = validatePublicCall(name,args);
    if(name==='rea_analyze') return acquire(args);
    if(name==='rea_discover') {
      keys(args,['tool']);
      return textResult(args.tool ? {...getToolSummary(args.tool),inputSchema:getSchema(args.tool)} : {profile:'static-js',pin:PIN,operations:ALLOWED_TOOLS.map(getToolSummary),advanced_enabled:false});
    }
    if(name==='rea_call') {
      keys(args,['tool','arguments'],['tool','arguments']);
      if(args.tool==='analyze_javascript_application') throw new Error('Use rea_analyze for path admission and snapshotting');
      const validated=validateCall(args.tool,args.arguments,evidence);
      return retain(await upstream.request('tools/call',{name:args.tool,arguments:validated}),args.tool);
    }
    if(name==='rea_read_result') {
      keys(args,['result_id','offset','limit'],['result_id']);
      const item=results.get(args.result_id), offset=args.offset??0, limit=args.limit??3000;
      if(!item) throw new Error('Result is not owned by this session');
      if(!Number.isSafeInteger(offset)||offset<0||offset>item.chars||!Number.isSafeInteger(limit)||limit<1||limit>6000) throw new Error('Invalid result page range');
      const text=await fs.readFile(item.path,'utf8');
      let end=Math.min(offset+limit,text.length), response;
      do {
        response=textResult({result_id:args.result_id,offset,next_offset:end,total_chars:text.length,complete:end>=text.length,text:text.slice(offset,end)});
        if(Buffer.byteLength(JSON.stringify(response))+1024<=MAX_OUTPUT) return response;
        end=offset+Math.floor((end-offset)/2);
      } while(end>offset);
      throw new Error('Result page encoding exceeds the transport budget');
    }
    throw new Error('Tool not allowed by the static profile');
  }
  const send = message => {
    let serialized=JSON.stringify(message);
    if(Buffer.byteLength(serialized)>MAX_OUTPUT) serialized=JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32001,message:'Response exceeds 16 KiB; request a smaller page'}});
    process.stdout.write(serialized+'\n');
  };
  let buffer=Buffer.alloc(0), initializedClient=false;
  process.stdin.on('data',chunk=>{
    if(buffer.length+chunk.length>MAX_INPUT) {halt('Input frame exceeds 32 KiB');process.stdin.destroy();return;}
    buffer=Buffer.concat([buffer,chunk]);
    for(;;){const i=buffer.indexOf(10);if(i<0)break;const line=buffer.subarray(0,i);buffer=buffer.subarray(i+1);if(!line.length)continue;
      let message;try{message=JSON.parse(line.toString());}catch{send({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON'}});continue;}
      void dispatch(message);
    }
  });
  async function dispatch(message) {
    if(!plain(message)||message.jsonrpc!=='2.0'||typeof message.method!=='string') {send({jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid request'}});return;}
    if(message.id!==undefined && !((typeof message.id==='string' && message.id.length<=128) || (typeof message.id==='number' && Number.isSafeInteger(message.id)))) {send({jsonrpc:'2.0',id:null,error:{code:-32600,message:'Request id must be a short string or integer'}});return;}
    if(message.method==='notifications/cancelled') {
      if(active && message.params?.requestId===active.id) halt('Cancelled; session invalidated to prevent stale evidence use');
      return;
    }
    if(message.id===undefined) return;
    const reply=value=>send({jsonrpc:'2.0',id:message.id,result:value});
    if(message.method==='initialize') {initializedClient=true;reply({protocolVersion:'2024-11-05',capabilities:{tools:{listChanged:false}},serverInfo:{name:'rea-static-gateway',version:'0.1.0'},instructions:'Static, directory-only, explicit-root REA. No execution/network/advanced tools. Evidence and result IDs are process-local.'});return;}
    if(!initializedClient) {send({jsonrpc:'2.0',id:message.id,error:{code:-32000,message:'Initialize first'}});return;}
    if(message.method==='ping'){reply({});return;}
    if(message.method==='tools/list'){reply({tools:publicTools});return;}
    if(message.method!=='tools/call'){send({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Method not allowed'}});return;}
    if(active){reply(errorResult('One tool call at a time; no unbounded queue'));return;}
    active={id:message.id,controller:new AbortController()};
    const timer=setTimeout(()=>halt('Tool deadline exceeded; restart session'),20000);
    try {const params=admitToolCallParams(message.params);const value=await call(params.name,params.arguments??{});if(dead)throw new Error('Session invalidated');reply(value);}
    catch(error){reply(errorResult(error.message));}
    finally{clearTimeout(timer);active=undefined;}
  }
  process.stdin.once('end',()=>{halt('Input closed');process.exit(0);});
}
process.once('SIGTERM',()=>{halt('Terminated');process.exit(0);});
process.once('SIGINT',()=>{halt('Interrupted');process.exit(0);});
main().catch(error=>{halt('Startup failed');process.stderr.write(`REA static gateway: ${error.message}\n`);process.exitCode=1;});
