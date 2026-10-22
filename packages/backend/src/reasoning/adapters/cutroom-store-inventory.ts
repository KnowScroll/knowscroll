/** Closed world-owned Cutroom inventory. Runtime accepts only public commissioning
 * provenance, no account/universe context. CI checks actual ownership closure and both
 * erasers against populated rows. Full/selective personal erasers never release money. */
export const reasoningCutroomStores = [
  { table: 'reasoning.cutroom_scopes', retention: 'world admission generation; explicit operator lifecycle' },
  { table: 'reasoning.cutroom_attempts', retention: 'immutable tuple/financial liability and monotonic attempt state' },
  { table: 'reasoning.cutroom_requests', retention: 'protected public request bytes; existing expiry purge' },
  { table: 'reasoning.cutroom_pool_operations', retention: 'immutable exact claim/release intentions and receipts' },
  { table: 'reasoning.cutroom_execution', retention: 'immutable one POST intent and finite GET deadline' },
  { table: 'reasoning.cutroom_observations', retention: 'bounded sanitized immutable evidence digests' },
  {
    table: 'reasoning.cutroom_accounting_intents',
    retention: 'immutable pending accounting receipts; pg-boss only outbox',
  },
  { table: 'reasoning.cutroom_maintenance', retention: 'finite delivery/recovery bookkeeping; retained after stop' },
  {
    table: 'reasoning.cutroom_financial_reports',
    retention: '32 snapshot-bound immutable exact reports per attempt; monotonic hold receipt',
  },
  {
    table: 'reasoning.cutroom_settlements',
    retention: 'one immutable admitted-publication settlement command per attempt',
  },
  { table: 'reasoning.cutroom_settlement_receipts', retention: 'immutable verified pool settlement receipt' },
] as const;
export const reasoningCutroomNonRowStores = [
  { name: 'pgboss/reasoning.cutroom-pool', retention: 'IDs only; declared24h completed/terminal policy' },
  { name: 'pgboss/reasoning.cutroom-follow', retention: 'IDs only; declared24h completed/terminal policy' },
  { name: 'pgboss/reasoning.cutroom-accounting', retention: 'IDs only; declared24h completed/terminal policy' },
  {
    name: 'pgboss/reasoning.settle-cutroom',
    retention: 'IDs only; declared24h terminal and bounded dead-letter policy',
  },
  {
    name: 'pgboss/reasoning.recover-cutroom',
    retention: 'version/global UUID cursor only; finite pass; declared retention',
  },
] as const;
