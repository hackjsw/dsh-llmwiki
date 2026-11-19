import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';

test('native DSH tools enforce review requests and apply/undo the actual engine changes', async t => {
  const base = await fs.realpath(os.tmpdir());
  const dir = await fs.mkdtemp(path.join(base, 'dsh-wiki-management-'));
  t.after(async () => { assert.equal(path.dirname(dir), base); assert.ok(path.basename(dir).startsWith('dsh-wiki-management-')); await fs.rm(dir, { recursive: true, force: true }); });
  const root = path.join(dir, 'wiki');
  for (const folder of ['inbox', 'concepts', 'entities']) await fs.mkdir(path.join(root, folder), { recursive: true });
  await fs.writeFile(path.join(root, 'index.md'), '# Index\n'); await fs.writeFile(path.join(root, 'log.md'), '# Log\n');
  const tools = new Map(), listeners = new Map();
  const session = { id: 'native-management', snapshotEvents: () => [{ type: 'request/header', data: { header: { config: { provider: 'fixture', model: 'fixture' } } } }] };
  const agent = { session };
  let plan = { op: 'ADD', title: '中文偏好', slug: 'chinese-style', summary: '用户长期偏好简短中文答复。' };
  const ctx = {
    tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name); } },
    systemPrompt: { context: () => () => {} },
    on(name, callback) { listeners.set(name, callback); return () => listeners.delete(name); },
    get(name) { return name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'danger-full-access' }) } : name === 'sessions' ? { get: () => session } : undefined; },
    llm: { async *stream() { yield { type: 'text-delta', text: JSON.stringify(plan) }; yield { type: 'finish', reason: { kind: 'stop' } }; } },
  };
  const stop = apply(ctx, { root, fullMemory: true, autoTrustOwnerSessions: true, pythonExecutable: process.env.DSH_TEST_PYTHON || 'python' });
  t.after(stop);
  let turn = 0;
  async function say(text) {
    const message = { role: 'user', id: `m-${++turn}`, source: { kind: 'user', rpcId: `r-${turn}` }, content: [{ type: 'text', text }] };
    await listeners.get('agent/pre-step')({ agent, turn, messages: [message] }, async () => ({ kind: 'enter', messages: [message] }));
  }
  async function call(name, args) { return JSON.parse(await tools.get(name).execute(args, { agent, signal: new AbortController().signal })); }
  for (const name of ['wiki_review','wiki_undo','wiki_flush','wiki_consolidate','wiki_maintenance']) assert.ok(tools.has(name));
  await say('记住：用户长期偏好简短中文答复。');
  const saved = await call('wiki_remember', { title: '简短中文答复', content: '用户长期偏好简短中文答复。' });
  assert.equal(saved.consolidated.outcomes[0].result, 'applied');
  const first = saved.consolidated.outcomes[0];
  await say('查看 Wiki 记忆状态');
  const status = await call('wiki_status', {});
  assert.equal(status.success, true); assert.equal(status.memory.pending, 0);
  assert.match((await call('wiki_undo', { changeId: first.change_id })).error, /Owner must/);
  await say(`撤销记忆变更 ${first.change_id}`);
  assert.equal((await call('wiki_undo', { changeId: first.change_id })).success, true);
  await say('列出待审记忆');
  const review = await call('wiki_review', {});
  assert.equal(review.candidates.length, 1);
  const cid = review.candidates[0].candidate_id;
  assert.match((await call('wiki_review', { action: 'approve', candidateId: cid })).error, /Owner must/);
  await say(`批准候选 ${cid}`);
  assert.equal((await call('wiki_review', { action: 'approve', candidateId: cid })).promoted, true);
  await say('检查 Wiki 健康和索引');
  assert.equal((await call('wiki_maintenance', {})).lint.success, true);
  await say('立即整理记忆');
  assert.equal((await call('wiki_flush', {})).pending, 0);
});
