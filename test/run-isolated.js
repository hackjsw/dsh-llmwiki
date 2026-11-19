import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Start a fresh process before importing any plugin or test module. Inherited
// production DSH_HOME and model credentials must never reach the test suite.
const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const base = await fs.realpath(os.tmpdir());
const temp = await fs.mkdtemp(path.join(base, 'dsh-wiki-test-env-'));
const assertTemporary = () => {
  assert.equal(path.dirname(temp), base);
  assert.ok(path.basename(temp).startsWith('dsh-wiki-test-env-'));
};
assertTemporary();
const env = {
  DSH_HOME: path.join(temp, 'home'),
  HOME: temp, USERPROFILE: temp, TEMP: temp, TMP: temp, TMPDIR: temp,
};
for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT',
  'DSH_TEST_ELECTRON', 'DSH_TEST_PLUGIN_PROJECT', 'DSH_TEST_LOOP_REGISTRY', 'DSH_TEST_PYTHON']) {
  if (process.env[key]) env[key] = process.env[key];
}
try {
  const supplied = process.argv.slice(2);
  const engine = supplied[0] === '--engine';
  const tests = engine ? ['test/engine_test.py'] : supplied.length ? supplied
    : (await fs.readdir(path.join(project, 'test'))).filter(name => name.endsWith('.test.js')).sort().map(name => `test/${name}`);
  const command = engine ? (env.DSH_TEST_PYTHON || 'python') : process.execPath;
  const args = engine ? tests : ['--test', ...tests];
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: project, env, windowsHide: true, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', code => resolve(code ?? 1));
  });
} finally {
  assertTemporary();
  await fs.rm(temp, { recursive: true, force: true });
}
