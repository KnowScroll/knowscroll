/** A disposable pool database only: no live pool, provider or billing. */
import { randomBytes } from 'node:crypto';
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
