import path from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { MemoryStore } from '../lib/memory.js';

const parsed = parseArgs({ allowPositionals: true, strict: true, options: {
  reviewed: { type: 'boolean', default: false },
  root: { type: 'string' },
  profile: { type: 'string', default: 'default' },
} });
if (parsed.positionals.length !== 1) {
  throw new Error('usage: node scripts/recover-memory.js OPERATION_ID [--reviewed] [--root ABSOLUTE_WIKI_ROOT] [--profile PROFILE]');
}
const home = process.env.DSH_HOME || path.join(homedir(), '.dsh');
const root = parsed.values.root || path.resolve(home, 'llm-wiki', 'wiki');
if (!path.isAbsolute(root)) throw new Error('Wiki root must be absolute');
const store = new MemoryStore({ root, profile: parsed.values.profile });
const result = await store.recover(parsed.positionals[0], {
  // This command is owner-run; the invoking shell still enforces its own DSH sandbox.
  authorize: () => true,
  reviewed: parsed.values.reviewed,
});
console.log(JSON.stringify(result));
if (result.status !== 'committed') process.exitCode = 1;
