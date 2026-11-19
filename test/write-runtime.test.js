import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mountWiki, resolveConfig, userRequestedMemory, userRequestedHistorical } from '../lib/runtime.js';

function fixture() {
  const listeners = new Map();
  const tools = new Map();
  let mode = 'danger-full-access';
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    systemPrompt: { context: () => () => {} },
    on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name); },
    get(name) { return name === 'sandboxPolicy' ? { resolve: () => ({ mode }) } : undefined; },
  };
  const agent = { session: { id: 'session-private' } };
  const store = { search: async () => ({ results: [] }), readSource: async () => ({}), status: async () => ({}) };
  const operations = [];
  const memory = {
    prepare(input) { operations.push(['prepare', input]); return { operationId: 'synthetic-op' }; },
    async commit(_plan, { authorize }) {
      if (!await authorize({ stage: 'page' })) return { status: 'not-started', operationId: 'synthetic-op' };
      operations.push(['commit']);
      return { status: 'committed', operationId: 'synthetic-op' };
    },
  };
  const config = resolveConfig({ root: path.resolve('fixture'), allowedSessionIds: ['session-private'] });
  const stop = mountWiki(ctx, config, store, memory);
  const step = async (turn, text, source = { kind: 'user', rpcId: 'rpc' }) => {
    const message = { id: `m${turn}`, role: 'user', source, content: [{ type: 'text', text }] };
    await listeners.get('agent/pre-step')({ agent, turn, messages: [message] }, async () => ({ kind: 'enter', messages: [message] }));
  };
  const remember = async (input = { title: '简短答复', content: '我偏爱简短答复' }) =>
    JSON.parse(await tools.get('wiki_remember').execute(input, { agent }));
  return { agent, memory, operations, stop, step, remember, setMode: value => { mode = value; } };
}

test('explicit request detection rejects negation and unrelated questions', () => {
  for (const text of ['请记住我偏爱简短答复', '帮我记一下我的偏好是简短回答', '把我喜欢蓝色保存到知识库', 'Remember my preference is brief answers']) assert.equal(userRequestedMemory(text), true);
  for (const text of ['你好', '不要记住这个', '别记一下这个', '别把这个写入记忆', '把这个保存到知识库', 'Remember this preference', '不要把我的私人对话以及下面粘贴的全部资料记住', '请记住我喜欢蓝色，但不要把它存到长期记忆', '请分析这句话是否恰当：记住我喜欢蓝色', "Don't remember this"]) assert.equal(userRequestedMemory(text), false);
});

test('historical access requires a direct affirmative owner request', () => {
  for (const value of ['请查询历史资料', '帮我查看归档', 'Please inspect archived evidence']) assert.equal(userRequestedHistorical(value), true);
  for (const value of ['查询当前资料', '不要查询历史资料', '请查询是否有历史资料，但不要打开它们', '请分析这句话：查询历史资料', 'Do not show archived evidence']) assert.equal(userRequestedHistorical(value), false);
  assert.equal(userRequestedHistorical('请查询历史资料', 'search'), true);
  assert.equal(userRequestedHistorical('请查询历史资料', 'read'), false);
  assert.equal(userRequestedHistorical('请读取历史资料', 'read'), true);
});

test('write requires an explicit owner request and current full-access policy', async () => {
  const f = fixture();
  await f.step(1, '知识库里有什么？');
  assert.equal((await f.remember()).status, 'not-started');
  await f.step(2, '请记住我偏爱简短答复');
  f.setMode('read-only');
  assert.equal((await f.remember()).status, 'not-started');
  f.setMode('workspace-write');
  assert.equal((await f.remember()).status, 'not-started');
  assert.equal(f.operations.length, 0);
  f.setMode('danger-full-access');
  assert.equal((await f.remember()).status, 'committed');
  assert.equal(f.operations[0][1].explicit, true);
  assert.equal(f.operations[0][1].sessionId, 'session-private');
  f.stop();
});

test('only exact excerpts of the owner request can be saved', async () => {
  const f = fixture();
  await f.step(1, '请记住我喜欢蓝色');
  assert.equal((await f.remember({ title: '蓝色', content: '我喜欢红色' })).status, 'not-started');
  assert.equal((await f.remember({ title: '颜色偏好', content: '我喜欢蓝色' })).status, 'not-started');
  assert.equal(f.operations.length, 0);
  assert.equal((await f.remember({ title: '蓝色', content: '我喜欢蓝色' })).status, 'committed');
  await f.step(2, '请记住我不喜欢蓝色但我喜欢红色');
  assert.equal((await f.remember({ title: '蓝色', content: '喜欢蓝色' })).status, 'not-started');
  assert.equal((await f.remember({ title: '喜欢蓝色', content: '我不喜欢蓝色但我喜欢红色' })).status, 'committed');
  assert.equal(f.operations.at(-2)[1].title, '我不喜欢蓝色但我喜欢红色');
  f.stop();
});

test('long requests and Unicode are never silently truncated or normalized when saved', async () => {
  const f = fixture();
  const complete = '甲'.repeat(4093) + '但仅限本次';
  await f.step(1, `记住：${complete}`);
  assert.equal((await f.remember({ title: '甲', content: complete.slice(0, 4093) })).status, 'not-started');
  assert.equal((await f.remember({ title: '甲', content: complete })).status, 'committed');
  await f.step(2, '记住：我喜欢ＡＢＣ');
  assert.equal((await f.remember({ title: 'ＡＢＣ', content: '我喜欢ABC' })).status, 'not-started');
  assert.equal((await f.remember({ title: 'ＡＢＣ', content: '我喜欢ＡＢＣ' })).status, 'committed');
  assert.equal(f.operations.at(-2)[1].content, '我喜欢ＡＢＣ');
  await f.step(3, `记住：${'甲'.repeat(7000)}`);
  assert.equal((await f.remember({ title: '甲', content: '甲'.repeat(100) })).status, 'not-started');
  f.stop();
});

test('external user and a denied instruction cannot write memory', async () => {
  const f = fixture();
  await f.step(1, '请记住这件事', { kind: 'user', rpcId: 'r', principal: { kind: 'viewer' } });
  assert.deepEqual(await f.remember(), { error: 'Wiki access unavailable' });
  await f.step(2, '不要记住这件事');
  assert.equal((await f.remember()).status, 'not-started');
  assert.equal(f.operations.length, 0);
  f.stop();
});

test('revocation during write is reported accurately; unexpected commit exceptions stay unknown', async () => {
  const f = fixture();
  await f.step(1, '请记住我偏爱简短答复');
  f.memory.commit = async (_plan, { authorize }) => {
    assert.equal(await authorize({ stage: 'page' }), true);
    f.setMode('read-only');
    assert.equal(await authorize({ stage: 'index' }), false);
    return { status: 'partial', operationId: 'synthetic-op', stage: 'index' };
  };
  assert.equal((await f.remember()).status, 'partial');
  f.setMode('danger-full-access');
  f.memory.commit = async () => { throw new Error('uncertain internal error'); };
  assert.deepEqual(await f.remember(), { status: 'unknown', operationId: 'synthetic-op', error: 'Inspect the operation before retrying' });
  f.stop();
});
