# Cutroom local host (ADR-0021 section 3)

This is the KnowScroll-owned **operator composition root** that starts upstream Cutroom's own
exported `startApi`/`startWorker` from a clean, detached, pinned Cutroom checkout, wired to
upstream's own **stand-in** model/image/sensor/video/narration ports plus its real local ffmpeg
media/assembler adapters. It copies or reimplements no Cutroom engine code, is never imported by
KnowScroll's API/worker/mobile, and never calls a network provider.

**What this is not.** It is not real generation, not an upstream feature, and not a product
deployment. Every run this host starts is **real local service with upstream stand-in providers** —
a genuinely running Cutroom API and worker, a real SQLite database, real ffmpeg-produced media files
— never a claim of real video/image/voice generation or of any live provider call. See
[ADR-0021](../../docs/decisions/0021-cutroom-successor-pin-and-local-host.md) for the accepted
decision this implements, and [ADR-0020](../../docs/decisions/0020-cutroom-http-client.md) for the
separately pinned, unwired KnowScroll HTTP client this host is a local target for.

## Usage

```
node ops/cutroom-host/host.ts init-instance --cutroom <runtime dir> --expect-revision <40-hex> --instance <dir>
node ops/cutroom-host/host.ts api    --cutroom <runtime dir> --expect-revision <40-hex> --instance <dir> [--port <n>]
node ops/cutroom-host/host.ts worker --cutroom <runtime dir> --expect-revision <40-hex> --instance <dir> \
  [--standin-script <json>] [--render-profile default|small] [--lease-ms <n>] [--poll-ms <n>]
```

Run with plain `node`, never `tsx`: this file dynamically imports upstream `.ts` files that only
Node's own native type stripping ever parses, and Node 22.18+ is required for that to be the
default. `--cutroom` and `--instance` must be absolute paths; `--instance` must resolve under
`KS_DEV_ROOT` and outside the Cutroom checkout. `--providers` accepts only `standin` (the default);
any other value is refused. No provider credential may be present in the process environment
(`MINIMAX_API_KEY`, `FAL_AI_KEY`, `FAL_KEY`, `DATABASE_URL`, `KS_DEV_TOKEN`, or any `*_API_KEY`
name) — the host refuses to start rather than silently drop it.

Source `scripts/env.sh` first so `KS_DEV_ROOT`, caches and `node` resolve from the SSD-backed
environment, and confirm `node --version` is `v22.23.0` before invoking this file directly.

## Instance layout

`init-instance` creates, under an absolute directory you choose (typically
`$KS_DEV_ROOT/cutroom/instances/<lane>-<utc>/`):

- `artifacts/` — the ffmpeg/stand-in artifact root (`DEFAULT_ARTIFACT_ROOT` equivalent, scoped to
  this instance so nothing is ever written inside the Cutroom checkout).
- `logs/` — reserved for a caller's own redirected stdout/stderr; this host does not write here itself.
- `BUDGET.md` — an explicit copy of `<cutroom>/steering-ref/steering/BUDGET.md`, so the per-reel
  cap this instance's worker reads is a known, hashed snapshot rather than a live pinned-submodule
  read that could change under a long-running worker.
- `instance.json` — `{ createdAt, cutroomRevision, budgetSource, budgetSha256, hostSha256 }`.
  `init-instance` is idempotent for the same revision; it refuses (`instance-not-initialized`) if
  the instance was already initialized for a different revision. `api`/`worker` refuse the same way
  if `instance.json` is missing, names another revision, or `BUDGET.md` no longer matches the
  recorded hash.
- `cutroom.sqlite` — shared by the `api` and `worker` roles you start against this instance, so a
  future worker can hold provider credentials the API process never receives.
- `QUESTIONS.md` — created lazily by upstream's own per-reel-cap refusal/stop path; this host does
  not create it in advance.
- `api.ready.json` / `worker.ready.json` — the same JSON object each role prints once on stdout at
  readiness, also persisted to disk.

## Refusal codes

Every refusal happens **before** any Cutroom module is imported and before any database is opened:
exit code 2, exactly one JSON line on stderr, `{"refused":true,"reason":"<code>","detail":"..."}`.

