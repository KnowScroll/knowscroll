# modules/evidence

Owns: `evidence.action_events` (migration `0005_evidence_action_events`) — the explicit-action
channel of evidence. A Save is not a consumption encounter and never forms worlds on its own.

| Operation | Trigger | Authority, effects, redelivery |
|---|---|---|
| `applyActionEvidence(payload)` | queue `evidence.apply-action` (worker) | `system` actor for the payload's universe at the payload's epoch, rechecked under the personal lock (workers have no HTTP guard). One transaction: read the action (experience public) → insert the event keyed `(universe_id, action_id)` → advance the universe revision → `notifyScopeChanged`. A redelivery finds the key and does nothing (`already_applied`); work from an older epoch is skipped (`epoch_changed`). |

Queue policy (`events.ts`): expiry 60 s, 8 retries with backoff from 2 s, dead letter
`evidence.apply-action.dead`, retained 7 days queued / 2 days completed. Erasure: the table and the
queue's payloads per universe (`adapters/erasure.ts`).
