# Research: upstream Cutroom and KnowScroll's Reel path (for Gate 2)

Date: 2026-10-07. This research was read-only. No provider was called, nothing was installed, and no
key was read.

- **Cutroom:** a fresh clone of `KnowScroll/Cutroom` at `94ee04a` on the SSD (`/Volumes/Mrigesh SSD/Cutroom`).
- **KnowScroll:** branch `claude/9-cutroom-integration` on `dev` at `3a993b89`.
- **References:** `C:` means a Cutroom path and `K:` means a KnowScroll path.
- **Checking:** the facts that decide the design were re-read by hand and are marked ✔. The rest
  come from two research passes that cited lines.

## Upstream Cutroom at 94ee04a

### Running it
- ✔ **Start:** `node --experimental-strip-types --no-warnings apps/service/src/main.ts`.
- **Build:** there is no build and no bundle. Packages export `src/index.ts`, and migrations load
  from source (`C:packages/domain/src/db.ts:10`).
- **Install:** production needs a checkout plus `pnpm install` (pnpm 10.15.1).
- **Node:** `>=22.14`.
- **Native module:** better-sqlite3 13.0.3, which uses prebuilt binaries. build-essential is needed
  only if no linux-x64 prebuild exists.
- **ffmpeg/ffprobe on PATH:** needs `libx264`, `aac`, and the `ass`, `zoompan`, `blurdetect`, `ssim`,
  `scale2ref`, `signalstats` and `ebur128` filters. The service refuses to start if any is missing
  (`C:apps/service/src/service.ts:124-134`).
- **Captions font:** "Arial", which nothing checks (`C:packages/pipeline/src/render/index.ts:49`).
- ✔ **Stopping:** the service stops on SIGINT, on "stop" written to stdin, or on **stdin EOF**
  (`C:apps/service/src/main.ts:49-56`). It has no SIGTERM handler. Under systemd's defaults
  (stdin `/dev/null`, SIGTERM) it would stop as soon as it starts, or be killed mid-job.
- **Platform:** developed on Windows, with no CI. Linux is the stated target.
- **Deployment:** "service deployment … not built" (`C:docs/STATUS.md:34-36`). There are no tags and
  every package is `0.0.0`.

### Settings (`C:apps/service/src/settings.ts:84-101`)
- `CUTROOM_DB_PATH`, `CUTROOM_ARTIFACT_ROOT`, `CUTROOM_QUESTIONS_PATH` (append-only),
  `CUTROOM_BUDGET_PATH` (`| Per reel, all-in | $X.YY |`), `CUTROOM_API_PORT` (default 8787; the host
  is fixed at 127.0.0.1).
- `CUTROOM_PROVIDER_{MODEL,IMAGE,SENSOR,VIDEO,NARRATION}` default to `fake`. The real set is
  minimax / fal / local / fal / minimax.
- `MINIMAX_API_KEY` and `FAL_KEY`: a missing key for a real port refuses startup.
- **Voice:** `CUTROOM_NARRATION_VOICE` defaults to `'stand-in'`, and nothing checks it at startup. A
  paid run would fail at narration *after* the pictures were paid for. The voice upstream verified
  live is `English_Graceful_Lady`.
- **Resume delay:** `CUTROOM_RESUME_DELAY_MS` is 15 min. Resume is always on, and 0 means
  immediate.
- **Lease:** with any real port it is 4 h. A crashed worker's job reruns after the lease and can pay
  again for in-flight work.
- **Concurrency:** exactly one worker, sequential.
- **Run times:** real runs took 13–41 min.

### Free stand-in mode
- Stand-in is the default: every port is `fake`.
- **The fake model answers only from a script,** indexed by role and call order, and its counter
  lives as long as the process (`C:packages/providers/src/fake/model.ts:83-93`). With no script, a
  run fails as `engine`, which is never resumed. **One process finishes one scripted run.**
- **Outputs are real files:** a test pattern, tones, and the final 768×1366 MP4 with burned
  captions. Receipts are marked fake and cost 0.
- **Fake or real is fixed per process.** There is no per-request switch.

### HTTP v1 (`C:apps/api/src/server.ts:281-367`)
- **Routes:**
  - `GET /v1/ready`;
  - `POST /v1/runs` (202 `{runId, replayed}`, 409 conflict, 422);
  - `GET /v1/runs?requestId=`, which returns the **newest** run for that id;
  - `GET /v1/runs/:id`, plus `/events?since=`, `/result` and `/record` (409 while running);
  - `POST /v1/runs/:id/cancel` and `/resume`.
- **No download route.** Results carry absolute local file paths.
- ✔ **Idempotency** (`C:packages/domain/src/runs.ts:97-135`):
  - The request's key-sorted canonical JSON is compared with the newest run for that requestId.
  - Equal → `replayed`: the existing run comes back (its resume, if it has one) and nothing new is
    queued or spent.
  - Different → `conflict`.
- **One global requestId namespace, no tenants, no auth.** Loopback only, by design.

### Auto-resume
- **When:** only a `failed` run of kind unavailable, unreadable, provider-failed or crashed, once
  per chain.
- **Never resumed:** gate or budget stops, refusals, off-spec, engine.
- **On the wire:** `resumedBy` on the failed run, `resumes` on the new run, `keptFrom` on copied
  pieces. Lookup and replay return the resume.
- **Cost:** each run's `costCents` is its own spend, so a Reel's total is the **sum over the chain**.
- **Silent cases:** a resume over the ceiling is skipped silently. One over the cap only writes to
  `QUESTIONS.md`.

