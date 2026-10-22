/** Closed shared-public inventory. These rows have no account/universe dependency and
 * survive BOTH personal erasers. They are not personal registry exemptions by name:
 * CI checks actual columns/transitive FKs and populated full/selective preservation.
 * Script/source/corpus provenance is immutable; no client or encounter evidence is stored. */
export const contentCutroomStores = [
  {
    table: 'content.cutroom_receiving_state',
    owner: 'target world',
    retention: 'independent default-disabled receiving root; no personal or financial authority',
  },
  {
    table: 'content.cutroom_receive_receipts',
    owner: 'target world/origin publication/handoff',
    retention:
      'immutable public handoff/admission receipt and finite delivery metadata; hard30day admission deadline never renews',
  },
  {
    table: 'content.reel_commissions',
    owner: 'world/business',
    retention: 'immutable public business; protected bytes remain in Reasoning',
  },
  { table: 'content.cutroom_corpus', owner: 'shared corpus', retention: 'immutable all-status source metadata' },
  {
    table: 'content.cutroom_reviews',
    owner: 'world/business',
    retention: 'immutable reviewed public script/corpus, revocation marker retained',
  },
  {
    table: 'content.cutroom_chain_snapshots',
    owner: 'world/business/attempt',
    retention: '32 immutable sanitized headers per attempt',
  },
  {
    table: 'content.cutroom_chain_documents',
    owner: 'snapshot',
    retention: '4 or8 bounded sanitized documents per header',
  },
  {
    table: 'content.cutroom_publications',
    owner: 'world/business/attempt',
    retention: 'immutable publication/asset/media provenance',
  },
] as const;
/** Public media is content-addressed shared output, never personal voice/images/input. */
export const contentCutroomNonRowStores = [
  {
    name: 'media/received-reel',
    owner: 'shared asset',
    retention: 'target-owned content-addressed public bytes; personal erasure preserves',
  },
  {
    name: 'staging/received-reel',
    owner: 'target shared staging',
    retention:
      'Root-transferred immutable input; temporary failed copies discarded, originals/unreferenced installed public bytes require explicit operator cleanup; no GC shipped',
  },
  {
    name: 'pgboss/receiving',
    owner: 'target world/handoff',
    retention:
      'fixed IDs-only receiving/recovery payloads; queue retention only, never a financial or personal work outbox',
  },
  {
    name: 'media/commissioned-reel',
    owner: 'shared asset',
    retention: 'committed public media lifecycle; personal erasure preserves',
  },
  {
    name: 'staging/commissioned-reel',
    owner: 'shared staging',
    retention:
      'failed staging removed; already committed unreferenced shared bytes retained for explicit operator cleanup; no GC shipped',
  },
] as const;
