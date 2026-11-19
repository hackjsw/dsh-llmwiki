// Run with the installed DSH Electron, ELECTRON_RUN_AS_NODE=1, --expose-internals.
// Uses only synthetic facts in a separate temporary Wiki; sends no IM messages.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { runEngine, modelJson } from '../lib/engine.js';
import { WikiStore } from '../lib/wiki.js';
import assert from 'node:assert/strict';

const archive = path.join(path.dirname(process.execPath), 'resources/app.asar/dsh/node_modules/@deepseek-ai');
const load = name => import(pathToFileURL(path.join(archive, name, 'lib/index.js')).href);
const [{ Context }, llm, adapter, boot] = await Promise.all(['cordis', 'dsh-llm', 'dsh-llm-pi-ai', 'dsh-app-boot'].map(load));
const home = process.env.DSH_HOME;
assert.ok(home && path.isAbsolute(home));
const rows = yaml.load(await fs.readFile(path.join(home, 'profiles/desktop/cordis.patch.yml'), 'utf8'));
const providerConfig = rows.find(r => r.id === 'llm-pi-ai').config;
const route = rows.find(r => r.id === 'agent-default-model').config;
const ctx = new Context();
boot.loadLayeredEnv('dsh');
const fibers = [];
const tempBase = await fs.realpath(os.tmpdir());
const directory = await fs.mkdtemp(path.join(tempBase, 'dsh-wiki-real-model-'));
const config = { root: path.join(directory, 'wiki'), profile: 'default', pythonExecutable: process.env.DSH_TEST_PYTHON || 'python' };
try {
  for (const [plugin, options] of [[llm.default, {}], [adapter, providerConfig]]) {
    const fiber = ctx.plugin(plugin, options); fibers.push(fiber); await fiber.await(); assert.equal(fiber.state, 2);
  }
  for (const folder of ['inbox', 'entities', 'concepts']) await fs.mkdir(path.join(config.root, folder), { recursive: true });
  await fs.writeFile(path.join(config.root, 'index.md'), '# Index\n');
  await fs.writeFile(path.join(config.root, 'log.md'), '# Log\n');
  let calls = 0;
  const options = { authorize: () => true, signal: AbortSignal.timeout(180000), complete: request => { calls++; return modelJson(ctx, route, request); } };
  const extracted = await runEngine(config, 'extract', { entries: [{ kind: 'turn', user: '我的测试项目叫紫鸢试验。这个项目长期约定：所有技术说明必须用简体中文，并包含一段具体示例。', assistant: '已了解项目的文档约定。' }], provenance: { platform: 'dsh', session_id: 'synthetic-acceptance' } }, options);
  assert.ok(extracted.candidates.length > 0, 'real model did not extract the explicit stable fact');
  const consolidated = await runEngine(config, 'consolidate', { candidateIds: extracted.candidates.map(c => c.candidate_id) }, options);
  assert.ok(consolidated.outcomes.some(o => o.result === 'applied'), 'real model did not apply any canonical fact');
  const wiki = new WikiStore({ root: config.root, profile: 'default' });
  const recalled = await wiki.search('紫鸢试验 技术说明 简体中文', { recall: true });
  assert.ok(recalled.results.length > 0, 'canonical fact was not recalled');
  console.log(JSON.stringify({ ok: true, provider: route.provider, model: route.model, calls,
    extracted: extracted.candidates.length, outcomes: consolidated.outcomes.map(o => ({ op: o.op, result: o.result })), recalled: recalled.results.length }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error.code || error.name, message: /^[a-z-]+$/.test(error.message) ? error.message : 'acceptance-failed' }));
  process.exitCode = 1;
} finally {
  for (const fiber of fibers.reverse()) await fiber.dispose();
  assert.equal(path.dirname(directory), tempBase);
  assert.ok(path.basename(directory).startsWith('dsh-wiki-real-model-'));
  await fs.rm(directory, { recursive: true, force: true });
}