### Money and checks
- **Cost** is computed at configured rates, not billed by the providers. Video is set
  "deliberately at least 16× fal's real charge"; model and narration count 0.
- **Two limits:** the per-reel cap (BUDGET.md) and the request's `budgetCents` ceiling. Both are
  checked before every paid call. There is no total or monthly cap.
- **Recent real runs** (`C:docs/context.md:61-96`):
  - completed runs cost 49–58¢;
  - stopped runs cost 45–75¢ and give no Reel;
  - 2 of the last 6 runs completed (2026-09-26), and 3 of the last 10.
- **Checks:** `verdict` events `{gate, outcome: accept|accept_with_label|fail, shotId?}`. The record
  holds per-picture and per-take `checks[{gate, step?, outcome}]` with observation and
  reconciliation ids. **What the witness saw is not on the wire.**
- ✔ **Final file:** libx264 + aac with `+faststart` (`C:packages/providers/src/ffmpeg/assemble.ts:259-273`).
  It is 768×1366 (0.562, within KnowScroll's 9:16 ±2%) and 35–45 s, so KnowScroll's import profile
  accepts it.

### Wire drift from KnowScroll's pin `86d6e2c8`
- **Unchanged:** request, events, errors, contract version 1.
- **Added:** `resumes?`, `resumedBy?`, `keptFrom?`, `/v1/ready` and `/resume`.
- **Breaking in practice:** KnowScroll's vendored schemas are strict objects, so they reject any
  status or record that carries the new keys. Re-vendoring is required.
- **requestId is no longer unique per run** (resumes share it).

## KnowScroll's side (`dev` at 3a993b89)

### Client
- `K:apps/worker/src/cutroom/http-client.ts`: loopback only.
- **Pin:** `K:packages/contracts/src/cutroom-v1/source.json:3` and `CUTROOM_CONTRACT_REVISION` in
  `K:packages/db/src/generation/storage.ts:24`.
- **requestId** is `ks-gen-<uuid>`, minted at admission (`storage.ts:364`). It is stored with the
  exact body and digest, and both are immutable (migration 0013).
- **Resends:** exact bytes, at most 3 after a 404 lookup (ADR-0023).
- **One attempt:** `ordinal = 1`, and `run_id` is unique and immutable. **A resume chain cannot be
  recorded today.**
- **Lease:** never renewed (`storage.ts:509`).
- **Live dispatch** is denied in code (`storage.ts:325`, `live_dispatch_not_authorized`).

### Data and guards
- **Tables:** `cutroom_engine` (one active origin per database, `provider_mode standin|live`),
  `generation_brief`, `generation_budget_grant` (live grants need `authorization_ref`),
  `generation_job`, `cutroom_attempt`, `cutroom_event`, `media_object`, `generated_reel`.
- **Live cap:** at most 200¢ of live grants **per database** (0013:218-231).
- **Lineage guard** (0013:200-214): a Reel must come from this database's own finished video attempt,
  with matching engine mode.
- **The 0014 fence:**
  - `test_eligible` only for `standin` Reels in `knowscroll_test_*` databases;
  - `eligible` needs every required gate recorded, with no `fail` or `unavailable`;
  - both VPS databases pass the name test.

### Publication
- **Policy:** only `publication-v1` exists, with 7 required gates.
- **Witness:** `witness_alignment` always returns `unavailable` (`K:apps/worker/src/publication/gates.ts:512-521`).
- **Labels:** `pass_with_label` already counts as passing (`evaluate.ts:373-376`).
- **Commands:** evaluate and mint run through a one-shot CLI that is not in the release bundle.
- **"Why this Reel appeared"** shows only the Composer's reason; the contract has no label or gate
  fields.

### Media
- **Import** (`K:apps/worker/src/generation/import.ts:73-158`):
  - the file's realpath must sit inside the engine's artifact root, and be ≤512 MiB;
  - it is stream-copied and hashed;
  - the ffprobe profile is checked;
  - an atomic rename stores it by content address.
- **Served** at `GET /v1/media/:sha256` with Range support.

### Processes
- **Generation worker:** `apps/worker/src/generation/main.ts` is already in the release bundle, but
  it is not deployed (`ks_world_services: [api, worker, maintenance]`).
- **Operator CLIs not bundled:** `scripts/generation.ts`, the publication CLI and
  `scripts/scrolls/write-scrolls.ts`.

### Stand-in host (J005)
- `K:ops/cutroom-host/host.ts` runs upstream with stand-in providers plus real ffmpeg.
- It refuses keys, and refuses instances outside `KS_DEV_ROOT`.
- Its stand-in script builder only fits one request shape. It is not usable on the server as it
  stands.

### Library and map
- **Model-written Scrolls (ADR-0041):** MiniMax-M3 on the token plan, then deterministic checks. The
  admitted asset id is `randomUUID()`.
- **The seed:** inserts the 23 editorial Scrolls with fixed ids, is idempotent, and adds no Reels.
- **The Cartographer** runs synchronously inside reader requests (exposures, keep, asks …). A place
  forms only for an anchored concept:
  - ≥3 episodes;
  - **≥2 days active**;
  - ≥2 voluntary acts;
  - ≥2 source families;
  - mass ≥4 (`K:packages/core/src/atlas/attention.ts:46-52`).

### What assumes one database per Cutroom
- requestIds are minted per database.
- There is no import-only path (the lineage guard).
- The 200¢ cap is per database.
- Settlement only knows the run it followed.
- There is no lease across databases.
- Import reads the engine's file separately for each world's user.
- The source Scroll must exist in the evaluating database.
- The repetition corpus is per database.
