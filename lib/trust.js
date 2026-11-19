import fs from 'node:fs';
import path from 'node:path';

const VALID_SESSION = /^(?:session-)?[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const MAX_FILE_BYTES = 64 * 1024;

export function validSessionId(value) {
  return typeof value === 'string' && VALID_SESSION.test(value);
}

/** A separate owner-managed local file can grant a future session access. */
export function readTrustedSessions(file) {
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) return [];
    const parent = path.dirname(file);
    const realParent = fs.realpathSync(parent);
    const compare = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    if (compare(parent) !== compare(realParent)) return [];
    if (compare(fs.realpathSync(file)) !== compare(file)) return [];
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    let parsed;
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) return [];
      const bytes = Buffer.allocUnsafe(MAX_FILE_BYTES + 1);
      const read = fs.readSync(fd, bytes, 0, bytes.length, 0);
      if (read > MAX_FILE_BYTES) return [];
      const text = bytes.subarray(0, read).toString('utf8');
      const after = fs.fstatSync(fd);
      const named = fs.lstatSync(file);
      if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || named.dev !== opened.dev || named.ino !== opened.ino || named.isSymbolicLink()) return [];
      parsed = JSON.parse(text);
    } finally { fs.closeSync(fd); }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.sessions) || parsed.sessions.length > 1000 ||
        parsed.sessions.some(value => !validSessionId(value))) return [];
    return [...new Set(parsed.sessions)];
  } catch {
    return [];
  }
}
