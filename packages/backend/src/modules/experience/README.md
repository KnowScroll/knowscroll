# modules/experience

Owns: `experience.saved_items`, `experience.actions` (migration `0004_experience_actions`) and
`experience.exposures` (migration `0011_experience_exposures`).

| Operation | Route | Authority, effects, failure |
|---|---|---|
| `applyAction(authority, {commandId, kind, target})` | `POST /v1/actions` | Caller's account + universe at its privacy epoch, rechecked under the personal lock. One transaction: receipt lookup (replay / `COMMAND_KEY_REUSED` for a reused key, a receipt from before a privacy reset or a retired outcome shape / 503 for a receipt written by a newer release) → asset admitted at `assetRevision` (`ASSET_NOT_FOUND` 404 / `ASSET_REVISION_STALE` 409) → receipt → saved-state change (`decideActionEffect`) → action row → `evidence.apply-action` job → if the saved state changed, universe revision advanced and notified (the command's own watermark, returned as `revision`; a no-op save returns the current revision and notifies nothing) → outcome. All or nothing; refusals write nothing. |
| `listSaved(authority, limit)` | `GET /v1/saved` | Rechecks the universe (no lock) and reads ≤ 100 items newest first, with the universe revision they were read at. |
| `openExposure(authority, {commandId, target: {kind: 'scroll', assetId}, origin, capabilities})` | `POST /v1/experience/open` | Opens an admitted Scroll: creates the **exposure**, the lineage root of one encounter (exposure ID, the asset's current revision, origin, and the capabilities the client declared). One transaction under the personal lock with a command receipt (D-016): identical replay returns the stored outcome (`replayed: true`); another request under the key → `COMMAND_KEY_REUSED` (422); an asset that is missing, withdrawn, not a Scroll or without a stored revision → `ASSET_NOT_FOUND` (404) with **no** receipt (retryable). Opening is not consumption. |
| `activateExposure(authority, {commandId, exposureId})` | `POST /v1/experience/activate` | The article became the active reading surface. Under the lock, with a receipt: sets `activated_at` once (`decideActivation`: an active exposure keeps its original time, whatever command asks); an unknown or another person's exposure → `NOT_FOUND` (indistinguishable). Observations are accepted only for an activated exposure. |
| `readExposureDocument(authority, exposureId)` | `GET /v1/experience/exposures/{id}/document` | Rechecks the universe (no lock), reads the exposure, and asks content to render its immutable revision for the capabilities it declared (`degradedEssential` lists essential blocks shown only as fallback text). Only the consumer document: never provenance. `UNPROCESSABLE_REQUEST` when the declared capabilities cannot render it at all. |
| `ReadActionForEvidence`, `ReadExposureForEvidence` (tokens `READ_ACTION_FOR_EVIDENCE`, `READ_EXPOSURE_FOR_EVIDENCE`) | evidence | Read ports inside the evidence use case's own locked scope: one action; one exposure's lineage (revision, activation time, epoch). |

Domain rules (`domain/`, tested): Save/Unsave results depend only on the current state and the
action (`actions.ts`); activation is idempotent and never moves (`exposures.ts`).

Jobs: enqueues `evidence.apply-action` (payload `{v, universeId, privacyEpoch, actionId}`). Open and
activate enqueue nothing and send no hint: they change nothing a client reads (the evidence commit
does, later). Lock order: personal root only. Erasure: `saved_items`, `actions` and `exposures` per
universe (`adapters/erasure.ts`); saved items survive "clear exploration history" (blueprint §19), and
exposures do not (they root encounter evidence).

Worked operation: `POST /v1/actions {commandId C, kind: save, target: {assetId A, assetRevision 1}}`
→ 200 `{saved: true, changed: true, replayed: false, actionId X}`; the same request again → the
same body with `replayed: true` and no new rows or jobs; `kind: unsave` with C → 422.
`POST /v1/experience/open {commandId O, target: {kind: 'scroll', assetId S}, origin: {kind: 'direct'},
capabilities}` → 200 `{exposureId E, assetRevision 1, replayed: false}`; again → the same with
`replayed: true`; `GET …/exposures/E/document` → the negotiated document; `POST …/activate {commandId
V, exposureId E}` → `{activatedAt}`.

S2.4 adds `target.kind: reel` to the existing open/activate lineage. Opening and grant renewal create no
consumption evidence; an exposure remains bound to its immutable admitted revision. Scroll document
rendering stays Scroll-only. The separate media read port checks Reel exposure ownership/current epoch
and admitted revision on every grant and byte-range request.
