import { describe, expect, it, vi } from 'vitest';
import { madeToOrderKey } from '../../content/public.js';
import type { BranchPoolStore } from './ports.js';
import { makeResolveBranches } from './resolve.js';

const NODE = '0199a000-0000-7000-8000-000000000001';
const NOW = new Date('2026-11-23T12:00:00.000Z');

/** A preparing branch whose first take was rejected, so the resolver would normally send the next one. */
function world(madeToOrderEnabled: boolean) {
  const sent: [string, number][] = [];
  const settle = vi.fn(() => Promise.resolve(undefined));
  const store = {
    preparing: () => Promise.resolve([{ nodeId: NODE, threadId: 't1', createdAt: new Date(NOW.getTime() - 60_000) }]),
    answersMaking: () => Promise.resolve([]),
    settle,
  } as unknown as BranchPoolStore;
  const resolve = makeResolveBranches({
    store,
    readProduction: () => Promise.resolve({ state: 'queued', take: 2 } as never),
    sendProduction: (recipe, take) => {
      sent.push([recipe, take]);
      return Promise.resolve();
    },
    announce: () => Promise.resolve(),
    madeToOrderEnabled,
    now: () => NOW,
  });
  return { resolve, sent, settle };
}

describe('the branch resolver and the made-to-order switch (D-436)', () => {
  it('sends the next take of a branch while the switch is on', async () => {
    const w = world(true);
    expect(await w.resolve()).toMatchObject({ sent: 1 });
    expect(w.sent).toEqual([[madeToOrderKey(NODE), 2]]);
  });

  it('sends no production job for a branch while the switch is off, and settles nothing early', async () => {
    const w = world(false);
    expect(await w.resolve()).toEqual({ bound: 0, failed: 0, sent: 0, answersEnded: 0 });
    expect(w.sent).toEqual([]);
    expect(w.settle).not.toHaveBeenCalled();
  });
});
