import * as fs from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readTrustedSessions, validSessionId } from '../lib/trust.js';

/** Owner-run local configuration command. Unknown/invalid files are never overwritten. */
export async function updateTrustedSessions(file, action, sessionId) {
  if (!path.isAbsolute(file) || !validSessionId(sessionId) || !['add', 'remove'].includes(action)) {
    throw new Error('invalid trusted-session request');
  }
  const parent = path.dirname(file);
  const realParent = await fs.realpath(parent);
  const comparable = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (comparable(parent) !== comparable(realParent)) throw new Error('trusted-session directory contains a link');
  const lock = `${file}.lock`;
  const temp = path.join(parent, `.trusted-sessions-${randomUUID()}.tmp`);
  let lockHandle;
  let tempCreated = false;
  try {
    lockHandle = await fs.open(lock, 'wx', 0o600);
    let initial;
    try {
      const info = await fs.lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new Error('invalid trusted-session file');
      initial = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(initial);
      if (!parsed || !Array.isArray(parsed.sessions) || parsed.sessions.length > 1000 ||
          parsed.sessions.some(value => !validSessionId(value))) throw new Error('invalid trusted-session file');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      initial = undefined;
    }
    const current = initial === undefined ? [] : readTrustedSessions(file);
    if (initial !== undefined && current.length === 0 && JSON.parse(initial).sessions.length !== 0) throw new Error('trusted-session file is not safely readable');
    const sessions = new Set(current);
    if (action === 'add') sessions.add(sessionId); else sessions.delete(sessionId);
    if (sessions.size > 1000) throw new Error('too many trusted sessions');
    const value = `${JSON.stringify({ sessions: [...sessions].sort() }, null, 2)}\n`;
    const handle = await fs.open(temp, 'wx', 0o600);
    tempCreated = true;
    try { await handle.writeFile(value, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    let latest;
    try { latest = await fs.readFile(file, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (latest !== initial) throw new Error('trusted-session file changed; retry after inspection');
    await fs.rename(temp, file);
    tempCreated = false;
    return { sessionId, trusted: sessions.has(sessionId), count: sessions.size };
  } finally {
    if (tempCreated) await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (lockHandle) {
      await lockHandle.close();
      await fs.unlink(lock);
    }
  }
}

async function main() {
  const action = process.argv[2];
  const sessionId = process.argv[3] || process.env.DSH_SESSION_ID;
  const home = process.env.DSH_HOME || path.join(homedir(), '.dsh');
  const file = path.resolve(home, 'llm-wiki', 'trusted-sessions.json');
  if (action === 'status') {
    if (!validSessionId(sessionId)) throw new Error('DSH_SESSION_ID is unavailable');
    console.log(JSON.stringify({ sessionId, trustedByFile: readTrustedSessions(file).includes(sessionId) }));
    return;
  }
  const result = await updateTrustedSessions(file, action, sessionId);
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`trusted-session update failed: ${error.message}`); process.exitCode = 1; });
}
