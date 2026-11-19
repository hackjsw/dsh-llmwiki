import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mountWiki, resolveConfig } from '../lib/runtime.js';
import { updateTrustedSessions } from '../scripts/trust-session.js';

test('new local session grants and revocations take effect without restarting the plugin', async t => {
  const tempRoot = await fs.realpath(os.tmpdir());
  const temp = await fs.mkdtemp(path.join(tempRoot, 'dsh-wiki-trust-runtime-'));
  assert.equal(path.dirname(temp), tempRoot);
  assert.match(path.basename(temp), /^dsh-wiki-trust-runtime-/);
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const file = path.join(temp, 'trusted-sessions.json');
  const handlers = new Map();
  const tools = new Map();
  const ctx = {
    tools: { register: tool => { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    systemPrompt: { context: () => () => {} },
    on: (name, handler) => { handlers.set(name, handler); return () => handlers.delete(name); },
    get: () => undefined,
  };
  const store = { search: async () => ({ results: [] }), status: async () => ({ success: true }), readSource: async () => ({ success: true }) };
  const config = { ...resolveConfig({ root: path.resolve(temp), allowedSessionIds: [] }), trustedSessionsFile: file };
  const stop = mountWiki(ctx, config, store);
  t.after(() => stop());
  const agent = { session: { id: 'session-future' } };
  const message = { id: 'm', role: 'user', source: { kind: 'user', rpcId: 'r' }, content: [{ type: 'text', text: 'hello' }] };
  const step = turn => handlers.get('agent/pre-step')({ agent, turn, messages: [message], signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [message] }));
  const status = async () => JSON.parse(await tools.get('wiki_status').execute({}, { agent }));
  await step(1);
  assert.deepEqual(await status(), { error: 'Wiki access unavailable' });
  await updateTrustedSessions(file, 'add', agent.session.id);
  await step(2);
  assert.deepEqual(await status(), { success: true });
  await updateTrustedSessions(file, 'remove', agent.session.id);
  assert.deepEqual(await status(), { error: 'Wiki access unavailable' });
});
