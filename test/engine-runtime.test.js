import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runEngine, safeEngineDiagnostic } from '../lib/engine.js';

const pythonExecutable = process.env.DSH_TEST_PYTHON || 'python';
const privateText = 'private-source sk-synthetic1234567890 C:/private/source.txt';
async function worker(t, body) {
  const base = await fs.realpath(os.tmpdir());
  const dir = await fs.mkdtemp(path.join(base, 'dsh-wiki-engine-'));
  t.after(async () => {
    assert.equal(path.dirname(dir), base);
    assert.ok(path.basename(dir).startsWith('dsh-wiki-engine-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  for (const folder of ['lib', 'engine']) await fs.mkdir(path.join(dir, folder));
  await fs.copyFile(new URL('../lib/engine.js', import.meta.url), path.join(dir, 'lib/engine.mjs'));
  await fs.writeFile(path.join(dir, 'engine/bridge.py'), `import sys, json\nsys.stdin.readline()\n${body}\n`);
  const engine = await import(pathToFileURL(path.join(dir, 'lib/engine.mjs')));
  return options => engine.runEngine({ root: dir, profile: 'test', pythonExecutable }, 'test', {}, options);
}
function check(error, code, reason) {
  assert.equal(error.message, code);
  assert.equal(error.engineDiagnostic.reason, reason);
  assert.ok(!JSON.stringify(error).includes(privateText));
  assert.equal(error.cause, undefined);
  return true;
}

test('spawn failures retain the stable error and a path-free launch code', async () => {
  await assert.rejects(runEngine({ pythonExecutable: path.join(os.tmpdir(), 'dsh-wiki-nonexistent-python') }, 'status'), error => {
    check(error, 'engine-unavailable', 'spawn-error');
    assert.equal(error.engineDiagnostic.spawnCode, 'ENOENT');
    assert.deepEqual(Object.keys(error.engineDiagnostic).sort(), ['exitCode', 'reason', 'spawnCode', 'stderrBytes']);
    return true;
  });
});

test('nonzero exit retains only Python exception class and process metadata', async t => {
  const run = await worker(t, `sys.stderr.write(${JSON.stringify('ModuleNotFoundError: ' + privateText + '\n')})\nsys.exit(7)`);
  await assert.rejects(run(), error => {
    check(error, 'engine-unavailable', 'worker-exit');
    assert.equal(error.engineDiagnostic.exitCode, 7);
    assert.equal(error.engineDiagnostic.pythonException, 'ModuleNotFoundError');
    assert.ok(error.engineDiagnostic.stderrBytes > 0);
    return true;
  });
});

test('clean exit without result is distinct from worker failure', async t => {
  const run = await worker(t, 'pass');
  await assert.rejects(run(), error => {
    check(error, 'engine-unavailable', 'missing-result');
    assert.equal(error.engineDiagnostic.exitCode, 0);
    return true;
  });
});

test('malformed protocol never exposes the offending line', async t => {
  const run = await worker(t, `print(${JSON.stringify(privateText)}, flush=True)`);
  await assert.rejects(run(), error => check(error, 'engine-unavailable', 'protocol-error'));
});

test('worker result errors keep known codes and reject arbitrary text', async t => {
  for (const [name, code] of [['ValueError', 'engine-ValueError'], [privateText, 'engine-failure']]) {
    const run = await worker(t, `print(json.dumps({'type':'result','ok':False,'error':${JSON.stringify(name)}}), flush=True)`);
    await assert.rejects(run(), error => check(error, code, 'worker-error'));
  }
});

test('host request errors retain safe codes and identify the failing request', async t => {
  const run = await worker(t, `print(json.dumps({'type':'llm'}), flush=True)\nsys.stdin.readline()\nprint(json.dumps({'type':'result','ok':False,'error':'WikiAccessError'}), flush=True)`);
  for (const message of [privateText, 'sensitive-provider-error', 'model-incomplete']) {
    await assert.rejects(run({ authorize: () => true, complete: () => { throw new Error(message); } }), error => {
      check(error, message === 'model-incomplete' ? message : 'engine-unavailable', 'host-request-failed');
      assert.equal(error.engineDiagnostic.requestType, 'llm');
      assert.equal(error.engineDiagnostic.exitCode, 0);
      return true;
    });
  }
  await assert.rejects(run({ authorize: () => false }), error => check(error, 'access-revoked', 'host-request-failed'));
});

test('timeout termination has its own diagnostic while keeping engine-unavailable', async t => {
  const run = await worker(t, `print(json.dumps({'type':'llm'}), flush=True)\nsys.stdin.readline()`);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await assert.rejects(run({ authorize: () => true, complete: () => { t.mock.timers.tick(600000); return {}; } }), error => check(error, 'engine-unavailable', 'timeout'));
});

test('diagnostic allowlist rejects arbitrary fields and forged exception names', () => {
  assert.deepEqual(safeEngineDiagnostic({ reason: 'worker-exit', exitCode: 1, stderrBytes: 20,
    pythonException: privateText, signal: privateText, spawnCode: privateText, requestType: privateText, stderr: privateText, cause: privateText }),
  { reason: 'worker-exit', exitCode: 1, stderrBytes: 20 });
  assert.equal(safeEngineDiagnostic({ reason: privateText }), undefined);
});
