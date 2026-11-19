import * as fs from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';

const home = process.env.DSH_HOME || path.join(homedir(), '.dsh');
const directory = path.join(home, 'llm-wiki', 'conversation-pending');
let names;
try { names = await fs.readdir(directory); }
catch (error) { if (error.code === 'ENOENT') names = []; else throw error; }
const result = { pending: 0, errors: {}, inaccessible: 0 };
for (const [key, file] of [['runtime', 'memory-runtime.json'], ['processing', 'memory-state.json']]) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(home, 'llm-wiki', file), 'utf8'));
    result[key] = key === 'runtime' ? value : { startedAt: value.startedAt, lastCompletedAt: value.lastCompletedAt,
      lastMaintenanceAt: value.lastMaintenanceAt, digest: value.maintenance?.digest, scanError: value.scanError, maintenanceError: value.maintenanceError };
  } catch (e) { if (e.code !== 'ENOENT') result[key] = { error: 'unreadable' }; }
}
for (const name of names.filter(value => /^[a-f0-9]{64}\.json$/.test(value))) {
  result.pending++;
  try {
    const job = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
    const code = typeof job.lastError === 'string' && /^[a-zA-Z-]+$/.test(job.lastError) ? job.lastError : 'waiting';
    result.errors[code] = (result.errors[code] ?? 0) + 1;
  } catch { result.inaccessible++; }
}
console.log(JSON.stringify(result, null, 2));
