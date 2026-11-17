import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { zstdCompressSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { fileInfo, openSource, sourceId } from '../src/adapters/adapter.ts';
import { antigravityAdapter } from '../src/adapters/antigravity.ts';
import { deepseekAdapter } from '../src/adapters/deepseek.ts';
import { spawnSync } from 'node:child_process';
import { VerifiedSource } from '../src/raw/evidence.ts';
import { geminiAdapter } from '../src/adapters/gemini.ts';

const root = mkdtempSync(join(tmpdir(), 'agentshark-adapter-regressions-'));
after(() => rmSync(root, { recursive: true, force: true }));
function vi(n: number): Buffer { const a: number[]=[]; do { a.push((n % 128) | (n >= 128 ? 128 : 0)); n=Math.floor(n/128); } while(n); return Buffer.from(a); }
const pv = (f: number, n: number) => Buffer.concat([vi(f*8), vi(n)]);
const pb = (f: number, b: Buffer) => Buffer.concat([vi(f*8+2), vi(b.length), b]);
const ps = (f: number, s: string) => pb(f, Buffer.from(s));
const timestamp = 1763168400;
function fixture(name: string, rows: {type:number,status:number,text:string,tool?:string}[], transcript: any[]) {
  const base=join(root,name), conv='aaaaaaaa-1111-4222-8333-444444444444';
  mkdirSync(join(base,'conversations'),{recursive:true});
  const path=join(base,'conversations',conv+'.db');
  const db=new DatabaseSync(path);
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_format INTEGER, step_payload BLOB, metadata BLOB, error_details BLOB)');
  rows.forEach((r,i)=>{
    const content=r.type===14?pb(19,ps(2,r.text)):pb(20,ps(8,r.text));
    const payload=Buffer.concat([pv(1,r.type),pv(4,r.status),content]);
    const meta=Buffer.concat([pb(1,pv(1,timestamp+i)),...(r.tool?[pb(4,Buffer.concat([ps(1,'call-'+i),ps(2,r.tool)]))]:[])]);
    db.prepare('INSERT INTO steps VALUES (?, ?, ?, 0, ?, ?, NULL)').run(i,r.type,r.status,payload,meta);
  });
  db.close();
  const logDir=join(base,'brain',conv,'.system_generated','logs'); mkdirSync(logDir,{recursive:true});
  const log=join(logDir,'transcript_full.jsonl');
  writeFileSync(log,transcript.map((r,i)=>JSON.stringify({step_index:i,source:'MODEL',status:'DONE',created_at:new Date((timestamp+i)*1000).toISOString(),...r})).join('\n')+'\n');
  return {base,path,log};
}
async function parse(path:string,kind:any) {
 const file=(await fileInfo(path,'antigravity',kind,'antigravity'))!; const records:any[]=[];
 await antigravityAdapter.parse({file,sourceId:sourceId(path)},{emit(r){records.push(r)}}); return records;
}

test('zstd: many frames crossing sliding-read boundaries preserve exact bytes', async()=>{
  const parts=Array.from({length:7},(_,i)=>randomBytes(110000+i*41000));
  const path=join(root,'multi.jsonl.zstd');writeFileSync(path,Buffer.concat(parts.map(p=>zstdCompressSync(p))));
  const fh=await openSource(path);const expected=Buffer.concat(parts);const actual=Buffer.alloc(expected.length);
  try { for(let p=0;p<actual.length;){const n=await fh.read(actual,p,Math.min(65537,actual.length-p),p);assert.ok(n.bytesRead);p+=n.bytesRead;} assert.deepEqual(actual,expected); }
  finally {await fh.close()}
});

test('zstd: verified individual raw lines survive many small frames',async()=>{
 const parts=Array.from({length:300},()=>Buffer.from(JSON.stringify({text:randomBytes(2000).toString('hex')})+'\n'));
 const expected=Buffer.concat(parts);const path=join(root,'small-frames.jsonl.zstd');writeFileSync(path,Buffer.concat(parts.map(p=>zstdCompressSync(p))));
 const source=await VerifiedSource.open(path,{sha256:createHash('sha256').update(expected).digest('hex'),bytes:expected.length});
 try{let pos=0;for(const part of parts){assert.deepEqual(await source.read(pos,part.length-1),part.subarray(0,-1));pos+=part.length;}}finally{await source.close()}
});

