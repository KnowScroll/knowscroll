# ADR-0023 — Generated Reel supply: bounded Cutroom jobs and verified media import

Date: 2026-09-20. Status: accepted by the coordinator for [#94](https://github.com/KnowScroll/knowscroll/issues/94)
under #9/#8/#72. Builds on [ADR-0005](0005-sql-jobs-and-external-deferred.md),
[ADR-0007](0007-cutroom-separate-http-service.md), [ADR-0012](0012-reasoning-admission-and-reconciliation.md),
[ADR-0020](0020-cutroom-http-client.md) and [ADR-0021](0021-cutroom-successor-pin-and-local-host.md).
First vertical slice of the [target supply flow](../architecture/target/23-CONTENT-DEMAND-AND-INVENTORY.md);
it does not implement ContentDemand waiters, reuse planning, publication or serving.

## Context

The v1 path is `intent → authorized bounded job → real Cutroom run → reconciliation → verified
import → gates → eligible inventory → playable Reel → continuation`. #89 proved the pinned client
against the real upstream service with stand-in providers. Observed contract facts that shape this
design: a refused submit creates no run; the same requestId and JSON-equal body replays the same run;
a lost acknowledgement is recoverable only by lookup on the original requestId; cancellation takes
effect only when the engine worker processes it, then the run finishes `cancelled`; results name
absolute engine-host paths that upstream promises to keep for no particular time; `costCents` counts
generation spend only and the record lists takes, not a certified all-attempt meter.

Owner decisions (2026-09-20): KnowScroll does not modify Cutroom; live spend is capped at **$2 total**
and allowed only after upstream Cutroom ships real providers. Product reasoning dispatch is disabled,
so no model may author narration at runtime.

## Decision

### 1. Scope of this slice: shared library supply from editorial briefs

A **GenerationBrief** is immutable, versioned editorial input over one existing sourced library
Scroll: world id, narration sentences with claim ids, claims with roles, typed criteria with a
depiction-policy version, style contract, and a claim→source map pointing only at that Scroll's
recorded source and revision. It is authored and reviewed outside the runtime (operator/coordinator,
`review_state` recorded); **no model writes it at runtime** and no private universe data may enter it.
The brief compiles deterministically into the strict Cutroom `SubmitRequest` — sources, claim text
and truth state never enter the request (reel-contract "what must not be sent"). The resulting Reel's
truth state is `synthesis` with an artifact-level generated label. User-initiated generation
(Journey C) is a later slice that needs authorized reasoning and private demand scope.

### 2. Engines, grants and provider mode

- `cutroom_engine` registers one loopback origin with explicit port, the pinned contract revision,
  the engine-host artifact root used for import containment, and a **declared provider mode**
  (`standin` | `live`) with who declared it and when. The contract cannot prove provider mode, so it is
  an operator declaration, cross-checked where the ops host reports it.
- `generation_budget_grant` holds a cap in integer cents with reserved, spent and **overage** totals.
  The cap binds what may be reserved, and admission also counts prior spend (database-enforced).
  Real spend is never clamped to a reservation (ADR-0012): a reported cost above a job's ceiling is
  settled and the excess recorded as `overage_cents`, which sets `admission_paused_at` so the grant
  admits nothing further until an operator resolves it, and the job is parked `needs_operator` with
  its asset already durably recorded. An overage never shrinks and a paused grant with an overage
  cannot be silently unpaused. It also holds a mode, an expiry and an authorization reference.
  A `live` grant requires a non-empty owner authorization reference and a `live` engine; with the
  current owner decision no live grant may exceed 200 cents in total across all live grants, and none
  may be created until the owner confirms upstream ships real providers. `standin` grants exercise the
  identical reservation protocol with a notional cap.

### 3. Job and attempt protocol (ADR-0012 pattern, applied to one Cutroom run)

- `generation_job`: brief, engine, grant, requested stage, `budget_cents` (the Cutroom ceiling),
  status, lease owner/expiry and a monotonic fence, cancellation request, deadline.
- `cutroom_attempt` (ordinal 1 in this slice): KnowScroll-generated `request_id`, the **exact prepared
  body bytes** and SHA-256, contract revision, state, `run_id`, cursor, validated last status, result
  and record snapshots, reported cost and settlement state. Immutable columns (request id, body, digest,
  contract revision) are trigger-protected.
- **Admission** (one transaction): lock grant, reserve `budget_cents` against it, insert job and
  attempt `prepared`. Failure creates nothing.
- **Dispatch authorization** (one short transaction, no network): current lease fence, job not
  cancel-requested, engine active, attempt `prepared` → `dispatch_committed`. Only the worker holding
  that commit may POST, once.
- **Closing before dispatch:** a cancel, deadline or invalidation while the attempt is still
  `prepared` closes it `not_sent` and releases the reservation, because no transport authority was
  ever issued. `dispatch_committed` can never return to `prepared`.
- **Outcomes:** `202` → `accepted(run_id, replayed)`; `409/422` refusal → `refused` (no run exists,
  reservation released, job `refused`); transport/protocol uncertainty → `unknown`. Recovery from
  `dispatch_committed` or `unknown` uses lookup by the original request id only; `404` is an
  observation, never proof of non-delivery. Because the contract guarantees replay for the same
  request id and JSON-equal body, the worker may resend **the identical stored bytes** a bounded number
  of times (3) to resolve `unknown`; it never creates a new request id. Exhausted resolution parks the
  job `needs_operator` with the reservation held.
- **Re-preparing after a restart:** the client only sends requests prepared in its own process, so a
  restarted worker re-prepares from the stored bytes and may send only if the recomputed request id
  and SHA-256 equal the persisted ones. A mismatch is a defect, never a new request.
- **Following:** events are paged with the persisted cursor; each page's events are stored
  (`unique(attempt, seq)`) and the cursor advanced in the same transaction; seq must be strictly
  increasing and gaps are recorded, not hidden. On `run.finished`, result and record are fetched and
  stored after strict validation.
- **Settlement:** a terminal result's reported `costCents` moves from reserved to spent and the rest
  of the reservation is released; a missing or unverifiable result keeps the whole reservation held.
  Reported cost is labelled reported, not certified complete.
- **Cancellation:** an operator cancel sets the request; the worker sends Cutroom cancel (idempotent)
  and keeps following until the run finishes; a reservation is released only per the terminal result.
- Lease loss: a replacement worker increments the fence and may only reconcile/follow; it never
  re-authorizes a consumed dispatch.

### 4. Verified local-host import

Only a `completed` result with requested stage `video` is imported, while the engine is on this host
(ADR-0007/0021). The engine path must be absolute; its realpath must lie strictly inside the realpath
of the engine's registered artifact root; `lstat` must show a regular file (no symlink); size ≤ 512 MiB.
The bytes are stream-copied to a temporary file under `KS_MEDIA_ROOT` (SSD) while hashing, fsynced,
probed with ffprobe (MP4, H.264 video, AAC audio when present, 9:16 within tolerance, 5–120 s,
progressive `moov` before `mdat`) and atomically renamed to a content-addressed key. A `media_object`
row (sha256, size, probe) and an immutable `generated_reel` row (attempt, brief, media, engine,
run id, untrusted engine path as provenance, provider mode, truth state `synthesis`, generated label,
lineage, record summary) commit together. Availability in this slice is only `imported`: **nothing
becomes eligible, published or playable**. Import failures keep the reason and leave nothing eligible;
retry is allowed while the engine file exists.

### 5. Stand-in media never reaches a real universe

`generated_reel.provider_mode` copies the engine declaration. The later publication/eligibility
contract must refuse any `standin` Reel outside a disposable test database; this ADR makes that fact
durable and immutable so it cannot be relabelled later.

### 6. Process and privacy boundaries

A separate generation worker process (not the projection worker, not the API) runs admission-free
execution: dispatch, follow, cancel, settle, import. It holds no provider credentials (Cutroom's
providers hold them) and is given only the engine registry and `KS_MEDIA_ROOT`. Operator commands
register engines, add briefs, create grants and jobs, and cancel jobs; there is no public HTTP route.
These records are shared-inventory records without universe/epoch: Clear History neither needs nor
touches them. When private demand arrives later, its waiter/binding rows carry universe/epoch.

## Alternatives and why

- *Extend the projection `job` table:* rejected for the same reasons as ADR-0012.
- *Reuse reasoning Attempt/reservation tables:* their units, private graph and erasure semantics are
  reasoning-specific; a Cutroom run is one externally metered envelope with its own contract.
- *Generate from Ask now:* no answer consumer exists (ADR-0016) and reasoning dispatch is disabled.
- *Serve engine files directly:* engine paths are untrusted host metadata with no retention promise.
- *Auto-publish imported media:* skips truth/continuity/witness gates; stand-in media could leak.

## Consequences

Migration 0013 adds the shared generation records and enforces these rules in the database:
engine origins are explicit loopback and retired rather than deleted; briefs move only draft →
approved; a reservation never exceeds the cap, settlement records any excess as an overage that
pauses the grant, and live grants stay under the owner's 200-cent total; a job needs an approved
brief, an active engine and an unexpired, unpaused grant of the engine's mode with room for it; attempt identity,
bytes, cursor and state transitions are guarded; events, media and generated Reels are append-only;
and a generated Reel must match a finished, completed video attempt of its own job with the engine's
declared provider mode. `tests/generation-contract.test.ts` exercises each of those guards and the
brief schema/compiler against a disposable database. Owner deployment remains separate and not performed. J005 proves, against disposable PostgreSQL, a real generation worker and the local
Cutroom host with stand-ins: admission atomicity, dispatch commit before POST, lost acknowledgement
reconciled to one run, identical-bytes resend, refusal release, cancellation, worker crash and lease
reclaim without redispatch, Cutroom restart during following, settlement, and verified import with
containment/symlink/size/probe refusals. Publication gates, serving, feed inclusion and playback are
the next contract.