| Reason | Meaning |
|---|---|
| `usage` | Bad CLI shape: unknown role/flag, a flag not valid for the given role, a missing required flag, a malformed `--expect-revision`/`--render-profile`. |
| `node-version` | The running Node does not default to type stripping (needs 22.18+). |
| `revision-mismatch` | The Cutroom checkout's `git rev-parse HEAD` does not equal `--expect-revision` (or could not be read at all). |
| `runtime-dirty` | The Cutroom checkout has tracked changes (`git status --porcelain --untracked-files=no` is non-empty). Untracked/ignored build output does not count. |
| `instance-not-absolute` | `--instance` is not an absolute path. |
| `instance-outside-dev-root` | `KS_DEV_ROOT` is unset/relative/missing, or the instance (its nearest existing ancestor's real path plus its literal remaining tail) does not resolve under it. |
| `instance-inside-cutroom` | The instance resolves inside the Cutroom checkout. |
| `instance-not-initialized` | `init-instance` has not been run for this instance/revision, the instance was initialized for a different revision, or its `BUDGET.md` no longer matches the hash recorded at init. |
| `bad-port` | `--port` (api only) is not an integer 0–65535. |
| `bad-number` | `--lease-ms`/`--poll-ms` (worker only) is not a positive integer. |
| `providers-not-allowed` | `--providers` was given a value other than `standin`. |
| `secret-in-environment` | A forbidden variable **name** is present in the process environment. Only names are ever reported, never values. |
| `bad-standin-script` | `--standin-script` names a file that is unreadable, not valid JSON, or has a top-level key other than `model`, `images`, `sensors`, `video`, `narration`, `media`, `holdAtCall`. |

## Readiness and stop

On success, `api`/`worker` print exactly one JSON line to stdout and write the same object to
`<instance>/<role>.ready.json`: `ready`, `role`, `pid`, `node`, `execPath`, `startedAt`,
`cutroomRevision`, `hostSha256`, `instance`, `dbPath`, `artifactRoot`, `providers`, plus for `api`
`baseUrl`/`port` (the OS-observed listener) and for `worker` `renderProfile`, `leaseMs`, `pollMs`,
`standinScriptSha256` (`null` when no `--standin-script` was given).

`SIGTERM`/`SIGINT` call `stop()` exactly once (`api.stop()` closes the server and the database;
`worker.stop()` finishes the job in hand before closing), then print
`{"stopped":true,"role","pid"}` and exit 0. **A second `SIGTERM`/`SIGINT` received while a stop is
already in flight is ignored outright** — it does not speed up or force the shutdown, and does not
restart the stop; the process still exits once the original `stop()` settles. There is no forced
exit path in this host; a caller that truly needs an immediate stop must send `SIGKILL`, which this
host cannot intercept or make graceful.

An unexpected error (anything not covered by the refusal codes above, after the host has begun
importing Cutroom or opening its database) exits 1 with one stderr JSON line `{"error":"<message>"}`
and no environment dump.

### `holdAtCall`

A stand-in script's optional `holdAtCall` (a positive integer) mirrors upstream's own
`tests/engine/worker-process.ts`: counted across the model port's `structured`/`observe`/
`compare`/`judgeCut` calls in the order they arrive, from 1. The call at that count is never
answered — the worker prints `{"held":true,"call":n}` to stdout and stays alive, holding that job,
until it is killed. This is how a caller can reproduce a crash mid-stage on purpose.

## `prepare-runtime.sh`

```
ops/cutroom-host/prepare-runtime.sh <canonical-clone> <revision> <target-dir>
```

Target must be under `/Volumes/Mrigesh SSD`. If the target **exists**, this only verifies it: HEAD
equals `revision`, no tracked changes, `node_modules/` present, `steering-ref` initialized at the
superproject's own recorded gitlink, and `ffmpeg`/`ffprobe` on `PATH`. Prints one JSON line and
exits 0, or exits nonzero naming the first failing check. If the target is **absent**, it fetches
the canonical clone, adds a detached worktree at the pinned revision, initializes the submodule, and
installs dependencies through a working corepack
(`/usr/local/bin/corepack pnpm install --frozen-lockfile --store-dir "$KS_DEV_ROOT/pnpm-store"` —
the `nvm`-managed `corepack` on this Mac is known broken with signing keys).

This worker has only ever run this script in **verify mode**, against the pinned runtime named in
ADR-0021, and has separately exercised the create path's own argument validation (target must be on
the SSD, revision must be 40 hex characters, the canonical clone must exist) without ever reaching a
git-mutating command. It has not created another runtime checkout.

## Self-check

```
node ops/cutroom-host/self-check.ts
```

Runs entirely against the pinned, read-only runtime and fresh instances under
`$KS_DEV_ROOT/cutroom/instances/host-selfcheck-<utc>-*`. Proves, in order: every refusal code (using
scratch `git init` repositories under `$KS_DEV_ROOT/tmp` for `revision-mismatch`/`runtime-dirty` so
the real runtime is never touched, and a case with a dummy `MINIMAX_API_KEY` in a child's
environment to prove the value is never echoed); `init-instance`'s layout, idempotent rerun and
different-revision refusal; a live `api` on port 0 with its 404 shapes; a live `worker` with no
stand-in script (which requires ffmpeg to actually be ready); a minimal `SubmitRequest` — built
literally in the same shape as upstream's own `tests/engine/plans.ts` `planRequest` — submitted over
real HTTP; polling to the run's actual terminal state with an empty model script (reported as
observed, never assumed) and the `result`/`record` shapes, confirming `record.takes` is present;
graceful `SIGTERM` stop of both processes within 30 s and port release; an `api` restart on the same
port finding the same run by `runId` and `requestId`; and a `SIGKILL`ed worker followed by a fresh
worker starting cleanly on the same database. It records the Cutroom checkout's `git status
--porcelain --ignored` (minus `node_modules`) before and after, confirms no `host.ts` process is
left running, and confirms every host child it spawns receives only the allowlisted environment
(`PATH`, `HOME`, `TMPDIR`, `KS_DEV_ROOT`, `LANG`).

It writes a full receipt to `$KS_DEV_ROOT/cutroom/logs/host-selfcheck-<utc>.json` and a sanitized
snapshot (no environment values, structured pass/fail per check) to
[`docs/journeys/evidence/cutroom-local/host-self-check.json`](../../docs/journeys/evidence/cutroom-local/host-self-check.json).
This is a source/runtime receipt for the host process itself — it is **not** a product journey,
not owner acceptance, and not proof of real generation.

## Ownership boundary

This directory is the only place KnowScroll starts Cutroom locally. It never imports Cutroom code
into KnowScroll's own `apps/`/`packages/` runtime (ADR-0007), and the separately implemented,
still-unwired [pinned HTTP client](../../apps/worker/src/cutroom/http-client.ts) is what a future
KnowScroll caller would point at an instance this host started — configuring `CUTROOM_BASE_URL`
only from an **observed** `api.ready.json`/readiness line, never a guessed or fixed port.
