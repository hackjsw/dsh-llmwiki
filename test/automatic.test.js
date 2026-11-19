import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eligibleAutomaticMemory, mountWiki, resolveConfig } from '../lib/runtime.js';
import { MemoryStore } from '../lib/memory.js';
import { WikiStore } from '../lib/wiki.js';

test('automatic memory prefilter rejects questions, secrets, quoted content and opt-outs', () => {
  assert.equal(eligibleAutomaticMemory('我长期喜欢简洁的中文答复。'), true);
  for (const text of ['我今天要怎么做？', '我不希望保存我的信息', '我的密码是123456', '我的链接是 https://example.com', '我说：\n引用内容', '请记住我喜欢蓝色']) {
    assert.equal(eligibleAutomaticMemory(text), false, text);
  }
});

test('automatic writes require a trusted owner turn, full access and no sharing', async () => {
  const handlers = new Map(), tools = new Map(), services = new Map();
  let prompt, mode = 'danger-full-access';
  const ctx = {
    tools: { register: t => { tools.set(t.name, t); return () => tools.delete(t.name); } },
    systemPrompt: { context: c => { prompt = c; return () => {}; } },
    on: (name, handler) => { handlers.set(name, handler); return () => handlers.delete(name); },
    get: name => name === 'sandboxPolicy' ? { resolve: () => ({ mode }) } : services.get(name),
  };
  const ops = [];
  const memory = { prepare: x => { ops.push(x); return {operationId:'test'}; }, commit: async (_, {authorize}) => ({status: await authorize() ? 'committed' : 'not-started'}) };
  const store = { search: async () => ({results:[]}) };
  const config = resolveConfig({root:path.resolve('fake'), allowedSessionIds:['local'], autoCapture:true});
  const stop = mountWiki(ctx, config, store, memory);
  const agent = {session:{id:'local'}};
  const step = async (text, turn, source = {kind:'user',rpcId:'test'}) => {
    const message = {id:`m${turn}`,role:'user',source,content:[{type:'text',text}]};
    return handlers.get('agent/pre-step')({agent,turn,messages:[message]}, async () => ({kind:'enter',messages:[message]}));
  };
  const call = async () => JSON.parse(await tools.get('wiki_auto_capture').execute({}, {agent}));
  await step('我长期喜欢简洁的中文答复。', 1);
  assert.match(prompt.text({agent}), /wiki_auto_capture/);
  assert.equal((await call()).status, 'committed');
  assert.equal(ops[0].content, '我长期喜欢简洁的中文答复。');
  assert.equal(ops[0].automatic, true);
  mode = 'read-only';
  assert.equal((await call()).status, 'not-started');
  mode = 'danger-full-access';
  services.set('liveshareShares', {});
  assert.deepEqual(await call(), {error:'Wiki access unavailable'});
  services.delete('liveshareShares');
  await step('我想查看历史记录。', 2, {kind:'user',rpcId:'x',principal:{kind:'viewer'}});
  assert.deepEqual(await call(), {error:'Wiki access unavailable'});
  await step('不要保存我的资料', 3);
  assert.equal((await call()).status, 'not-started');
  assert.equal(ops.length, 1);
  stop();
});

test('opted-in owner sessions need no per-session binding; viewers, shared sessions and subagents stay blocked', async () => {
  const handlers=new Map(),tools=new Map(),services=new Map();
  const ctx={
    tools:{register:t=>{tools.set(t.name,t);return()=>tools.delete(t.name)}},
    systemPrompt:{context:()=>()=>{}},
    on:(name,fn)=>{handlers.set(name,fn);return()=>handlers.delete(name)},
    get:name=>name==='sandboxPolicy'?{resolve:()=>({mode:'danger-full-access'})}:services.get(name),
  };
  const config=resolveConfig({root:path.resolve('fake'),autoCapture:true,autoTrustOwnerSessions:true});
  const stop=mountWiki(ctx,config,{search:async()=>({results:[]}),status:async()=>({success:true})},
    {prepare:()=>({operationId:'auto'}),commit:async()=>({status:'committed'})});
  const agent={session:{id:'new-local',header:{}}};
  const step=async (turn,source={kind:'user',rpcId:'test'})=>{
    const message={id:`m${turn}`,role:'user',source,content:[{type:'text',text:'我长期偏好简洁的中文答复。'}]};
    await handlers.get('agent/pre-step')({agent,turn,messages:[message]},async()=>({kind:'enter',messages:[message]}));
  };
  const call=async()=>JSON.parse(await tools.get('wiki_auto_capture').execute({}, {agent}));
  await step(1);
  assert.equal((await call()).status,'committed');
  await step(2,{kind:'user',rpcId:'telegram-6df08267-6eb5-4d59-8991-06747d8c1ed8'});
  assert.equal((await call()).status,'committed');
  await step(3,{kind:'user',rpcId:'viewer',principal:{kind:'viewer'}});
  assert.deepEqual(await call(),{error:'Wiki access unavailable'});
  services.set('liveshareShares',{});
  await step(4);
  assert.deepEqual(await call(),{error:'Wiki access unavailable'});
  services.delete('liveshareShares');
  agent.session.header.origin='subagent';
  await step(5);
  assert.deepEqual(await call(),{error:'Wiki access unavailable'});
  stop();
});

test('automatic memory deduplicates exact statements across sessions without losing negation', async t => {
  const base=await fs.realpath(os.tmpdir());
  const root=await fs.mkdtemp(path.join(base,'dsh-auto-memory-test-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'entities'));
  await fs.writeFile(path.join(root,'index.md'),'# Index\n');
  await fs.writeFile(path.join(root,'log.md'),'# Log\n');
  const store=new MemoryStore({root});
  const fact='我不喜欢使用英文答复。';
  const input={title:fact,content:fact,sessionId:'session-a',explicit:true,automatic:true};
  const first=await store.commit(store.prepare(input),{authorize:()=>true});
  const second=await store.commit(store.prepare({...input,sessionId:'session-b'}),{authorize:()=>true});
  assert.equal(first.status,'committed');
  assert.equal(second.status,'committed');
  assert.equal(second.duplicate,true);
  assert.equal((await fs.readdir(path.join(root,'entities'))).length,1);
  assert.match(await fs.readFile(path.join(root,...first.path.split('/')),'utf8'), /我不喜欢使用英文答复。/);
  const recalled=await new WikiStore({root}).search('英文答复',{recall:true});
  assert.ok(recalled.results.some(item => item.path === first.path));
});
