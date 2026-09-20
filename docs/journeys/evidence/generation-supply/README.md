# Generation-supply joined proof (issue #94, stage A2 — J005)

Status: 2026-09-20. This is the final vertical-slice proof for
[ADR-0023](../../../decisions/0023-generated-reel-supply.md): from an approved `GenerationBrief`
over a seeded library Scroll, through a real, separate generation worker process
(`apps/worker/src/generation/main.ts`, `pnpm dev:generation`), against `ops/cutroom-host`'s real
local Cutroom `api`+`worker` with upstream's own stand-in providers, to a verified,
content-addressed import in KnowScroll's own media store and an immutable `generated_reel` row.
It mirrors [#89's joined proof](../cutroom-local/README.md) and its scenario shapes, including the
observed cancel semantics documented there.

Evidence level everywhere below: **real local service with upstream stand-in providers — not real
generation.** Never a product journey, never owner acceptance. Nothing this journey produces
becomes eligible, published or playable (ADR-0023 section 4); every disposable database, Cutroom
instance and process this journey creates is its own and is torn down at the end. It never starts,
stops, restarts or submits a run to the owner-local stand-in engine on `127.0.0.1:4390`.

## Exact revisions (last passing run)

| Field | Value |
|---|---|
| KnowScroll HEAD this run's evidence was captured against | `cfdf501c3c7a9871559615ec81dddce059dcaba9` (the #94 integration lane base this stage built on; see the PR/commit that carries this evidence for the actual delivered revision) |
| Cutroom revision (pinned runtime) | `86d6e2c8b74228db4a5a953e53c53a7b77cef46e` |
| Cutroom runtime checkout | `/Volumes/Mrigesh SSD/cutroom-worktrees/runtime-86d6e2c8b742` (read-only to this lane) |
| `ops/cutroom-host/host.ts` sha256 | `e3b560b372311d3879f90b4162ec90cc672bbcc56de35cfb4072bc6c481fdead` |
| Stand-in script sha256 (`video.videoScript(THREE_RANKS, THREE_RANKS_PICS)`, generated fresh each run) | `230f282c8b5b928217faf34c2e9205ead20c7bb09e0a6a3684929907648bc108` |
| Node | `v22.23.0` |
| ffmpeg | `ffmpeg version 8.1.2 Copyright (c) 2000-2026 the FFmpeg developers` |
| Run stamp | `2026-09-20T00-20-36-341Z` |
| Full receipt | `$KS_DEV_ROOT/cutroom/logs/generation-journey-2026-09-20T00-20-36-341Z.json` |
| Sanitized snapshot (this repo) | `generation-journey.json` (next to this file) |
| Overall | **PASS** (6/6 scenarios, 146 assertions, 0 weakened assertions) |

The journey ran clean end to end at least twice in a row before this evidence was captured
(`2026-09-20T00-12-40-512Z` and `2026-09-20T00-20-36-341Z`), after fixing two real bugs surfaced by
the first attempts — see "First failures and corrections" below.

## The brief used

Every scenario compiles one `GenerationBrief` whose `worldId`/`narration`/`claims`/`criteria`/
`style` are structurally identical to upstream's own `tests/engine/video.ts` `videoRequest()`
(`stillsRequest` + `until:'video'`, itself `planRequest`'s eight sentences with `stillsRequest`'s
criteria) — the exact shape the pinned `THREE_RANKS` stand-in script answers. Only `requestId` and
`budgetCents` differ per job, exactly as ADR-0023 requires (`compileSubmitRequest` never sends
sources, claim text or truth state). `claimSources` names a real, freshly seeded library `asset`
row. This lets the journey exercise the REAL `storage.createJob`/`compileSubmitRequest` path — not
a hand-built request — while still landing on a request shape the pinned stand-in script was built
for (`scripts/cutroom-local/make-standin-script.ts`'s `completeVideo()` generator, reused
in-process here).

## Per-scenario expected vs. observed

Every scenario creates its own disposable `knowscroll_test_gen_*` PostgreSQL database (migrated
with `packages/db/migrations/0001`–`0013`), its own Cutroom instance under
`$KS_DEV_ROOT/cutroom/instances/gen-journey-<stamp>-<scenario>/`, and spawns the real generation
worker as a separate `node_modules/.bin/tsx apps/worker/src/generation/main.ts` process with an
explicit environment (`DATABASE_URL`, `KS_MEDIA_ROOT`, `GENERATION_*` tuning only).

| # | Scenario | Expected | Observed |
|---|---|---|---|
| S1 | Happy path | job → `completed`; exactly one `cutroom_attempt`; events seq-continuous; result/record persisted; settlement moves the reported cost, releases the remainder; a real MP4 at its content-addressed key with a matching sha256 and independently-ffprobed h264 stream; `generated_reel` carries `provider_mode:'standin'`, `truth_state:'synthesis'`, `generated_label:true` and full lineage; the engine's own file untouched | All true, 59 assertions. One attempt; events seq-continuous (1..N); `settlement:'settled'`, `reserved_cents:0`; `generated_reel 1da5cbc5-…` at `sha256/89/24/8924…31548.mp4`; ffprobe confirmed `h264`; original engine file unchanged in size |
| S2 | Generation worker crash (SIGKILL) between dispatch commit and any recorded outcome | a replacement worker reconciles by the original request id; exactly one Cutroom run for that request id; job still completes and imports | `GENERATION_HOLD_BEFORE_SUBMIT=1` held the worker immediately after `authorizeDispatch` committed (`attempt.state='dispatch_committed'`, `run_id:null`), confirmed by the `held_before_submit` log line naming the exact job id; `SIGKILL` confirmed (`signal:'SIGKILL'`, no graceful `stopped` line); a fresh replacement worker process reconciled through the `dispatch_committed → unknown → lookup/resend` path and completed the job; exactly one `cutroom_attempt` row; its `request_id` equalled the ORIGINAL `storage.createJob` value, never a new one |
| S3 | Cutroom host restart (SIGTERM both roles, api restarted on the same port) while the run is in flight | the worker resumes following from its persisted cursor with no seq regression/duplication; the run completes and imports | Interrupted the instant the attempt reached `accepted` (before the Cutroom worker had made any progress at all — `next_since` stayed at 1 through the restart); SIGTERM to both Cutroom roles observed as a prompt, genuinely graceful stop (`exitCode:0`, no hang) — confirming the real contract's "finishes the job in hand" is scoped to Cutroom's own current internal step, not the whole run; api restarted on the identical port; a fresh Cutroom worker (same instance/database, same stand-in) resumed and completed the remaining render; final events seq-continuous with no regression/duplication; job reached `completed` and imported |
| S4 | Operator cancel while the run is genuinely running | real contract semantics observed and recorded (effective only once the engine worker processes it); job ends `cancelled`; nothing imported; reservation released per the terminal result | The real `scripts/generation.ts cancel-job` operator CLI (a separate child process) accepted the request; job ended `cancelled`; `cutroom_attempt.settlement` resolved to `'settled'` (`reported_cost_cents:0`) once the cancelled result was recorded — settlement is a transaction that immediately follows the job-status write, so this journey polls for it explicitly rather than assuming it is simultaneous; no `generated_reel` row; `reserved_cents:0` |
| S5 | Import refusal (containment failure) | job left honestly unfinished with the typed reason in `status_detail`, never fabricated success; no `media_object`; no `generated_reel`; reservation still held; retryable while the engine file still exists | Engine registered with an artifact root that does NOT contain the real produced video; job stayed `importing` with `status_detail:'import_refused:engine_path_not_contained'`; `cutroom_attempt.settlement` stayed `'held'`; `reserved_cents` stayed at the full `300`; no `media_object` row for the refused content hash; no `generated_reel` row; forcing the lease to expire and starting a fresh worker reached the identical honest refusal again on unchanged data (retryable, never stuck, never a fabricated success) |
| S6 | Cleanup | every spawned process has exited; no stray disposable database; the owner-local engine on `:4390` untouched (pids unchanged); the pinned Cutroom checkout unchanged | All spawned generation-worker/Cutroom `api`/`worker` child processes had exited; `SELECT datname FROM pg_database WHERE datname LIKE 'knowscroll_test_gen_%'` returned 0 rows; pids 6937/6939 confirmed alive with an unchanged `ps -o lstart=` before and after (never restarted by this journey); the pinned runtime's `git rev-parse HEAD` and `git status --porcelain --ignored` (minus `node_modules`) were identical before and after |

## First failures and corrections

- **First failure (S3, first attempt):** timed out waiting for the job to reach `completed` after
  restarting only the api. Diagnosis: the real Cutroom worker's graceful `SIGTERM` stop finishes
  only its own current internal job-queue step (observed as an immediate, genuine `{"stopped":true}`
  and `exitCode:0` — never a hang, and never "keep rendering in the background" as first assumed),
  not the whole multi-stage run; the render's remaining queued work needs a fresh worker process to
  continue it. **Correction:** after restarting the api on the same port, also start a fresh Cutroom
  worker on the same instance/database (mirroring `docs/journeys/evidence/cutroom-local/README.md`'s
  own S8/S9 restart shapes) before waiting for completion.
- **First failure (S4, full-suite run only, not standalone):** `cutroom_attempt.settlement` was
  observed as `'held'` immediately after `generation_job.status` turned `'cancelled'`. Diagnosis:
  `recordResult` commits the job's `'cancelled'` status in one transaction; settlement is a
  separate, immediately-following transaction inside the same worker call, so there is a genuine,
  small window where the status is externally visible before settlement is. **Correction:** the
  journey now polls for `cutroom_attempt.settlement <> 'held'` rather than reading it once at the
  moment the job status becomes terminal. This is a test-timing fix, not a product defect: the
  worker's own ordering (settle-then-complete for the video/import path; settle-immediately for
  every other terminal outcome) is unchanged and is exactly what ADR-0023 requires ("a missing or
  unverifiable result keeps the whole reservation held").
- **A genuine behavior change made while wiring the import (recorded, not hidden):** stage A1's
  runtime settled a completed video result's cost immediately upon fetching the result, before any
  import was attempted. This stage changed that: for a `until:'video'` job whose result is
  `completed`, settlement is now deferred until a real import actually succeeds — matching
  ADR-0023's own text ("a missing or unverifiable result keeps the whole reservation held") and the
  issue's own S5 acceptance criterion ("the reservation still held"). `tests/generation-runtime.test.ts`
  was updated accordingly (see its first subtest, renamed to describe the new, deferred-settlement
  behavior); no assertion was weakened, and the corresponding storage guards
  (`generation_job_identity_guard`, `cutroom_attempt_identity_guard`) are unchanged.

## What this proves and does not

Proves: the wired import port (`apps/worker/src/generation/import-port.ts`'s
`createLocalImportPort`) really commits a verified, content-addressed MP4 and an immutable
`generated_reel` row from a REAL Cutroom run's own reported result path; the deferred-settlement
behavior change; crash/restart/cancel/refusal handling against a real (if stand-in-provider) engine
and a real, separate generation worker process, not an in-process fixture. Does not prove: real
model/image/video/voice generation (every provider here is upstream's own scripted stand-in); any
product-facing journey, publication, eligibility or playback (ADR-0023 section 4/5 explicitly keeps
this slice at `availability:'imported'` only); owner deployment or acceptance; live-provider cost
behavior (no live grant was created or exercised — the database's 200-cent live cap is enforced by
migration 0013's own trigger, proven in `tests/generation-contract.test.ts`, not by this journey).
