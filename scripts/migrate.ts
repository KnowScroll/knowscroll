import { resolve } from 'node:path';
import { pool } from '@knowscroll/db';
import { runMigrations } from '@knowscroll/db/migrations';

try {
  const result = await runMigrations(pool, {
    directory: resolve('packages/db/migrations'),
  });
  for (const name of result.adopted)
    console.log(`Adopted checksum for ${name}`);
  for (const name of result.applied) console.log(`Applied ${name}`);
} finally {
  await pool.end();
}
