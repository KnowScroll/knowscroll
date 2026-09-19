# Cutroom local proof — phase 1 (issue #89, "proof" lane)

Status: 2026-09-19/20. Implements phase 1 of the "proof" lane in
[ADR-0021](../../../decisions/0021-cutroom-successor-pin-and-local-host.md) section 4's joined
proof: the request/stand-in generator, an in-process feasibility check, and the KnowScroll-side
helpers the real two-process joined proof will need. **This is data production and an in-process
feasibility check, not the joined proof itself.** Phase 2 (a separate lane) integrates
`scripts/run-local-cutroom-journey.ts` with `ops/cutroom-host/host.ts`, built in parallel by another
worker; this lane did not build or edit a host.

Evidence level everywhere below: **real local service with upstream stand-in providers** — a real
Cutroom API, worker, SQLite database and real ffmpeg/ffprobe, with Cutroom's own scripted
model/image/sensor/video/narration stand-ins in place of a paid provider. **Never real generation,
and never product acceptance** — this only proves that KnowScroll's generated requests and stand-in
scripts drive upstream Cutroom, at its pinned revision, to a real completed video with a real,
contained file and a non-empty take record.

## What is here

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
  feasibility timings below, and Cutroom's own `DEFAULT_LEASE_MS` of 60 s).
- `joined-proof-cancel.bundle.json` / `.standin.json` — the request only; its standin is an unused
  placeholder (all six keys empty) because this scenario submits with **no worker started at all**,
  then cancels. No model, image, sensor, video, narration or media call is ever made.

Every bundle's `sourceFiles` records the sha256 of the exact upstream test-support files read to
build it, and `cutroomRevision` records the runtime's `git rev-parse HEAD` at generation time, so
drift in either is detectable before it silently changes what a joined proof asserts.

## Regenerating

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

## In-process feasibility (not the joined proof)

`scripts/cutroom-local/validate-standin-inprocess.ts` composes upstream's own `startApi` +
`startWorker` in one process — wired by hand from `apps/api/src/index.ts`,
`apps/worker/src/index.ts`, `packages/providers/src/index.ts` and `packages/pipeline/src/index.ts`,
replicating (never importing) `tests/engine/harness.ts`'s small render profile — submits the
generated `complete-video` request over real HTTP, and polls the real API to a finished run.

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

Command:

```sh
. ./scripts/env.sh
node scripts/cutroom-local/validate-standin-inprocess.ts \
  --runtime "/Volumes/Mrigesh SSD/cutroom-worktrees/runtime-86d6e2c8b742" \
  --bundle docs/journeys/evidence/cutroom-local/joined-proof-complete-video.bundle.json \
  --profile both
```

## Requirement 4 — the pinned client accepts these requests unchanged

`tests/cutroom-local-request-compat.test.ts` (`pnpm exec tsx --test
tests/cutroom-local-request-compat.test.ts`) feeds every generated request through KnowScroll's own,
unmodified `prepareCutroomRequest` (`apps/worker/src/cutroom/http-client.ts`, ADR-0020/0021) and
checks: no throw; `prepared.requestId`/`until` match the request; `JSON.parse(prepared.body)`
deep-equals the original request; `prepared.bodySha256` matches an independently computed sha256 of
those exact bytes; and the restart pair's two (identical) requests prepare to the same bytes. All
five checks pass under the successor pin. Neither the client nor the copied contracts in
`packages/contracts/src/cutroom-v1/` were changed.

## Helper unit tests (no Cutroom, no database)

`tests/cutroom-local-helpers.test.ts` (`pnpm exec tsx --test tests/cutroom-local-helpers.test.ts`,
12 checks, all passing):

- **`lost-response-proxy.ts`**: a real TCP proxy in front of a real local HTTP server. Armed for one
  connection, it forwards the client's full request body to the target — proven by the target
  itself recording the exact bytes it received — then destroys the client's socket the instant the
  target's response begins, so the client (a real `fetch()`) observes a transport error. Arming is
  single-shot: the next connection round-trips normally, and `proxy.dropped` names exactly the one
  connection that was cut.
- **`containment.ts`**: accepts an ordinary file genuinely inside an artifact root; rejects a
  relative path, a `..`-escaping path, a directory, a missing path, a symlink whose target is
  outside the root, and — separately — a symlink whose target happens to resolve *inside* the root
  (proving the check is on the candidate's own `lstat`, not only on where it points).
- **`intent-store.ts`**: round-trips `{requestId, runId?, preparedBody, bodySha256, nextSince}`
  through an atomic (temp + rename) write; recomputes `preparedBody`'s hash on load and refuses a
  file whose `preparedBody` was edited without updating the stored hash, refuses malformed/missing-
  field files, and refuses to save a self-contradicting intent in the first place.

## What phase 1 does not prove

- No two-process joined proof yet: no `ops/cutroom-host/host.ts` process was started or driven by
  KnowScroll's real `apps/worker/src/cutroom/http-client.ts`. `scripts/run-local-cutroom-journey.ts`
  is a documented skeleton for phase 2, which a different lane builds against the host.
- The restart pair's semantics (hold at call 12, restart from call 1) are verified against upstream
  test-support's own documented behaviour and cross-checked against
  `tests/reel-takes-record.test.ts`'s "a restarted run" case, but this lane never actually spawned a
  worker process, killed it, and taken the job up again — that needs the host (phase 2).
- The `lost-response-proxy.ts` and `intent-store.ts` helpers are unit-proven against a synthetic
  local HTTP server and plain files, not yet exercised against a real Cutroom API through the host.
- The cancel variant's request was generated and schema-checked, but never actually submitted or
  cancelled against a running API.
- `pnpm typecheck` is green project-wide and the helper/compat tests pass; upstream's own suite was
  not re-run by this lane (the coordinator classifies its 18 known failures separately; see
  `docs/CHECKPOINT.md`).
