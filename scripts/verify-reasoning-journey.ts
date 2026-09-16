import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {dirname, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyReasoningJourney} from './reasoning-journey-verifier.ts';
const path = process.argv[2];
if (!path) throw new Error('Usage: verify-reasoning-journey.ts <J004 receipt path>');
const receipt = JSON.parse(await readFile(path, 'utf8'));
const result = verifyReasoningJourney(receipt);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assert.equal(receipt.source.revision, execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(),
  'fresh runtime receipt belongs to another source revision');
for (const file of receipt.source.files) {
  const target = resolve(root, file.path);
  assert.ok(target.startsWith(root + sep), 'source path escaped repository');
  assert.equal(createHash('sha256').update(await readFile(target)).digest('hex'), file.sha256, `source drift: ${file.path}`);
}
console.log(JSON.stringify({...result, sourceHashesMatch: true}));