test('zstd: raw evidence remains readable when consumers pause between lines',async()=>{
 const parts=Array.from({length:2000},()=>Buffer.from(JSON.stringify({text:randomBytes(1000).toString('hex')})+'\n'));
 const frames:Buffer[]=[];for(let i=0;i<parts.length;i+=100)frames.push(zstdCompressSync(Buffer.concat(parts.slice(i,i+100))));
 const expected=Buffer.concat(parts);const path=join(root,'paused-lines.jsonl.zstd');writeFileSync(path,Buffer.concat(frames));
 const source=await VerifiedSource.open(path,{sha256:createHash('sha256').update(expected).digest('hex'),bytes:expected.length});
 try{let pos=0;for(const part of parts){assert.deepEqual(await source.read(pos,part.length-1),part.subarray(0,-1));pos+=part.length;await new Promise(r=>setImmediate(r));}}finally{await source.close()}
});

test('Cortex: live transcript must extend a checkpointed turn span',async()=>{
  const f=fixture('turn-tail',[{type:14,status:3,text:'prompt'}],[{type:'USER_INPUT',source:'USER_EXPLICIT',content:'prompt'},{type:'PLANNER_RESPONSE',content:'answer'}]);
  const home=join(f.base,'index-home');mkdirSync(home);
  writeFileSync(join(home,'sources.json'),JSON.stringify({version:1,autoDiscover:false,claudeRoots:[],codexRoots:[],antigravityRoots:[f.base]}));
  const cli=spawnSync(process.execPath,['bin/agentshark.ts','index'],{env:{...process.env,AGENTSHARK_HOME:home},encoding:'utf8'});assert.equal(cli.status,0,cli.stderr);
  const db=new DatabaseSync(join(home,'index.sqlite'),{readOnly:true});
  try {const answer=db.prepare("select ts from events where kind='llm.text'").get()!;const turn=db.prepare("select end_ts from spans where kind='turn'").get()!;
  assert.ok(turn.end_ts>=answer.ts,`turn.end_ts=${turn.end_ts}, answer.ts=${answer.ts}`);}finally{db.close()}
});

test('Cortex: transcript completion must replace a checkpointed in-progress step',async()=>{
  const f=fixture('stale-step',[{type:14,status:3,text:'prompt'},{type:15,status:1,text:'partial'}],[{type:'USER_INPUT',source:'USER_EXPLICIT',content:'prompt'},{type:'PLANNER_RESPONSE',content:'completed answer',output_tokens:50}]);
  const records=[...await parse(f.path,'trajectory-db'),...await parse(f.log,'antigravity-transcript')];
  const answers=records.filter(r=>r.rec==='event'&&r.kind==='llm.text');
  assert.equal(answers.length,1);assert.equal(answers[0].attrs.text,'completed answer');
});

test('Cortex: retain pending parallel tool names across a partially checkpointed batch',async()=>{
  const f=fixture('tool-tail',[{type:14,status:3,text:'prompt'},{type:15,status:3,text:'tools'},{type:100,status:3,text:'file text',tool:'view_file'}],[
   {type:'USER_INPUT',source:'USER_EXPLICIT',content:'prompt'},
   {type:'PLANNER_RESPONSE',tool_calls:[{name:'view_file',args:{AbsolutePath:'/tmp/a'}},{name:'run_command',args:{CommandLine:'pwd'}}]},
   {type:'GENERIC',content:'file text'}, {type:'RUN_COMMAND',content:'Command exited with code 0.\n/tmp'}]);
  const records=await parse(f.log,'antigravity-transcript');const result=records.find(r=>r.kind==='tool.result');
  assert.equal(result.attrs.tool.name,'run_command');assert.equal(result.attrs.tool.kind,'shell');
});

