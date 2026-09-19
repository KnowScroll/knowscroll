# Cutroom local proof (issue #89, "proof" lane) — phase 1 + phase 2 (joined proof)

Status: 2026-09-19/20. Phase 1 built the request/stand-in generator, an in-process feasibility
check, and the KnowScroll-side helpers (`containment.ts`, `intent-store.ts`,
`lost-response-proxy.ts`). **Phase 2 is the actual joined proof from
[ADR-0021](../../../decisions/0021-cutroom-successor-pin-and-local-host.md) section 4**:
`scripts/run-local-cutroom-journey.ts` drives KnowScroll's real, repinned
`apps/worker/src/cutroom/http-client.ts` over real HTTP against `ops/cutroom-host/host.ts`'s real
API and worker processes (built by a parallel "host" lane on `claude/89-host`, merged into this
branch), which themselves start upstream Cutroom's own exported `startApi`/`startWorker` against a
real SQLite database and real local ffmpeg. All twelve scenarios below (S0–S11) ran end to end and
passed on 2026-09-19T20:32:25.145Z.

Evidence level everywhere below: **real local service with upstream stand-in providers** — a real
Cutroom API, worker, SQLite database and real ffmpeg/ffprobe, with Cutroom's own scripted
model/image/sensor/video/narration stand-ins in place of a paid provider. **Never real generation,
never a product journey, and never owner acceptance.**

## Exact revisions (final joined-proof run)

| Field | Value |
|---|---|
| KnowScroll HEAD | `f52d451dc6165db128ddd25ab53fc56b5e89800b` (`claude/89-proof`, `claude/89-host` merged in) |
| Cutroom revision (pinned runtime) | `86d6e2c8b74228db4a5a953e53c53a7b77cef46e` |
| Cutroom runtime checkout | `/Volumes/Mrigesh SSD/cutroom-worktrees/runtime-86d6e2c8b742` (read-only to this lane) |
| `ops/cutroom-host/host.ts` sha256 | `e3b560b372311d3879f90b4162ec90cc672bbcc56de35cfb4072bc6c481fdead` |
| Node | `v22.23.0`, `/Users/comreton/.hermes/node/bin/node` |
| ffmpeg | `ffmpeg version 8.1.2 Copyright (c) 2000-2026 the FFmpeg developers` |
| Run stamp | `2026-09-19T20-32-25-145Z` |
| Full receipt | `$KS_DEV_ROOT/cutroom/logs/joined-proof-2026-09-19T20-32-25-145Z.json` |
| Sanitized snapshot (this repo) | `joined-proof.json` (next to this file) |
| Overall | **PASS** (12/12 scenarios, 0 weakened assertions) |

Stand-in script / bundle sha256 (built by `scripts/cutroom-local/make-standin-script.ts`, phase 1,
against the pinned runtime above; unchanged in phase 2):

| Bundle | `.bundle.json` sha256 | `.standin.json` sha256 |
|---|---|---|
| `joined-proof-complete-video` | `7d6fbef86a584bd801075fe57e8a356c05d559179f068ce09ae203e8d1643c7b` | `819c4e656833418f2b929002c3fe087d6f3bc8acbec8d7aae3e3e0f5585d2217` |
| `joined-proof-restart-first` | `a136d0a1918b700f655f9d9d87f357eeace9ec830738774cde6e40e81a33832e` | `f181d729a18fb74a21b069e1abc200d2ee5f578b639c2e5195ce03c20c79f514` |
| `joined-proof-restart-second` | `348474d8ba2274d407ab54e80452a4ffa29eb21c2dcf043b0f656cfc24f50470` | `703b066415ecff822423d7ce23fd042d0edefdcd8b9d127914d6ea1e1fed05fb` |
| `joined-proof-cancel` | `98fd661516359ccd8e490367a2d9a05bc489f8f4e129d1033423219cba4a3c48` | `8317b51e8600b4511b83abb0fc9ea66a475be0c41a9e54cfb93c60ff54df705e` |

## Phase 2 — per-scenario expected vs. observed

