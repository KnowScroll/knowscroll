/** A disposable pool database only: no live pool, provider or billing. */
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestPool, type TestPool } from './support/reel-world.js';

let pool: TestPool;
beforeEach(async () => {
  pool = await createTestPool();
});
afterEach(async () => {
  await pool.drop();
});

/** Claims as a world does, through the pool's own function. */
async function claim(cents: number) {
  const digest = randomBytes(32).toString('hex');
  const requestId = `ks-reel-${digest.slice(0, 32)}-1`;
  const { rows } = await pool.client.query<{ status: string }>(
    'select status from pool_claim($1,$2,1,$3,$4,$5,$6,$7)',
    [requestId, digest, 'video', randomBytes(32).toString('hex'), 'dev', cents, 'fixture'],
  );
  return { status: rows[0]!.status, requestId };
}

describe('the 400-cent allowance for new Reels (pool migration 0005)', () => {
  it('raises the cap from 700 to 617 settled plus 400 and keeps the cap rule', async () => {
    await pool.seedSettled(617);
    expect(await pool.budget()).toEqual({ cap_cents: 700, committed_cents: 617, left_cents: 83 });
    await pool.raiseCap();
    expect(await pool.budget()).toEqual({ cap_cents: 1017, committed_cents: 617, left_cents: 400 });

    // Open ceilings count in full, so five 75-cent orders leave room for exactly 25 more cents.
    for (let order = 0; order < 5; order++) expect((await claim(75)).status).toBe('claimed');
    expect((await pool.budget()).left_cents).toBe(25);
    expect((await claim(26)).status).toBe('cap_exceeded');
    expect((await claim(25)).status).toBe('claimed');
    expect((await pool.budget()).left_cents).toBe(0);
    expect((await claim(1)).status).toBe('cap_exceeded');
  });

  it('gives room back when an order settles below its ceiling, and records an overshoot as it was', async () => {
    await pool.seedSettled(617);
    await pool.raiseCap();
    const first = await claim(75);
    await pool.client.query('select pool_settle($1,$2,$3,$4,$5)', [first.requestId, 'dev', 'stopped', 52, null]);
    expect((await pool.budget()).committed_cents).toBe(617 + 52);
    const second = await claim(40);
    await pool.client.query('select pool_settle($1,$2,$3,$4,$5)', [second.requestId, 'dev', 'stopped', 47, null]);
    expect((await pool.budget()).committed_cents).toBe(617 + 52 + 47);
  });

  it('settles once: the same figures again are a no-op and other figures are refused', async () => {
    await pool.raiseCap();
    const order = await claim(75);
    const settle = (cents: number) =>
      pool.client.query<{ result: string }>('select pool_settle($1,$2,$3,$4,$5) as result', [
        order.requestId,
        'dev',
        'stopped',
        cents,
        null,
      ]);
    expect((await settle(60)).rows[0]!.result).toBe('settled');
    expect((await settle(60)).rows[0]!.result).toBe('already_settled');
    await expect(settle(61)).rejects.toThrow('pool_order_settled_differently');
    // Only the ordering world settles.
    const other = await claim(10);
    await expect(
      pool.client.query('select pool_settle($1,$2,$3,$4,$5)', [other.requestId, 'stage', 'stopped', 1, null]),
    ).rejects.toThrow('pool_order_not_yours');
  });

  it('refuses a pool that is not in the state the owner approved', async () => {
    await pool.seedSettled(618);
    await expect(pool.raiseCap()).rejects.toThrow('More than the 617 cents');
    expect((await pool.budget()).cap_cents).toBe(700);
    await pool.drop();
    pool = await createTestPool();
    await pool.raiseCap();
    await expect(pool.raiseCap()).rejects.toThrow('not the 700 cents');
  });
});

describe('the runbook step that applies 0005 and records it', () => {
  it('names the SHA-256 of the migration file as it is, so the recorded row matches the file', async () => {
    const root = new URL('../../', import.meta.url);
    const file = await readFile(new URL('ops/pool/migrations/0005_cap_four_dollars_more.sql', root));
    const sha256 = createHash('sha256').update(file).digest('hex');
    const runbook = await readFile(new URL('docs/v2/operations/cutroom-and-spend.md', root), 'utf8');
    expect(runbook).toContain(`'0005_cap_four_dollars_more.sql', '${sha256}'`);
  });

  it('applies and records in one transaction: a refusal leaves neither the cap nor a tracker row changed', async () => {
    const root = new URL('../../', import.meta.url);
    const text = (name: string) => readFile(new URL(`ops/pool/migrations/${name}`, root), 'utf8');
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    // The tracker as the v1 migrator left it: one row per applied file, the hash of its text.
    await pool.client.query(
      'create table schema_migrations (filename text primary key, sha256 text not null, applied_at timestamptz not null default now())',
    );
    for (const name of ['0001_shared_pool.sql', '0002_cap_seven_dollars.sql'])
      await pool.client.query('insert into schema_migrations (filename, sha256) values ($1, $2)', [
        name,
        hash(await text(name)),
      ]);

    const name = '0005_cap_four_dollars_more.sql';
    const migration = await text(name);
    const record = `INSERT INTO schema_migrations (filename, sha256) VALUES ('${name}', '${hash(migration)}');`;
    const tracked = async () =>
      (await pool.client.query<{ filename: string }>('select filename from schema_migrations order by 1')).rows.map(
        (row) => row.filename,
      );

    await pool.seedSettled(618);
    await expect(pool.client.query(`${migration}\n${record}\n`)).rejects.toThrow('More than the 617 cents');
    expect(await tracked()).toEqual(['0001_shared_pool.sql', '0002_cap_seven_dollars.sql']);
    expect((await pool.budget()).cap_cents).toBe(700);

    await pool.drop();
    pool = await createTestPool();
    await pool.client.query(
      'create table schema_migrations (filename text primary key, sha256 text not null, applied_at timestamptz not null default now())',
    );
    await pool.seedSettled(617);
    await pool.client.query(`${migration}\n${record}\n`);
    expect(await tracked()).toEqual([name]);
    expect((await pool.budget()).cap_cents).toBe(1017);
  });
});