test('DeepSeek: TTFT measures first content token, excluding block-start headers',async()=>{
 const path=join(root,'dsh-ttft.jsonl');const time=1763168400000;
 const lines=[{type:'session',header:{version:4,id:'ttft',createdAt:time}},
  {type:'step/start',time,data:{turn:1,step:1}},
  {type:'assistant/message',time:time+2000,data:{turn:1,step:1,message:{id:'a',content:[{type:'text',text:'hello'}]},stream:[
   {type:'chunk',time:time+100,chunk:{type:'block-start',index:0,blockType:'text'}},
   {type:'text-chunks',time0:time+700,index:0,dt:[0],texts:['hello']},
   {type:'chunk',time:time+2000,chunk:{type:'finish',reason:'stop'}}]}}];
 writeFileSync(path,lines.map(r=>JSON.stringify(r)).join('\n')+'\n');
 const file=(await fileInfo(path,'deepseek','dsh-session','deepseek'))!;const records:any[]=[];
 await deepseekAdapter.parse({file,sourceId:sourceId(path)},{emit(r){records.push(r)}});
 assert.equal(records.find(r=>r.kind==='llm.text').attrs.llm.ttft_ms,700);
});

test('zstd: torn final frames expose only the complete prefix, then recover after append', async () => {
  const prefix = Buffer.from('{"prefix":true}\n');
  const tail = Buffer.from(JSON.stringify({ text: randomBytes(180000).toString('hex') }) + '\n');
  const first = zstdCompressSync(prefix), second = zstdCompressSync(tail);
  const path = join(root, 'torn-append.zstd');
  for (const cut of [1, 6, 100, second.length - 1]) {
    writeFileSync(path, Buffer.concat([first, second.subarray(0, cut)]));
    const source = await openSource(path);
    try {
      const out = Buffer.alloc(prefix.length + tail.length);
      assert.equal((await source.read(out, 0, out.length, 0)).bytesRead, prefix.length);
      assert.deepEqual(out.subarray(0, prefix.length), prefix);
    } finally { await source.close(); }
  }
  appendFileSync(path, second.subarray(-1));
  const source = await VerifiedSource.open(path, {
    sha256: createHash('sha256').update(Buffer.concat([prefix, tail])).digest('hex'), bytes: prefix.length + tail.length,
  });
  try { assert.deepEqual(await source.read(prefix.length, tail.length), tail); }
  finally { await source.close(); }
});

test('Cortex: terminal checkpoints retain their rich response and missing steps remain recoverable', async () => {
  const f = fixture('sparse-steps', [
    { type: 14, status: 3, text: 'prompt' }, { type: 15, status: 3, text: 'checkpointed answer' },
  ], [
    { type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'prompt' },
    { type: 'PLANNER_RESPONSE', content: 'missing middle response' },
    { type: 'PLANNER_RESPONSE', content: 'stale transcript copy' },
  ]);
  const db = new DatabaseSync(f.path);
  db.exec('UPDATE steps SET idx = 2 WHERE idx = 1');
  db.close();
  for (const order of [[f.path, f.log], [f.log, f.path]]) {
    const records = (await Promise.all(order.map(path => parse(path, path === f.path ? 'trajectory-db' : 'antigravity-transcript')))).flat();
    const answers = records.filter(r => r.rec === 'event' && r.kind === 'llm.text');
    assert.deepEqual(answers.map(r => r.attrs.text).sort(), ['checkpointed answer', 'missing middle response']);
    assert.equal(records.filter(r => r.rec === 'span' && r.kind === 'turn').length, 1);
  }
});

