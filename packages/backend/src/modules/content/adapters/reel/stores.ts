/**
 * Shared-public Reel records. None of them references an account, a universe or a person, so both
 * personal erasers leave them alone; CI checks the real schema for any such link (`erasure.test.ts`).
 */
export const contentReelStores = [
  {
    table: 'content.reel_orders',
    owner: 'content',
    retention: 'one business run per script content; kept with the Reel it made',
  },
  {
    table: 'content.reel_attempts',
    owner: 'content',
    retention: 'immutable ledger of what was asked of Cutroom and what it cost; kept as spend history',
  },
  {
    table: 'content.reel_imports',
    owner: 'content',
    retention: 'which Cutroom run became which Reel; kept with the Reel',
  },
] as const;
