/**
 * #131 — operator tool: record a correction to one source snapshot and propagate it.
 *
 *   pnpm exec tsx scripts/substrate/correct-source.ts --source <key> --action corrected|revoked --reason "<why>" [--apply]
 *
 * Without `--apply` it runs inside a transaction that is rolled back and prints what WOULD change
 * (claims losing support, relations and bridges revoked). With `--apply` it commits. Corrections
 * are shared-knowledge operations: they are not an HTTP route and never run on behalf of a reader.
 */
import { pool } from '../../packages/db/src/index.ts';
import { correctSourceSnapshot } from '../../packages/db/src/semantic/corrections.ts';

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const input = { sourceKey: arg('--source'), action: arg('--action'), reason: arg('--reason') };
const apply = process.argv.includes('--apply');
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const receipt = await correctSourceSnapshot(client, input, 'operator');
  await client.query(apply ? 'COMMIT' : 'ROLLBACK');
  console.log(JSON.stringify({ applied: apply, ...receipt }, null, 2));
} catch (error) {
  await client.query('ROLLBACK');
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