test('Cortex: advancing a checkpoint preserves paired calls and one owner per span', async () => {
  const f = fixture('advance-checkpoint', [
    { type: 14, status: 3, text: 'prompt' }, { type: 15, status: 3, text: 'tools' },
    { type: 100, status: 3, text: '', tool: 'view_file' },
  ], [
    { type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'prompt' },
    { type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'view_file', args: {} }, { name: 'run_command', args: { CommandLine: 'pwd' } }] },
    { type: 'GENERIC', content: 'file text' }, { type: 'RUN_COMMAND', content: 'Command exited with code 0.\n/tmp' },
  ]);
  const home = join(f.base, 'index-home');
  mkdirSync(home);
  writeFileSync(join(home, 'sources.json'), JSON.stringify({ version: 1, autoDiscover: false, claudeRoots: [], codexRoots: [], antigravityRoots: [f.base] }));
  for (let stage = 0; stage < 3; stage++) {
    const result = spawnSync(process.execPath, ['bin/agentshark.ts', 'index', '--workers', '2'], {
      env: { ...process.env, AGENTSHARK_HOME: home }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const db = new DatabaseSync(join(home, 'index.sqlite'), { readOnly: true });
    try {
      const calls = db.prepare("SELECT tool_name FROM events WHERE kind = 'tool.call' ORDER BY tool_name").all();
      const results = db.prepare("SELECT tool_name FROM events WHERE kind = 'tool.result' ORDER BY tool_name").all();
      assert.deepEqual(calls.map(r => r.tool_name), ['run_command', 'view_file']);
      assert.deepEqual(results, calls);
      const spans = db.prepare("SELECT kind, count(*) AS n FROM spans GROUP BY kind").all();
      assert.equal(spans.find(r => r.kind === 'tool')?.n, 2);
      assert.equal(spans.find(r => r.kind === 'turn')?.n, 1);
    } finally { db.close(); }
    if (stage === 0) {
      const checkpoint = new DatabaseSync(f.path);
      checkpoint.prepare('INSERT INTO steps VALUES (3, 100, 3, 0, ?, ?, NULL)').run(
        Buffer.concat([pv(1, 100), pv(4, 3)]),
        Buffer.concat([pb(1, pv(1, timestamp + 3)), pb(4, Buffer.concat([ps(1, 'call-3'), ps(2, 'run_command')]))]),
      );
      checkpoint.close();
    }
  }
});

test('Gemini Code Mode reconciles completed text and turn bounds across both sources', async () => {
  const f = fixture('gemini-completion', [{ type: 14, status: 3, text: 'prompt' }, { type: 15, status: 1, text: 'partial' }], [
    { type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'prompt' },
    { type: 'PLANNER_RESPONSE', content: 'complete', output_tokens: 50 },
  ]);
  const records: any[] = [];
  for (const path of [f.log, f.path]) {
    const file = (await fileInfo(path, 'gemini', path === f.path ? 'trajectory-db' : 'antigravity-transcript', 'gemini'))!;
    await geminiAdapter.parse({ file, sourceId: sourceId(path) }, { emit: r => { records.push(r); } });
  }
  const answers = records.filter(r => r.rec === 'event' && r.kind === 'llm.text');
  assert.equal(answers.length, 1);
  assert.equal(answers[0].attrs.text, 'complete');
  assert.equal(answers[0].attrs.tokens.output, 50);
  assert.ok(answers[0].session.startsWith('gm:'));
  assert.equal(records.find(r => r.rec === 'span' && r.kind === 'turn').end, answers[0].ts);
});

test('DeepSeek: batched fragment gaps do not shift the first token or fabricate missing TTFT', async () => {
  const time = 1763168400000;
  for (const [name, texts, dt, expected] of [
    ['first', ['hello', ' world'], [123], 700],
    ['empty-first', ['', '', 'hello'], [100, 200], 1000],
    ['no-content', [], [], undefined],
  ] as const) {
    const path = join(root, `ttft-${name}.jsonl`);
    const lines = [{ type: 'session', header: { version: 4, id: name, createdAt: time } },
      { type: 'step/start', time, data: { turn: 1, step: 1 } },
      { type: 'assistant/message', time: time + 2000, data: { turn: 1, step: 1, message: { id: 'm', content: [] }, stream: [
        { type: 'chunk', time: time + 100, chunk: { type: 'block-start' } },
        { type: 'reasoning-chunks', time0: time + 700, texts, dt },
        { type: 'chunk', time: time + 2000, chunk: { type: 'finish' } },
      ] } }];
    writeFileSync(path, lines.map(r => JSON.stringify(r)).join('\n') + '\n');
    const records: any[] = [];
    const file = (await fileInfo(path, 'deepseek', 'dsh-session', 'deepseek'))!;
    await deepseekAdapter.parse({ file, sourceId: sourceId(path) }, { emit: r => { records.push(r); } });
    assert.equal(records.find(r => r.kind === 'llm.text').attrs.llm.ttft_ms, expected);
  }
});
