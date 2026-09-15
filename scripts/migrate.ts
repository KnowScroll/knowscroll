import { resolve } from 'node:path';
import { pool } from '../packages/db/src/index.ts';
import { runMigrations } from '../packages/db/src/migrations.ts';

try {
  const result = await runMigrations(pool, { directory: resolve('packages/db/migrations') });
  for (const name of result.adopted) console.log(`Adopted checksum for ${name}`);
  for (const name of result.applied) console.log(`Applied ${name}`);
} finally {
  await pool.end();
}
