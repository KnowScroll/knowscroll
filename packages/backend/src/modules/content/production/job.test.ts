import { describe, expect, it, vi } from 'vitest';
import { madeToOrderKey } from '../domain/order-key.js';
import { makeRunScrollProduction, type ProduceScroll } from './job.js';
import { produceScrollJob } from './events.js';

const delivery = { signal: new AbortController().signal };
const orderKey = madeToOrderKey('0197a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b');

/** A producer that fails the test if it is ever asked to produce: the job under test must end before it. */
const neverProduces = () => vi.fn<ProduceScroll>(() => Promise.reject(new Error('CI: nothing may be produced')));

describe('the production job and the made-to-order switch (D-436)', () => {
  it('ends a job for an order placed from code as skipped, without producing, while the switch is off', async () => {
    const produce = neverProduces();
    const run = makeRunScrollProduction(produce, { madeToOrderEnabled: false });
    expect(await run(produceScrollJob(orderKey), delivery)).toEqual({ kind: 'skipped', reason: 'made_to_order_off' });
    expect(produce).not.toHaveBeenCalled();
  });

  it('ends every job of the answer queue as skipped while the switch is off, whatever its recipe key is', async () => {
    const produce = neverProduces();
    const run = makeRunScrollProduction(produce, { madeToOrderEnabled: false });
    expect(await run(produceScrollJob('exoplanet-kinds'), delivery, true)).toEqual({
      kind: 'skipped',
      reason: 'made_to_order_off',
    });
    expect(produce).not.toHaveBeenCalled();
  });

  it('still produces a library recipe while the switch is off', async () => {
    const produce = vi.fn<ProduceScroll>(() => Promise.resolve({ outcome: 'published' } as never));
    const run = makeRunScrollProduction(produce, { madeToOrderEnabled: false });
    expect(await run(produceScrollJob('exoplanet-kinds'), delivery)).toMatchObject({ kind: 'finished' });
    expect(produce).toHaveBeenCalledTimes(1);
  });

  it('produces an order, and anything on the answer queue, while the switch is on', async () => {
    const produce = vi.fn<ProduceScroll>(() => Promise.resolve({ outcome: 'published' } as never));
    const run = makeRunScrollProduction(produce, { madeToOrderEnabled: true });
    expect(await run(produceScrollJob(orderKey), delivery, true)).toMatchObject({ kind: 'finished' });
    expect(produce).toHaveBeenCalledWith(orderKey, false, delivery.signal, true, 1);
  });
});