Every row below ran against a fresh instance under
`$KS_DEV_ROOT/cutroom/instances/proof-2026-09-19T20-32-25-145Z-<scenario>/`, with `host.ts`
spawned by plain `node` and the ADR-0021 §3 allowlisted environment only
(`PATH`,`HOME`,`TMPDIR`,`KS_DEV_ROOT`,`LANG`; never this repo's `.env`, never a provider key).

| # | Scenario | Expected | Observed |
|---|---|---|---|
| S0 | `prepare-runtime.sh` verify + `init-instance` | verify reports `verified:true`; fresh init creates `instance.json`/`BUDGET.md`; rerun is idempotent | All true. `steeringRef` `e05e9f0257f3066b441f6554b67a786d6635c6a4`, `ffmpeg`/`ffprobe` both `true` |
| S1 | Prepare + submit a new request | `accepted`, `replayed:false` | `accepted`, `replayed:false`, runId `4c642e7b-…` |
| S2 | Exact replay of the same prepared bytes | `accepted`, `replayed:true`, same runId | Same runId `4c642e7b-…` |
| S3 | Same `requestId`, different body | refused, `reason:"conflict"` (409) | `refused`/`conflict` |
| S4 | Server-side invalid body; client-local unsupported `planVaryOn` | raw fetch of a schema-invalid body → HTTP 422, `outcome:"refused"`, `reason:"invalid"`; `prepareCutroomRequest` throws locally on `planVaryOn:"angle"` with no HTTP call | HTTP 422 / `invalid`; local throw confirmed, zero HTTP calls made for that case |
| S5 | Lost response (armed TCP proxy cuts the socket after the target answers) | client observes a `transport_error` with `writeUncertain:true`; lookup by the original `requestId` on the *real* origin finds the run; a later exact replay reports `replayed:true` with that runId; exactly one `run` row exists | `{"kind":"transport_error","code":"network","writeUncertain":true}`; lookup found runId `16c71c39-…`; replay `replayed:true` same runId; exactly 1 row in `run` table; proxy recorded the full request body reaching the server and dropped exactly 1 connection |
| S6 | Lookup of an absent `requestId` | `not_found` (404) | `{"kind":"not_found"}` (recorded as a current observation only, not a durable absence guarantee) |
| S7 | Complete video run | strict cursor paging to `run.finished`, no seq gaps/dupes; `result` is `completed`/`video`; every stills/video path contained under the instance artifact root; video is ffprobe-readable; record has non-empty `takes` with ≥1 `used:true` | 41 events, seq-continuous; `completed`/`video`; video + 3 stills all contained; ffprobe succeeded; sha256 recorded; 6 takes, 6 `used:true`; wall time 11343 ms (small render profile) |
| S8 | Graceful restart mid-run, resumed by a **separate** reconstructed-caller process | intent persisted after acceptance and after every events page; SIGTERM → `{"stopped":true}`, exit 0, for both roles while the run is genuinely still `running`; api restarts on the *same* port; a new process loads the intent, verifies its digest, resumes from the persisted `nextSince`; no seq regression/duplication across processes; run finishes | 14 pre-restart events observed (900 ms interrupt budget) while jobs stood at `reel.plan=done, reel.keyframes=done, reel.clips=done, reel.assemble=queued`; both roles reported `{"stopped":true}` and exited 0; api2 restarted on the identical port; reconstructed-caller (a distinct `pnpm exec tsx` child) exited 0 after resuming 27 more events; combined 14+27=41 events, seq-continuous with no regression/duplication; run finished `completed`/`video` |
| S9 | Crash: `holdAtCall`, then SIGKILL both roles, restart, reclaim | worker holds at call 12, `{"held":true,"call":12}`; both roles SIGKILLed; api restarts on the same port; a fresh worker with a short lease and the upstream-validated restart stand-in reclaims the abandoned `reel.clips` job; run reaches a terminal state; full event history (spanning the crash) stays seq-continuous | Held exactly at call 12; both processes confirmed killed by `SIGKILL` (not a graceful exit); `leaseMs=1000` (phase 1's validated fixture); after restart `reel.clips` shows `attempts:2` (genuinely reclaimed and rerun); run completed `completed`/`video`, 7 takes recorded, 6 `used:true`; full event history seq-continuous with no gaps/duplicates across the api restart |
| S10 | Cancel with no worker running, then start one | `cancel()` returns a schema-valid `RunStatus`; starting a worker afterward is observed as-is (not forced) | Before cancel: `state:"running"` (no worker had touched it). `cancel()` returned a valid `RunStatus` with `state:"running"` (Cutroom's cancel marks intent; the job row is what actually stops work). After starting a worker, the run reached `state:"finished"` within the 15 s window, and `result()` reported `status:"cancelled"`, `costCents:0` — the actual terminal outcome upstream produces for a cancelled-before-any-work run, not a forced/assumed one |
| S11 | Cleanup | every spawned host/caller process has exited by the time cleanup checks run; `ps` shows no `host.ts`/`reconstructed-caller`; pinned runtime HEAD/git-ignored-status/`ls -a` identical before and after; instance dirs listed with sizes | 20/20 process-exit checks passed (mix of clean `code:0` exits after SIGTERM and `signal:"SIGKILL"` from S9's forced kills — both are expected, not failures); `ps` empty; runtime HEAD, ignored-status and top-level listing byte-identical before/after; 6 instance dirs kept (see below) |

Instance directories from this run (kept as evidence, not deleted), all under
`$KS_DEV_ROOT/cutroom/instances/`:

| Directory | Bytes |
|---|---|
| `proof-2026-09-19T20-32-25-145Z-s0` | 7,823 |
| `proof-2026-09-19T20-32-25-145Z-protocol` | 188,811 |
| `proof-2026-09-19T20-32-25-145Z-complete-video` | 3,868,930 |
| `proof-2026-09-19T20-32-25-145Z-graceful-restart` | 3,870,999 |
| `proof-2026-09-19T20-32-25-145Z-crash-restart` | 4,624,322 |
| `proof-2026-09-19T20-32-25-145Z-cancel` | 181,414 |

Two earlier full runs from the same session while the script was being written and fixed
(`proof-2026-09-19T20-06-09-202Z-*` and `proof-2026-09-19T20-09-09-434Z-*`, also all-pass, and
`ops/cutroom-host/self-check.ts`'s `host-selfcheck-20260919T191558Z-*` from the host lane) remain on
disk as well; none were deleted, none contain provider keys or secrets.

## Reproducing

```sh
. ./scripts/env.sh
pnpm exec tsx scripts/run-local-cutroom-journey.ts
```

Writes the full receipt to `$KS_DEV_ROOT/cutroom/logs/joined-proof-<run-stamp>.json` and overwrites
the sanitized snapshot `joined-proof.json` in this directory. Every scenario's assertions are
recorded whether it passes or fails; a run only exits non-zero if at least one scenario fails.

## What is here (phase 1 fixtures, unchanged in phase 2)

- `joined-proof-complete-video.bundle.json` / `.standin.json` — a single worker run, from an empty
  database to a completed `until: video` result, using upstream's `THREE_RANKS` /
  `THREE_RANKS_PICS` fixture (`tests/engine/stills.ts`, `tests/engine/video.ts`): every take passes
  every gate (2–5) on its first attempt and Gate 7 accepts the cut, so the record lists six takes,
  all `used: true` (matches upstream's `tests/reel-takes-record.test.ts`, "a completed video run").
- `joined-proof-restart-first.bundle.json` / `.standin.json` and
  `joined-proof-restart-second.bundle.json` / `.standin.json` — a pair sharing one identical
  request. The FIRST stand-in holds model call 12 (shot 0's reconcile call: Gates 2–4 already
  reached, cut off before Gate 5) and never answers it — the joined proof kills that worker once it
  prints `{"held":true,"call":12}`. The SECOND stand-in is `clipsScript(takesOf(THREE_RANKS))`,
  answering fresh from call 1, because at this Cutroom pin (`86d6e2c8b74228db4a5a953e53c53a7b77cef46e`)
  a restarted `reel.clips` job runs again from the start (S-076; Slice 5's checkpoints are not
  implemented yet) — a fresh process's stand-in has no memory of the killed one's answers either way.
  `recommendedLeaseMs` (1000) is upstream's own short test lease
  (`tests/engine/restart.ts`'s `LEASE_MS`), chosen so a real joined-proof host claims the job again
  soon after the kill; it is a fast-test value, not a production recommendation (compare the
  feasibility timings below, and Cutroom's own `DEFAULT_LEASE_MS` of 60 s). Phase 2's S9 uses this
  same pair against the real host and observed the reclaim happen for real (`attempts:2`).
- `joined-proof-cancel.bundle.json` / `.standin.json` — the request only; its standin is an unused
  placeholder (all six keys empty) because this scenario submits with **no worker started at all**,
  then cancels. No model, image, sensor, video, narration or media call is ever made in the
  standin's own generation step; phase 2's S10 does start a worker afterward, against the real host,
  and records the actual `cancelled` terminal result upstream produces.

Every bundle's `sourceFiles` records the sha256 of the exact upstream test-support files read to
build it, and `cutroomRevision` records the runtime's `git rev-parse HEAD` at generation time, so
drift in either is detectable before it silently changes what a joined proof asserts.

## Regenerating the fixtures

```sh
. ./scripts/env.sh
node scripts/cutroom-local/make-standin-script.ts \
  --runtime "/Volumes/Mrigesh SSD/cutroom-worktrees/runtime-86d6e2c8b742" \
  --variant all --request-id "<a fresh base id>"
```

This only reads the pinned runtime checkout (dynamically importing its OWN
`tests/engine/{harness,plans,stills,video,restart}.ts` test-support builders — never a `*.test.ts`
file, which would register `node:test` tests) and writes under this directory. It starts no
process and never writes inside the Cutroom checkout. Importing test-support like this is allowed
ONLY in this generator; `ops/cutroom-host/host.ts` must never do it.

## In-process feasibility (phase 1, not the joined proof — superseded by phase 2's real two-process run)

`scripts/cutroom-local/validate-standin-inprocess.ts` composes upstream's own `startApi` +
`startWorker` in one process — wired by hand from `apps/api/src/index.ts`,
`apps/worker/src/index.ts`, `packages/providers/src/index.ts` and `packages/pipeline/src/index.ts`,
replicating (never importing) `tests/engine/harness.ts`'s small render profile — submits the
generated `complete-video` request over real HTTP, and polls the real API to a finished run. This
was phase 1's evidence that the fixtures were feasible before a host process existed; phase 2's S7
above is the same request driven through the real two-process host instead, and is now the
authoritative result (11,343 ms wall time for the full submit→finished path, vs this section's
in-process 4,251/6,246 ms — the difference is process-spawn/readiness overhead for two extra
processes, not a different render).

Run 2026-09-19 against runtime `86d6e2c8b74228db4a5a953e53c53a7b77cef46e` (clean, matching the
bundle's pinned revision):

| Render profile | Wall time | Result | Video path contained | Takes | `used: true` |
|---|---|---|---|---|---|
| small (108×192, the harness's test profile) | 4251 ms | `completed`/`video` | yes | 6 | 6 |
| default (768×1366, Cutroom's own `DEFAULT_RENDER_SETTINGS`) | 6246 ms | `completed`/`video` | yes | 6 | 6 |

Instance directories (kept as evidence, not deleted):
`$KS_DEV_ROOT/cutroom/instances/proof-validate-2026-09-19T19-26-38-908Z-small` (3.8 MB) and
`$KS_DEV_ROOT/cutroom/instances/proof-validate-2026-09-19T19-26-50-749Z-default` (9.4 MB), each
holding `cutroom.sqlite`, `QUESTIONS.md` (never written, since no run refused or stopped on
budget), a copy of `BUDGET.md` (from the runtime's `steering-ref/steering/BUDGET.md`), `artifacts/`
with the real PNG/WAV/MP4 files Cutroom's stand-ins and ffmpeg wrote, and `receipt.json` with the
same figures as the table above. No process was left running after either run (`ps`/`lsof` checked
after both).

## Requirement 4 — the pinned client accepts these requests unchanged

`tests/cutroom-local-request-compat.test.ts` (`pnpm exec tsx --test
tests/cutroom-local-request-compat.test.ts`) feeds every generated request through KnowScroll's own,
unmodified `prepareCutroomRequest` (`apps/worker/src/cutroom/http-client.ts`, ADR-0020/0021) and
checks: no throw; `prepared.requestId`/`until` match the request; `JSON.parse(prepared.body)`
deep-equals the original request; `prepared.bodySha256` matches an independently computed sha256 of
those exact bytes; and the restart pair's two (identical) requests prepare to the same bytes. All
five checks pass under the successor pin. Neither the client nor the copied contracts in
`packages/contracts/src/cutroom-v1/` were changed. Phase 2 additionally proves this same client
actually talks to the real host over HTTP for every one of S1–S10 above.

## Helper unit tests (no Cutroom, no database)

`tests/cutroom-local-helpers.test.ts` (`pnpm exec tsx --test tests/cutroom-local-helpers.test.ts`,
12 checks, all passing; run together with `tests/cutroom-http.test.ts`'s 30 checks as required by
this lane's brief — 42/42 pass):

- **`lost-response-proxy.ts`**: a real TCP proxy in front of a real local HTTP server. Armed for one
  connection, it forwards the client's full request body to the target — proven by the target
  itself recording the exact bytes it received — then destroys the client's socket the instant the
  target's response begins, so the client (a real `fetch()`) observes a transport error. Arming is
  single-shot: the next connection round-trips normally, and `proxy.dropped` names exactly the one
  connection that was cut. Phase 2's S5 reuses this exact proxy against the real host.
- **`containment.ts`**: accepts an ordinary file genuinely inside an artifact root; rejects a
  relative path, a `..`-escaping path, a directory, a missing path, a symlink whose target is
  outside the root, and — separately — a symlink whose target happens to resolve *inside* the root
  (proving the check is on the candidate's own `lstat`, not only on where it points). Phase 2's S7,
  S8 and S9 check every real video/still path the host produced with this same function.
- **`intent-store.ts`**: round-trips `{requestId, runId?, preparedBody, bodySha256, nextSince}`
  through an atomic (temp + rename) write; recomputes `preparedBody`'s hash on load and refuses a
  file whose `preparedBody` was edited without updating the stored hash, refuses malformed/missing-
  field files, and refuses to save a self-contradicting intent in the first place. Phase 2's S8 uses
  this exact module to persist and reload the intent a real, separate reconstructed-caller process
  resumes from.

## What this proof does not show, and other limits

- **No real providers, no generation quality claim.** Every model/image/sensor/video/narration
  answer came from upstream's own scripted stand-ins (`packages/providers/src/fake/*.ts`); the only
  real adapter exercised is local, keyless ffmpeg/ffprobe. This says nothing about output quality,
  cost, latency or behavior of any real model/image/video/voice provider.
- **Not in CI.** This needs a local Cutroom runtime checkout with installed dependencies and
  ffmpeg; GitHub CI keeps the synthetic fixture journey instead (per ADR-0021's "Consequences").
- **No import, publication or playback.** This proves KnowScroll's client and the local host
  interoperate with upstream's HTTP surface, SQLite storage and restart behavior — not the product's
  import/publication/playback boundary (#8/#9), which remains open.
- **Single machine, single session.** All revisions, timings and process behavior above were
  observed on this Mac, this session, against this exact pinned runtime checkout. They are not a
  general performance or portability claim.
- **Upstream suite state is tracked separately.** The coordinator's own upstream test run (304/322
  pass, 18 known failures at this same pin) is not re-verified by this lane; see
  `docs/CHECKPOINT.md` and the upstream log path recorded there. Nothing in this proof depends on
  those 18 failing files.
- **S6's absence and S10's cancel-before-work observations are point-in-time.** A `not_found` lookup
  or a `cancelled` result now does not certify future behavior; both are recorded as current
  observations only, per this lane's brief.
- **This is source/runtime proof only**, explicitly labelled throughout as "real local service with
  upstream stand-in providers" — never real generation, never a product journey, and never owner
  acceptance.

## Coordinator reproduction on the integration head (2026-09-19/20)

The coordinator merged host and proof lanes into `claude/89-cutroom-local` and re-ran everything
there with a stripped environment (`PATH`, `HOME`, `TMPDIR`, `KS_DEV_ROOT`, `LANG` only):

- `node ops/cutroom-host/self-check.ts` — **overall PASS**, receipt
  `$KS_DEV_ROOT/cutroom/logs/host-selfcheck-20260919T215041Z.json` (snapshot `host-self-check.json` is this run).
- `pnpm exec tsx scripts/run-local-cutroom-journey.ts` — **12/12 PASS**, run stamp
  `2026-09-19T21-51-08-110Z`; `joined-proof.json` is this run's snapshot (the builder's
  `2026-09-19T20-32-25-145Z` run remains in `$KS_DEV_ROOT/cutroom/logs/`). S7 again produced a 29 s
  9:16 H.264 stand-in render with 6 takes, all used; the takes/used checks are enforced in the
  verification step even though the snapshot lists them as observations.
- `pnpm typecheck`; 47 targeted Cutroom client/helper/compat checks; full backend `pnpm test`
  (479 + 12 passing, 0 failing).

Upstream Cutroom's own suite at this pin has 16 tests that fail deterministically on this Mac (see
the shared checkpoint); the stand-in paths exercised here were unaffected. Recorded only; KnowScroll
does not modify Cutroom.
