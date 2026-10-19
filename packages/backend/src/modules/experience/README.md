# modules/experience

Owns: `experience.saved_items`, `experience.actions` (migration `0004_experience_actions`).

| Operation | Route | Authority, effects, failure |
|---|---|---|
| `applyAction(authority, {commandId, kind, target})` | `POST /v1/actions` | Caller's account + universe at its privacy epoch, rechecked under the personal lock. One transaction: receipt lookup (replay/`COMMAND_KEY_REUSED`) → asset admitted at `assetRevision` (`ASSET_NOT_FOUND` 404 / `ASSET_REVISION_STALE` 409) → receipt → saved-state change (`decideActionEffect`) → action row → `evidence.apply-action` job → outcome. All or nothing; refusals write nothing. |
| `listSaved(authority, limit)` | `GET /v1/saved` | Rechecks the universe (no lock) and reads ≤ 100 items newest first, with the universe revision they were read at. |
| `readActionForEvidence(scope, actionId)` | — | Public read for the evidence job, inside the job's own locked scope. |

Domain rule (`domain/actions.ts`, property-tested): Save/Unsave results depend only on the current
state and the action; repeating an action is an accepted no-op (`changed: false`). Every accepted
action is recorded and sent to evidence, changed or not.

Jobs: enqueues `evidence.apply-action` (payload `{v, universeId, privacyEpoch, actionId}`).
Lock order: personal root only. Erasure: both tables per universe (`adapters/erasure.ts`). Saved
items survive "clear exploration history" (blueprint §19).

Worked operation: `POST /v1/actions {commandId C, kind: save, target: {assetId A, assetRevision 1}}`
→ 200 `{saved: true, changed: true, replayed: false, actionId X}`; the same request again → the
same body with `replayed: true` and no new rows or jobs; `kind: unsave` with C → 422.
