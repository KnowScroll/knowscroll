/** #199: applies the shared Reel pool's own migrations (`packages/db/pool-migrations/`) to the
 * database at `KS_POOL_DATABASE_URL` (`knowscroll_pool` on the server). Separate from every
 * world's database, so a world's reset never touches it. */
import {
  createPoolLedger,
  runPoolMigrations,
} from '@knowscroll/db/pool/ledger';
import pg from 'pg';

const url = process.env.KS_POOL_DATABASE_URL;
if (!url) throw new Error('KS_POOL_DATABASE_URL is required');
const db = new pg.Pool({ connectionString: url, max: 1 });
try {
  const result = await runPoolMigrations(db);
  for (const name of result.applied) console.log(`Applied ${name}`);
  const budget = await createPoolLedger(db).budget();
  console.log(
    `Shared pool: ${budget.committedCents} of ${budget.capCents} cents committed`,
  );
} finally {
  await db.end();
}
