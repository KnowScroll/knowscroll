# Discovery: Cutroom (reel engine) and its KnowScroll integration

Read-only discovery for the KnowScroll v2 programme, 2026-10-19. Nothing was changed in any repo,
service or database. No provider calls, no POSTs to Cutroom.

Sources and pins used throughout:

| Source | Pin | How read |
|---|---|---|
| Cutroom upstream `KnowScroll/Cutroom` `main` | `94ef335` (2026-10-17, "docs(benchmark-view): the owner accepted the page…") | `git clone --mirror` into `agents/discover-cutroom/cutroom-mirror.git`, `git archive main` into `agents/discover-cutroom/cutroom-main/` |
| Local clone `/Volumes/Mrigesh SSD/Cutroom` | `94ee04a` ("KT"), clean | `git -C … log` only |
| KnowScroll `knowscroll-product` `origin/dev` | `106c4701` (2026-10-16) | `git archive origin/dev <paths>` into `agents/discover-cutroom/ks-dev/` |
| VPS `knowscroll-vps` | live, read 2026-10-19 | `systemctl status/cat`, `curl GET /v1/ready`, read-only `SELECT`s |

---

## 0. What changed upstream since 94ee04a (the pin KnowScroll and the VPS run)

**66 commits, 94ee04a..94ef335 (2026-10-04 → 2026-10-17). None of them changes the wire, the
service, the pipeline, the providers or the database schema.**

- `git diff --stat 94ee04a main -- packages/reel-contract packages/sdk apps/api apps/service packages/pipeline packages/providers db/migrations` is **empty**.
- The only source diffs in runtime packages are **formatting** (biome replaced eslint/prettier):
  `packages/contracts/src/failures.ts` (union laid out one member per line),
  `packages/domain/src/{clips,resume,schema}.ts` (call chains re-wrapped),
  `apps/worker/src/video-port.ts` (union re-wrapped). No behaviour change.
- KnowScroll's vendored contract `packages/contracts/src/cutroom-v1/*.ts` (source.json pins
  `94ee04a1c48069c293203de326d4801360ca6158`) is **byte-identical** to upstream `main`'s
  `packages/reel-contract/src/*.ts` (sha256 of all nine files match; only `index.ts` is not vendored).
- What the 66 commits did add (tooling and docs only):
  - `knowledge-transfer/` — an 11-chapter KT guide + `cutroom-kt.html` (good reference; chapters
    03 request lifecycle, 07 DB and queue, 08 resume, 09 SDK and contracts, 10 settings and budgets).
  - `packages/benchmark` + `packages/benchmark-read` + `scripts/benchmark*.mjs` — a "yield benchmark"
    that rates every recorded run (52 runs) and a local page (`benchmark-view`) to read it; fixtures
    under `tests/fixtures/benchmark/` include taken real-run shapes (`taken-stopped-at-gate-7`,
    `taken-stopped-by-the-budget`, `taken-lost-a-call`, …) that are useful as **v2 wire fixtures**.
  - `scripts/check.mjs`, `_verification.mjs`, `impact-map.mjs`, `run-tests.mjs` — check/receipt tooling.
  - `DECISIONS.md` +2,514 lines (S-18x…S-21x: benchmark, CI, check scheduling), PROMPTS 076–090.
- Upstream `docs/STATUS.md` (2026-10-01) next queue: `self-heal`, then P-013/P-014 reliability,
  `caption-match`, `composed-hold`, `diagram-shots`, `code-reels`, `parallel-shots`. **None built yet.**
- Consequence for v2: **re-pinning to 94ef335 is a no-op for the wire.** There is no reason to move the
  VPS off 94ee04a for v2 unless a later upstream feature (e.g. `self-heal`, P-013 retry on status
  connection errors) lands.

---

## 1. The current Cutroom HTTP service contract (exact)

Authoritative source: `packages/reel-contract/src/*.ts` (types + zod schemas, `CONTRACT_VERSION = 1`),
implemented by `apps/api/src/server.ts`, composed with the worker by `apps/service/src/service.ts`.
Identical at 94ee04a and 94ef335. KT guide: `knowledge-transfer/03-request-lifecycle.md`,
`08-resume-of-failed-runs.md`, `09-sdk-and-contracts.md`, `10-settings-and-budgets.md`.

### 1.1 Transport, auth, ports

- Plain HTTP/1.1, JSON (`content-type: application/json`), **bound to `127.0.0.1` only, hard-coded**
  (`LOOPBACK` constant in `apps/api/src/server.ts`; "not a setting", D-098).
- **No authentication of any kind, no tenants, no total budget.** Any process on the host that can
  reach the loopback port can submit paid work. (VPS: every local user can reach `127.0.0.1:8797`.)
- Default port `8787` (`CUTROOM_API_PORT`, `0` = OS-assigned). VPS pool instance listens on **8797**.
- One process = API + exactly **one** worker (S-113). Jobs run one at a time.
- Clean shutdown only on SIGINT or a `stop` line / EOF on stdin (`apps/service/src/main.ts`); it has
  **no SIGTERM handler**, so SIGTERM is not a clean stop (VPS wrapper holds stdin on a FIFO,
  `KillSignal=SIGINT`).
- Every body (requests, responses, each event) carries `contractVersion: 1`. All objects are
  `z.strictObject` — unknown fields are rejected, not stripped.

### 1.2 Routes (`packages/reel-contract/src/routes.ts`)

| Method + path | Body | Responses |
|---|---|---|
| `POST /v1/runs` | `SubmitRequest` | 202 `SubmitResponse{outcome:'accepted', requestId, runId, replayed}`; 409 refused `conflict`; 422 refused `version`/`invalid`/`unsupported`; 500 `ErrorResponse` |
| `GET /v1/runs?requestId=<id>` | — | 200 `RunStatus` of the **newest** run with that requestId (a resume run if one exists); 400 if missing; 404 none |
| `GET /v1/runs/:runId` | — | 200 `RunStatus`; 404 |
| `GET /v1/runs/:runId/events?since=<n>` | — | 200 `EventsPage{events, nextSince}` (all events with `seq > since`; no page size limit); 400 bad `since`; 404 |
| `GET /v1/runs/:runId/result` | — | 200 `RunResult`; **409 `RunStatus` while running**; 404 |
| `GET /v1/runs/:runId/record` | — | 200 `RunRecord`; **409 `RunStatus` while running**; 404 |
| `POST /v1/runs/:runId/cancel` | (none) | 200 `RunStatus` (sets `cancel_requested`, honoured at the next stage start; idempotent); 404 |
| `POST /v1/runs/:runId/resume` | `ResumeRequest` | 200 preview; 202 accepted (new run) or replayed; 409 `not-resumable`/`resumed`/`budget`; 422 `version`/`invalid`/`unsupported`; 404 |
| `GET /v1/ready` | — | 200 `{contractVersion:1, ready:true}` once the sole worker has started; 503 `{ready:false}` before; reads no DB |

There is **no run-listing route, no artifact-download route, no health/version route** beyond
`/v1/ready`. Results return absolute filesystem paths on the engine host, never bytes.
Error body: `ErrorResponse{contractVersion, error:'not-found'|'invalid'|'internal', detail}`.

### 1.3 `SubmitRequest` (`request.ts`)

```
{ contractVersion: 1,
  requestId: string(min 1),                      // caller's idempotency key
  worldId: string(min 1),
  narration: [{ text: string(min 1), claimIds: string[] }]  (min 4),
  claims: [{ id: string, role: 'main'|'supporting' }],
  criteria: { mustShow: Criterion[], mustNotShow: Criterion[] (presence only),
              depictionPolicyVersion: string },
     Criterion = { id, text, type:'presence'|'event', claimId? }
  style: { id: string, version: int>=0, text: string },
  options: { until: 'plan'|'stills'|'video', budgetCents: int>0, planVaryOn?: 'shotCount'|'order'|'canonicalSubject'|'angle' } }
```

Validation (zod superRefine + server): every claim listed once; every sentence's `claimIds` must be
listed; **every listed claim must be referenced by some sentence**; a criterion's `claimId` must be
listed; `planVaryOn:'order'` needs a `main` claim; **server refuses any `planVaryOn` other than
`shotCount` with 422 `unsupported`** (D-110). No byte limit server-side (KnowScroll caps at 256 KiB).
Labels and criteria only — no sources, claim text or truth state ever cross (D-096).

**What the engine actually needs (learned from real runs, not in the schema):**

- **Sentence count.** `shotCountUnits` default `[4, 6]` (D-112): the planner forks a 4-unit and a
  6-unit plan and *both* groupings must be possible without splitting a sentence, or the run stops
  `rule:'split'` at 0¢ ("5 sentences cannot be cut into 6 units"). So **≥ 6 sentences; prefer exactly
  6** (one sentence per shot in the 6-unit plan; a 7th merges two sentences into one shot, possibly
  across claims — sunburn-v4 stopped that way). The schema's `min(4)` is misleading.
- **Total length.** `totalSecondsBounds: [35, 45]` (D-111) is a plan-score target.
- **Shot length → clip size.** Clip seconds = `min(15, max(5, ceil(narration seconds)))`
  (`packages/pipeline/src/clips/narration.ts`). Observed H3 768P takes are 9–22 MB each (seasons-v5);
  a **13.7 s clip at 33 Mbps = 56 MB exceeded MiniMax's witness limit of 52,428,800 bytes** (seasons-v4,
  run `393e116b…`: `400 "media exceeds size limit: max 52428800 bytes (2013)"`). Cutroom sends the clip
  as a **base64 data URL** to MiniMax-M3 (`providers/src/minimax/model.ts` `dataUrl`) and does not
  re-encode; whether MiniMax counts decoded or base64 bytes is not documented — base64 adds 33 %, so a
  ~37 MB file (≈ 9 s at 33 Mbps) is the safe ceiling either way. **Keep each sentence/shot ≲ 9 s.** This
  failure is classified `engine` (non-transient 400 → plain `Error` → `failureKindOf` = `engine`),
  so it is **never auto-resumed and not caller-resumable**.
- **P-001.** MiniMax `speech-2.8-hd` word timings can repeat a word at a sentence end ("Sun. Sun."),
  the timing parse refuses, run fails `unreadable` → auto-resumed → **the resume re-asks the same
  text and fails identically** (seasons-v3: `4e1e89ed…` 34¢ → resume `746a7a9c…` 0¢, both failed).
  Rule: **never end a sentence on "Sun"** (reword the end).
- **Gate 5 / scene rules** (all KnowScroll stops were Gate 5 or Gate 7): each claim's sentences name
  only its scene's subject, singular nouns (plural "clouds" fails the count rule), no lettered objects
  (harbour/boat → `never-text`), frame tall subjects from a distance (P-012), a shot with no approved
  picture (degraded or unplanned) is made from words and **cannot be held**, so its third failed take
  stops the reel. See upstream `docs/reel-pitfalls.md` (P-001…P-025) for the full brief-writing list.
- **Gate 7 coherence**: one judge call over 3 frames/shot asks: sensible order? pacing? does every shot
  sit well beside the next? do burned captions follow narration? Any "no" stops `rule:'gate-7'`
  (seasons-v2: a planet-from-space shot beside field shots). One place seen through time passes.
  (The repetition question was removed from Gate 7 by S-158; KnowScroll's own repetition gate is
  separate — §2.4.)

### 1.4 Idempotency (requestId)

`submitRun` (`packages/domain/src/runs.ts:97`) in one immediate SQLite transaction:
- stores the **raw received body text** (`run.request`) and `canonicalJson(parsed)` (keys sorted,
  `undefined` dropped);
- same `requestId` + **canonically equal** body → 202 `replayed:true` with the **newest** run for that
  id (so a replay after an auto-resume returns the resume run); spends nothing;
- same `requestId` + different content → 409 `conflict`;
- uniqueness: partial unique index `run.request_id WHERE resumes IS NULL` — resume runs share the
  requestId.
- Validation happens before the idempotency check, so an invalid body is 422 even if the id is known.

### 1.5 Run states and events

- `RunStatus{runId, requestId, state:'running'|'finished', lastSeq, resumes?, resumedBy?}` —
  `resumes`/`resumedBy` read from rows each time (S-162).
- `RunEvent` (each with `contractVersion, runId, seq(1..), at`): `run.accepted`;
  `stage.started|stage.finished {stage:'plan'|'stills'|'video'}`;
  `verdict {gate, outcome:'accept'|'accept_with_label'|'fail', shotId?}`;
  `degraded {shotId, reason}`; `run.finished {status}`. Gate ids (`GATE_ORDER`):
  `0, 1, 1S, 2, 3, 4, 5, 7` (no Gate 6). A completed video run has ~40–60 events.
- `RunResult` (terminal), all with `runId, requestId, costCents`:
  - `completed` + `until:'plan'` + `estimateCents`
  - `completed` + `until:'stills'` + `estimateCents, stills[{pictureId, shotId, path}], degradations[]`
  - `completed` + `until:'video'` + `estimateCents, stills[], video{path}, degradations[{shotId, reason}]`
  - `refused` `reason:'budget'` + `limit:'reel'|'ceiling', estimateCents, ceilingCents, capCents`
  - `stopped` `reason:'budget'` + the same four figures
  - `stopped` `reason:'rule'` + `rule` (`split`, `gate-0`, `gate-1`, `gate-2`, `gate-3`, `gate-5`,
    `gate-7`), `step` (`plan`/`video`/…), `detail`
  - `failed` + `detail` (failure **kind is not on the wire**; it is in Cutroom's `run.failure`
    column: `unavailable`, `unreadable`, `provider-failed`, `crashed` = resumable; `off-spec`,
    `engine` = never)
  - `cancelled`

### 1.6 Record (`record.ts`) — what the engine attests

`RunRecord{runId, pictures[], takes[], degradations[]}` (~2.5–5 KB):
- picture: `pictureId, shotId, chosen, keptFrom?, observationId?, reconciliationId?,
  checks[{gate:'1'|'1S', step?:'technical'|'text'|'witness'|'reconcile', outcome}]`
- take: `takeId, shotId, number, used, keptFrom?, observationId?, reconciliationId?,
  checks[{gate:'2'|'3'|'4'|'5', outcome}]`; `used` true exactly for the take each shot of a completed
  video shows; a held shot has no used take and appears in `degradations`.
- **Not in the record:** receipts, prompts, what the witness *saw*, per-call costs, the render
  manifest. They live only in Cutroom's SQLite (`model_receipt`, `generation_receipt`, `render`…).

### 1.7 Artifacts a finished run leaves (engine host)

`<CUTROOM_ARTIFACT_ROOT>/<runId>/` (VPS: `/srv/knowscroll/cutroom-pool/artifacts/<runId>/`, mode
0640 group `ks-pool`), e.g. seasons-v5 run `a3e69f72…`:
`a1-shot-N-{a,b,single}.jpg` (stills), `a1-shot-N-narration.mp3`, `a1-shot-N-take-K.mp4` (every take,
9–22 MB each), `a1-render.mp4` (the reel, **the only file `result.video.path` names**),
`a1-render.ass` (captions), `a1-render-frame-0..17.png` (Gate 7 frames). `a<attempt>` prefixes ids, so a
re-run job renders `a2-…`. Output profile (D-055): MP4, H.264, AAC, **768×1366, 24 fps, 48 kHz
stereo**, moov-first. No manifest file is written beside it; no checksum is published.
Upstream promises **no retention**; nothing cleans these up either (VPS: 1.2 GB for 13 runs).

### 1.8 Resume

- **Caller resume** `POST /v1/runs/:runId/resume` with
  `ResumeRequest{contractVersion, remake?: [{kind:'still'|'narration'|'clip', shot?:'shot-<n>'}], preview?: true}`.
  Preview (200) is free and writes nothing; it returns `remake, estimateCents, spentCents, capCents,
  ceilingCents, limit?`. Admitted → 202 `{outcome:'accepted', runId:<new>, resumes:<old>, replayed}`.
  A caller may resume the four resumable failure kinds and a Gate 7 stop. At most once per run; a
  resume is never resumed.
- **Engine auto-resume** (the service always turns it on): a run failed by `unavailable`,
  `unreadable`, `provider-failed` or `crashed` is resumed **once, inside the transaction that fails
  it**, keeping every checked piece (`keptFrom`), with jobs **due `CUTROOM_RESUME_DELAY_MS` later
  (default 900 000 = 15 min; min 0; no off switch)**. The new run row exists immediately in state
  `running`, so `GET ?requestId=` returns it at once and the failed run's status shows `resumedBy`.
  Admission uses `estimateCents = spent so far + resume estimate` against the per-reel cap and the
  original `budgetCents` ceiling; over the cap → a `QUESTIONS.md` entry, no run; over the ceiling →
  silently not resumed.
- Each run's `costCents` is **its own** spend only; a chain's true cost is the sum.

### 1.9 Cost reporting and budget

- `costCents` = generation spend only, at **configured rates**, rounded up: image entry rate per call
  (VPS: `fal-ai/flux-2-pro/edit` at **7.5¢**), video **0.5¢/s of requested seconds** (H3 Turbo 768P;
  "≥16× what fal billed", S-155), narration **0¢** (`narrationRateCentsPerCharacter: 0`; MiniMax
  token plan), model calls 0. Planning is free (a plan-only run costs 0).
- `estimateCents` = ⌈planned image calls × image rate + total shot seconds × video rate⌉ with **no
  repairs/retakes**, so reported cost routinely exceeds the estimate (sunburn-v2 52 vs 42, tides-v4
  58 vs 48).
- Two budgets: **per-reel cap** from the `Per reel, all-in` row of the markdown file
  `CUTROOM_BUDGET_PATH` (repo default $3.00; VPS file set to **75¢** per the #199 plan — file not read,
  it is under the forbidden `/etc/knowscroll-cutroom/`), and the **caller ceiling** `budgetCents`.
  Guards run before every paid call (`guardedImagePort`, video/narration guards). Cap refusals/stops
  append to `QUESTIONS.md` (not on the wire except as `refused/stopped budget limit:'reel'`).

### 1.10 Settings and provider configuration (names only)

`apps/service/src/settings.ts` `SETTING_NAMES` + `providers/src/env.ts`:
`CUTROOM_ENV_FILE`, `CUTROOM_DB_PATH`, `CUTROOM_ARTIFACT_ROOT`, `CUTROOM_QUESTIONS_PATH`,
`CUTROOM_BUDGET_PATH`, `CUTROOM_API_PORT`, `CUTROOM_LEASE_MS`, `CUTROOM_LEASE_FLOOR_MS`,
`CUTROOM_STAND_IN_SCRIPT`, `CUTROOM_MINIMAX_BASE_URL`, `CUTROOM_FAL_BASE_URL`,
`CUTROOM_FAL_STORAGE_BASE_URL`, `CUTROOM_FAL_IMAGE_MODEL`, `CUTROOM_NARRATION_VOICE`,
`CUTROOM_PICTURES` (`upToThree` default in service | `recurring`), `CUTROOM_RESUME_DELAY_MS`,
`CUTROOM_PROVIDER_{MODEL,IMAGE,SENSOR,VIDEO,NARRATION}` (default `fake`; real = `minimax`, `fal`,
`local`, `fal`, `minimax`). Keys: **`MINIMAX_API_KEY`**, **`FAL_KEY`** (KnowScroll's product `.env`
calls it `FAL_AI_KEY`). Models: planner `MiniMax-M2.7`; reconciler/witness/judge `MiniMax-M3`;
narration `speech-2.8-hd`; video `fal-ai/minimax-h3-turbo/{image,text}-to-video` 768P, 5–15 s;
image registry of four (default `flux-2-pro/edit`). Lease with real adapters = 4 h floor
(18 clips × 10 min fal wait + 1 h); nothing renews a lease, so a crash mid-run re-claims after 4 h and
can **pay again for the take in flight**.

### 1.11 SDK

`@cutroom/sdk` 1.0.0 (tarball only, not on a registry): `createCutroom({baseUrl, launcher?,
readyTimeoutMs?})` → `submit/find/status/follow/result/record/cancel/resume/close`. It validates with
the contract and **re-serialises the request** (`JSON.stringify(parsed.data)`,
`packages/sdk/src/index.ts:551`), so it cannot send caller-stored exact bytes. KnowScroll correctly
keeps its own client.

---

## 2. How today's KnowScroll integration works (origin/dev `106c4701`)

Decisions: ADR-0007 (separate HTTP service), ADR-0020 (pinned client), ADR-0021 (successor pin, local
host), **ADR-0023** (bounded jobs + verified import), **ADR-0024** (publication gates + media serving),
ADR-0025 (eligible Reels minted into inventory), **ADR-0050** (shared Reel pool, amended to $7).
Plan docs: `docs/plans/cutroom-integration/{00-status,01-product,02-architecture}.md` + research
`research/2026-10-07-cutroom-upstream-and-knowscroll.md`.

### 2.1 End-to-end flow

```
content/reel-scripts/<name>.json  (owner-approved in its PR; brief + approval ref)
   │ seed loader → generation_brief (review_state=approved)          packages/db/src/generation/reel-scripts.ts
   ▼
ks run <world> generation-cli order --brief-id … --grant-id … --approval-ref … [--until plan]
   │ operator.ts: digest = scriptDigest(brief, until)                packages/core/src/cutroom/pool-identity.ts
   │   take = pool_next_take(digest); requestId = ks-reel-<digest[0:32]>-<take>
   │   prepared = prepareCutroomRequest(compileSubmitRequest(brief, requestId, until, ceiling))
   │   pool_claim(requestId, digest, take, until, body_sha256, world, ceiling, approvalRef)   knowscroll_pool
   │     → claimed | already_ordered | cap_exceeded | take_taken (retry next take)
   │   world admission (one tx): reserve ceiling on generation_budget_grant; insert generation_job +
   │     cutroom_attempt{request_id, request_body (exact bytes), body_sha256, contract_revision, state=prepared}
   ▼
ks-generation@<world>  (apps/worker/src/generation/worker.ts, one process per world)
   │ claimJob (lease 30 s, fence) → authorizeDispatch (prepared→dispatch_committed, no network)
   │ reprepareOrThrow(stored bytes) must reproduce requestId + sha256, else defect
   │ client.submit(prepared) → accepted(runId, replayed) | refused(409/422) | unknown(transport/protocol/5xx)
   │ unknown → lookup(requestId) first; only an observed 404 permits ≤3 identical-bytes resends; else park needs_operator
   │ followToTerminal: page events from persisted cursor, store each (attempt, seq), renew lease each loop
   │ result + record fetched and stored; if result=failed and status.resumedBy → attempt #2 role=resume, keep following
   │ completed video → handleImport; anything else → settle (reported cost → spent, rest released)
   ▼
verified import (apps/worker/src/generation/import.ts + media-store.ts + import/probe.ts)
   │ engine path absolute; realpath strictly inside engine artifact_root; lstat regular file (no symlink);
   │ 0 < size ≤ 512 MiB; stream-copy to KS_MEDIA_ROOT/tmp while sha256-hashing; fsync;
   │ ffprobe: mp4 (not qt brand), H.264, AAC if audio, 9:16 ±2 %, 5–120 s, moov before mdat;
   │ atomic rename to sha256/<aa>/<bb>/<sha>.mp4 (idempotent if present)
   │ media_object + generated_reel(availability=imported, provider_mode, lineage{briefSha256,
   │   contractRevision, runId, recordSummary}) committed together; THEN settle; job completed
   ▼
publishImportedReels (same worker, every pool sync, when KS_AUTO_PUBLISH_POLICY=publication-v2)
   │ evaluatePublicationGates(decide:'auto'): lineage_complete, source_support, engine_record,
   │   media_conformance (re-probe), truth_label, repetition, witness_alignment (engine-attested)
   │ all pass/pass_with_label → availability eligible → mintReelAsset → asset(kind='Reel', title, summary,
   │   media_sha256, generated_reel_id) ; a refused Reel stays imported and is not re-judged
   ▼
playback: API `GET|HEAD /v1/media/:sha256` serves KnowScroll-owned bytes only (bearer auth, Range/206,
immutable private caching; never the engine path — ADR-0024 §4); web ReelPlayer / Android ReelScreen show
"Engine-checked" + readWhy check summary (PR #205)

syncSharedPool (every 60 s): settle finished orders into knowscroll_pool; for every completed video order
whose approved script this world holds but whose requestId it has never seen, recompute the body sha
and, only if equal to pool body_sha256, create a receive job (no grant, never sends; lookup→follow→import
→ release at 0¢; deadline 30 days).
```

### 2.2 Records that exist today (world DB, migration 0013 + 0042 + 0043; pool DB `pool-migrations/0001,0002`)

| Table | Role | States |
|---|---|---|
| `cutroom_engine` | registered loopback origin, pinned contract revision, artifact root, declared provider mode | active / retired |
| `generation_brief` | immutable editorial brief, sha256, review state | draft → approved |
| `generation_budget_grant` | cap / reserved / spent / overage, authorization ref, expiry | overage pauses admission |
| `generation_live_cap` | per-world live cap (≤700 by CHECK) | — |
| `generation_job` | the business run: brief, engine, grant, until, ceiling, lease+fence, deadline, cancel | queued, dispatching, following, importing, completed, refused, stopped, failed, cancelled, needs_operator |
| `cutroom_attempt` | the external attempt: requestId, **exact body bytes + sha256**, contract rev, run_id, cursor, result, record_summary, reported cost, `role` order/resume/receive, `ordinal` | prepared, not_sent, dispatch_committed, accepted, refused, unknown, finished; settlement held/released/settled |
| `cutroom_event` | every event `(attempt, seq)` immutable | — |
| `media_object` | sha256 PK, size ≤512 MiB, probe, storage_key `sha256/aa/bb/<sha>.mp4` | immutable |
| `generated_reel` | attempt, brief, run id, media, untrusted engine path, provider mode, lineage | imported → eligible / test_eligible / withdrawn (0014) |
| `publication_policy`, `publication_gate_result` | policy versions (`publication-v1`, `-v2`) and immutable gate verdicts | — |
| `asset` (kind `Reel`) | inventory item minted from an eligible generated_reel | withdrawn_at |
| pool: `pool_budget`, `pool_order` | shared cap; one row per paid order (request id = digest+take, body_sha256, ordered_by, ceiling, approval_ref) | claimed → settled / released; committed = settled spend + open ceilings ≤ cap |

### 2.3 What is good and should be retained conceptually in v2

1. **Content-derived request identity** (`ks-reel-<sha256(wire fields minus requestId and ceiling)[0:32]>-<take>`):
   any world/process can find a Reel by its script; a retry after a failure is a *new take*, never a
   replay of the failure. Keep; but see §4 on including the ceiling in the bytes.
2. **Exact stored request bytes + sha256 before dispatch, and re-prepare-must-match** (ADR-0023 §3):
   a restarted worker can never build a second, different paid request. This is exactly the
   blueprint's "request bytes stored before dispatch".
3. **Dispatch commit before I/O (`dispatch_committed`)**, unknown → **lookup by requestId first**, never
   blind resend. Cutroom's replay semantics make an identical-bytes resend safe *for Cutroom*
   (it is not a provider call), which is the one place a bounded resend is legitimate.
4. **Resume-chain settlement**: follow `resumedBy`, record each run as its own attempt row
   (`role=resume`), settle the **sum** once the chain ends. Verified live: seasons-v3 chain
   `4e1e89ed…`(34¢) → `746a7a9c…`(0¢) settled 34¢.
5. **Budget hold/settle with recorded overage, never clamped** (ADR-0012), plus a **global shared
   ledger outside any world DB** (`knowscroll_pool`, SECURITY DEFINER functions, row immutability,
   cap CHECK, committed = settled + open ceilings). Survives world resets.
6. **Approval per script, recorded with the claim** (approval_ref), and **plan-stage rehearsal at 0¢**
   before any paid order (catches `split` and planner failures free).
7. **Verified import**: containment against the registered artifact root, regular-file check,
   hash-while-copy, ffprobe profile, content-addressed atomic install, idempotent re-import.
8. **Event log stored per attempt with cursor**, result + record snapshots stored, so publication can
   be judged from KnowScroll's own copy without asking Cutroom again.
9. **Engine-attested witness labelled as such** (`pass_with_label`, "engine-attested, not
   independent", observation ids as evidence) and `engine_record` (a used take with a failing check
   fails; degradations label).
10. **Never touch Cutroom**: run upstream's own service at a pinned commit, configure only documented
    settings; stdin FIFO + SIGINT; refuse restart while an order is open.

### 2.4 What is tied to the old schema and must be rewritten

- **All storage** (`packages/db/src/generation/storage.ts` 1,981 lines, `packages/db/src/pool/ledger.ts`,
  migrations 0013/0014/0015/0042/0043/0044, pool-migrations) is Postgres-schema-specific to the old
  monolith (pg + hand SQL, `knowscroll_test_*` DB-name conditions in triggers, `test_eligible`
  restricted to standin).
- `generation_job` + `cutroom_attempt` **fuse** the queue delivery (lease/fence in the job row,
  bespoke `claimJob` polling loop) with the business run and the attempt. v2 splits these three
  (pg-boss delivery, `production.run`, `attempts.provider_attempt`).
- `cutroom_attempt.ordinal CHECK (ordinal = 1)` relaxed ad hoc for resume; the resume run is modelled
  as a second attempt of the same request id although it is *not a new dispatch* (no request was
  sent). In v2 a Cutroom auto-resume is an **observed remote continuation of one dispatch**, not a new
  ExternalAttempt.
- `generation_brief` is tied to one old `asset` revision (`claimSources` one Scroll revision) and to
  `truth_state='synthesis'`; the brief schema (`packages/contracts/src/generation.ts`) carries
  `title/summary` for minting. v2 content model (explanation unit, immutable asset revisions,
  variants) replaces it.
- Publication: `publication-v1/v2` policy rows, the 7 gates and their verdict tables, the repetition
  fingerprints (template = claim-count-per-sentence/roles/criteria types/style; argument = sources +
  sorted normalised narration) scoped **per database**; `asset(kind='Reel')` minted with
  `media_sha256`. v2's admission gates and `PublishedEncounter` replace these.
- Media: `KS_MEDIA_ROOT/sha256/aa/bb/<sha>.mp4` keyed by sha only (no media id/revision/backend
  columns); v2 wants a `MediaStore` port with logical keys + `(media id, key, backend, checksum,
  size, MIME, revision)`.
- Process wiring: env names `KS_MEDIA_ROOT`, `KS_DEV_ROOT`, `KS_POOL_DATABASE_URL`, `KS_WORLD`,
  `KS_AUTO_PUBLISH_POLICY`, `GENERATION_HOLD_BEFORE_SUBMIT`; operator CLI `scripts/generation.ts` /
  `ks run <world> generation-cli …`; `ks-generation@<world>` systemd unit.
- The vendored contract copy (`packages/contracts/src/cutroom-v1/*`, `source.json` pin) and the
  hand-written client (`apps/worker/src/cutroom/http-client.ts`, 417 lines; no `resume` or `ready`
  calls) can be carried over almost verbatim into a v2 `CutroomPort` adapter.

### 2.5 Hazards already learned (keep these as tests/guards in v2)

| Hazard | What happened / why | Guard |
|---|---|---|
| **Auto-resume spend** | Service always resumes `unavailable/unreadable/provider-failed/crashed` failures once after 15 min; each run reports only its own cost; lookup by requestId returns the newest run | Follow `resumedBy`, settle the chain's sum; never settle a `failed` result until status is read (worker throws if status is unavailable) |
| **Resume can repeat a deterministic failure** | P-001 resume re-asked the same narration text and failed the same way (0¢ extra this time, but a resume can also re-buy clips) | Brief rule; treat a failed chain as terminal; a new take only after a script edit |
| **SDK re-serialises requests** | `@cutroom/sdk` sends `JSON.stringify(parsed.data)`, not caller bytes | Own client; send stored bytes. Note KnowScroll's `prepareCutroomRequest` also re-serialises via zod (`JSON.stringify(parsed.data)`), so the bytes depend on the zod version and vendored schema — a receiving world **recomputes** them and compares to `body_sha256` (`request_bytes_differ` refusal). v2 should store the bytes once and read them, never recompile |
| **56 MB clip > MiniMax witness limit** | 13.7 s clip at 33 Mbps; `engine` failure, not resumable; 33¢ lost | Script rule: shots ≲ 9 s; v2 brief linter estimates seconds per sentence (~2.5 words/s) and refuses >9 s; upstream fix would be re-encode before witness (owner: don't touch Cutroom) |
| **P-001 "Sun." repeated word** | MiniMax T2A timings repeat the last word; parse fails; 34¢ lost | Linter: no sentence may end on "Sun"; broaden to a watch-list |
| **Split rule** | 4 or 5 sentences cannot be cut into 6 units: stopped at 0¢ | Linter: ≥6 sentences, prefer exactly 6 |
| **Repetition-fingerprint gate** (ADR-0024, owner chose "B: keep the rule" 2026-10-09) | All 4-scene scripts shared template `3d8d42d5…`; tides-v2 and sunburn-v2 were made (43¢ + 52¢) and **refused in both worlds** — 95¢ of completed Reels unpublished | Check the template + argument fingerprint against the corpus **before ordering**, not after; vary scene/sentence counts, not claim roles |
| **Gate 5/7 stops** | 7 of 14 video orders stopped (46–66¢ each) on wording: plural nouns, lettering, scene mixes | Brief-writing rules; plan rehearsal does not catch these (they are clip-stage) |
| **Unreadable budget file** | First plan rehearsal failed `EACCES` on `/etc/knowscroll/cutroom-pool.budget.md`; moved to `/etc/knowscroll-cutroom` (#212) | Startup self-check that the cap file is readable by the service user |
| **Lease re-claim double pay** | Nothing renews Cutroom's 4 h lease; a crash/restart mid-run re-claims and can re-buy the take in flight | Never restart `ks-cutroom@pool` while an order is open (`ks` refuses); v2 ops must keep this |
| **No auth** | Any local process can POST paid work | Only the production worker holds the origin; consider a dedicated network namespace/socket ACL for the v2 box |
| **Paths, not bytes; no retention** | Result names an absolute engine-host path; artifacts are never cleaned | Import immediately; v2 must run on the same host (or add a copy step); plan artifact GC after import |
| **Cost overshoots estimate** | Repairs/retakes not in the estimate (52 vs 42) | Ceiling = per-reel cap (75¢), not the estimate |
| **Reported ≠ real money** | Video rate is a wide margin over fal's billing; narration/model at 0 | KnowScroll's count is an upper bound on fal spend; real balance must be read on fal |

---

## 3. Live state on the VPS (read 2026-10-19 ~12:50 UTC, read-only)

### 3.1 Cutroom service

- Unit **`ks-cutroom@pool.service`**: `active (running)` since **2026-10-17 18:19:33 UTC**, NRestarts 0,
  ~184 MB RSS, slice `ks-cutroom.slice`, user `ks-cutroom`, `SupplementaryGroups=ks-pool`,
  `KillSignal=SIGINT`, `EnvironmentFile=/etc/knowscroll/cutroom-pool.env` (not read),
  `CUTROOM_ENV_FILE=/dev/null`, `ExecStart=/usr/local/lib/knowscroll/cutroom-run` (FIFO stdin, refuses
  a real narration port with the `stand-in` voice). Template: `ops/vps/ansible/roles/cutroom/templates/`.
- Code: `/srv/knowscroll/cutroom/current → releases/94ee04a1c48069c293203de326d4801360ca6158`
  (installed 2026-10-07). Upstream `main` is 94ef335 — wire-identical (§0).
- `GET http://127.0.0.1:8797/v1/ready` → **200 `{"contractVersion":1,"ready":true}`**.
- Startup banner (journal; prints no keys):
  `database /srv/knowscroll/cutroom-pool/data/cutroom.sqlite` (1.8 MB) · `artifacts /srv/knowscroll/cutroom-pool/artifacts` (1.2 GB, 13 run folders) ·
  `questions /srv/knowscroll/cutroom-pool/QUESTIONS.md` (**file does not exist** → no cap question ever asked) ·
  `providers model=minimax image=fal sensor=local video=fal narration=minimax` ·
  `minimax https://api.minimax.io` · `fal https://queue.fal.run https://rest.alpha.fal.ai` ·
  `image fal-ai/flux-2-pro/edit at 7.5 cents` · `video 0.5 cents a second` · `voice English_Graceful_Lady` ·
  `pictures upToThree` · `lease 14400000 ms` · `listening http://127.0.0.1:8797`.
- Other units: `ks-api@{dev,stage}`, `ks-worker@{dev,stage}`, `ks-maintenance@{dev,stage}`,
  `ks-generation@{dev,stage}` all running; `ks-disk-guard.timer` (pauses generation + Cutroom under disk
  pressure), `ks-cleanup.timer`. Disk: 9.4 G of 96 G used. No order is open.
- Both worlds register the same engine (`http://127.0.0.1:8797`, rev `94ee04a1`, artifact root
  `/srv/knowscroll/cutroom-pool/artifacts`, mode `live`): dev `5e2b95ee…`, stage `2af092ee…`.

### 3.2 Money

**Shared pool (`knowscroll_pool`, `SELECT` as postgres):** `cap 700¢` ("owner decision 2026-10-09
(#199): $7 total for dev and stage") · **committed 617¢ · left 83¢** · 0 open claims.

19 orders, all by `dev`, all settled:

| Script (worldId) | until | outcome | ¢ | Cutroom run | note |
|---|---|---|---:|---|---|
| tides | plan | failed | 0 | f2e12d89 | `EACCES` on the old budget-file path |
| tides / seasons / greenhouse / sunburn | plan | completed ×4 | 0 | 9c6e3a9b, 48675aec, fc30a9ba, 449660ca | rehearsals |
| tides | video | stopped gate-5 | 65 | 203afb53 | "harbor" not shown; `never-text` |
| seasons | video | stopped gate-5 | 57 | 97249cb1 | "planet" not shown |
| **greenhouse** | video | **completed** | 48 | **6a12af96** | published |
| sunburn | video | stopped gate-5 | 66 | 1ec13427 | "clouds" count |
| tides-v2 | video | completed | 43 | 9b4878df | **refused by repetition gate** (both worlds) |
| seasons-v2 | video | stopped gate-7 | 46 | 5caac8e7 | order / sit-beside |
| sunburn-v2 | video | completed | 52 | 16aed9af | **refused by repetition gate** (both worlds) |
| seasons-v3 | video | failed (P-001) | 34 | 4e1e89ed → resume 746a7a9c (0¢) | auto-resume chain, both failed |
| seasons-v4 | video | failed (witness 52,428,800 B limit) | 33 | 393e116b | `engine`, not resumed |
| tides-v3 | video | stopped split | 0 | e5800d9e | 5 sentences |
| **seasons-v5** | video | **completed** | 51 | **a3e69f72** | published; first fully automatic |
| sunburn-v3 | video | stopped split | 0 | 9f09e4ef | 4 sentences |
| **tides-v4** | video | **completed** | 58 | **8620f77d** | published |
| sunburn-v4 | video | stopped gate-5 | 64 | 51b9ddb5 | 7 sentences merged snow/sand |

Totals: 14 paid video orders, 5 completed (36 %), 3 published (21 %); ≈ 49–58¢ per completed reel,
≈ 46–66¢ per stop; 617¢ reported for 3 published reels ≈ **2.06 $/published reel** at this yield.

**World grants (`generation_budget_grant`):**
- dev: `f5807b55…` live, cap 500, spent 444 → **56 left**; `6f2e217e…` live, cap 200, spent 173 →
  **27 left**; `generation_live_cap` = 700. Jobs: 9 completed, 7 stopped, 3 failed.
- stage: `263fdd2c…` live, cap 500, spent 0 (stage only received); live cap 500. Jobs: 5 completed
  (all receives).
- So the next order can reserve at most **min(83 pool, 56 grant) = 56¢** without new grants — below the
  75¢ ceiling the scripts were ordered at.

**fal balance:** not readable without the provider key (forbidden here). Last recorded value **$2.61
on 2026-10-09**, read before the #219 orders (tides-v4 58¢ + sunburn-v4 64¢ reported); real fal spend is
below the reported figure (video at a wide margin; flux-2-pro at its listed rate), so the balance is
somewhere under $2.61. The owner must read it on fal before any paid run. MiniMax (planner, witness,
judge, narration) runs on the token plan, reported at 0¢.

### 3.3 Published reels and where their bytes are

All five completed reels were imported into **both** worlds (stage received at 0¢); checksums of the
Cutroom `a1-render.mp4` equal the imported `media_object.sha256`. Probe of seasons-v5:
h264 768×1366 24 fps ~4.8 Mb/s + AAC 48 kHz stereo, 25.75 s.

| Reel (asset title) | Script | Cutroom run → engine file | Media key (both worlds) | Size / dur | dev asset | stage asset | gates (v2) |
|---|---|---|---|---|---|---|---|
| A blanket made of gas | greenhouse | `6a12af96…/a1-render.mp4` | `sha256/81/41/8141851517b5….mp4` | 11.95 MB / 41.5 s | `1711ee25…` | `89f6fcab…` | engine_record pass, repetition pass, witness pass_with_label |
| Tilt, not distance, makes the seasons | seasons-v5 | `a3e69f72…/a1-render.mp4` | `sha256/7e/85/7e851851….mp4` | 16.0 MB / 25.8 s | `91817f46…` | `f05c1fbb…` | pass / pass / pass_with_label |
| The Moon moves the sea | tides-v4 | `8620f77d…/a1-render.mp4` | `sha256/9d/f7/9df78130….mp4` | 7.79 MB / 27.2 s | `91eb944d…` | `53c6eb8c…` | pass_with_label (1 degradation) / pass / pass_with_label |
| (unpublished) | tides-v2 | `9b4878df…` | `sha256/12/41/1241cfef….mp4` | 10.7 MB / 33.3 s | — (`imported`) | — | **repetition fail** |
| (unpublished) | sunburn-v2 | `16aed9af…` | `sha256/9c/c5/9cc5306c….mp4` | 7.43 MB / 41.3 s | — (`imported`) | — | **repetition fail** |

- World media roots: `/srv/knowscroll/dev/media/` and `/srv/knowscroll/stage/media/` (each a full
  copy, content-addressed); engine originals stay under `/srv/knowscroll/cutroom-pool/artifacts/<runId>/`
  with every still, narration, take and Gate 7 frame.
- `generated_reel` ids: dev `8ceba784…` (greenhouse), `7502a52b…` (seasons-v5), `32adc80e…` (tides-v4),
  `9d447ec1…`, `81c74974…` (imported only); stage `3e9227f9…`, `f4d022c1…`, `e4afb5d5…`, `7d0cdf4f…`,
  `905cf59e…`.
- Reel scripts on dev: `content/reel-scripts/{greenhouse,seasons,seasons-v2..v5,sunburn,sunburn-v2..v4,tides,tides-v2..v4}.json`
  (each: id, authoredBy, approval{ref, approvedBy, approvedAt}, brief{version, worldId, narration,
  claims, claimSources, criteria, style, title, summary}).

---

## 4. v2 integration proposal

Grounding: v2 blueprint `docs/v2/architecture/02d-greenfield-blueprint.md` (worktree
`knowscroll-worktrees/v2-release`, branch `codex/release-knowscroll-v2`): §"Three execution records"
(QueueDelivery / BusinessRun / ExternalAttempt), the attempt state diagram
(`reserved → not_sent | dispatched → succeeded | failed | unknown → reconciled | written_off`),
"Local media now, cloud storage later" (`MediaStore`), and the owner's 2026-10-19 architect brief
(`~/Desktop/reports/KnowScroll blueprint changes for the architect.md` items 4, 9, 11, 19). Constraint
carried over from #199: **Cutroom is not modified**; KnowScroll hands it a brief and takes the reel back.

### 4.1 Where Cutroom sits

- Module **`production`** owns Reel commissioning. Its `application/ports.ts` declares `CutroomPort`
  (external seam, blueprint item 4) and uses the shared `attempts` ledger and `MediaStore` port.
- Adapter `production/adapters/cutroom-http.ts` = today's `apps/worker/src/cutroom/http-client.ts`
  plus `ready` (and, owner-gated, `resume`), over the vendored contract copied byte-for-byte from
  `packages/reel-contract/src/*.ts` at a recorded revision (`94ee04a1…`; identical at `94ef335`), with a
  test that recomputes the nine sha256s (as `cutroom-v1/source.json` does today).
- Only the worker process holds the Cutroom origin. The API never calls Cutroom.

### 4.2 `CutroomPort` — the minimal adapter contract

```ts
// production/application/ports.ts (proposal)
type RequestId = Brand<string, 'CutroomRequestId'>  // ks-reel-<32 hex>-<take>
type RunId = Brand<string, 'CutroomRunId'>
type StoredRequest = { requestId: RequestId; bytes: Uint8Array; sha256: string; contractRevision: string }

type Uncertain = { kind: 'uncertain'; code: 'timeout'|'network'|'aborted'|'protocol'|'remote_500' }
type Unreachable = { kind: 'unreachable'; code: 'timeout'|'network'|'protocol' }   // GETs: never a write

interface CutroomPort {
  ready(signal): Promise<{ ready: boolean } | Unreachable>                       // GET /v1/ready
  /** Sends exactly `req.bytes` once. No retries inside. */
  commission(req: StoredRequest, signal):
    Promise<{ kind: 'accepted'; runId: RunId; replayed: boolean }                // 202
          | { kind: 'refused'; reason: 'conflict'|'version'|'invalid'|'unsupported'; detail: string } // 409/422: no run exists
          | Uncertain>
  lookup(requestId, signal): Promise<{ kind: 'found'; status: RunStatus } | { kind: 'absent' } | Unreachable>  // newest run
  status(runId, signal): Promise<RunStatus | Unreachable>                       // resumes / resumedBy
  events(runId, since, signal): Promise<EventsPage | Unreachable>               // strictly increasing seq, run.finished last
  result(runId, signal): Promise<{ kind: 'final'; result: RunResult } | { kind: 'running' } | Unreachable>
  record(runId, signal): Promise<{ kind: 'final'; record: RunRecord } | { kind: 'running' } | Unreachable>
  cancel(runId, signal): Promise<RunStatus | Unreachable>                        // idempotent flag
  previewResume?(runId, remake): Promise<ResumePreview | Unreachable>           // free; owner tooling only
  /** Local-filesystem half: Cutroom returns host paths, not bytes. Containment-checked. */
  openArtifact(path: string): Promise<{ stream: Readable; size: number } | { kind: 'refused'; reason: ImportRefusal }>
}
```

Pure helpers beside it (domain, no I/O):
- `requestIdentity(brief, until)` = today's `scriptDigest` + `poolRequestId` (sha256 of the canonical
  wire request minus `requestId` and `budgetCents`; take 1..999).
- `compileRequest(brief, requestId, until, ceilingCents) → bytes` — run **once** at admission; the
  bytes are then stored and only read (never recompiled, unlike today's receive check).
- `foldChain(runs: Array<{status, result?}>) → { terminal: boolean, finalRunId, outcome, totalCostCents }`
  following `resumedBy` until a run has no `resumedBy` and is `finished`; cost = Σ `costCents` over
  distinct runIds.
- `artifactManifest(result, record, engineRoot)` — Cutroom writes no manifest, so we derive one:
  `{ finalRunId, video: path, stills[], usedTakes[{shotId, takeId, gates}], chosenPictures[…],
  degradations[], chain[runIds], costCents }`.

### 4.3 Mapping onto the three blueprint records

| Record | v2 owner/table | Cutroom specifics |
|---|---|---|
| **QueueDelivery** | pg-boss | `production.commission {v, runId}` **retryLimit 0** (dispatch is guarded by the ledger, a redelivery re-reads it); `production.follow {v, runId}` retries freely (GETs only) and **re-schedules itself with `startAfter`** (e.g. 30 s, and ≥15 min when a run is waiting on Cutroom's auto-resume) instead of holding a lease for 13–41 min; `attempts.reconcile {v, attemptId}` 10 retries, long backoff; `production.import {v, runId}`. |
| **BusinessRun** | `production.run` (kind `reel_commission`) | brief revision + sha, `request_identity` (digest, take, until), ceiling, approval ref, script lint verdict, `cutroom_chain` (ordered runIds with `resumes`), `event_cursor` per runId, stored result/record snapshots, state: `queued → admitted → commissioning → generating → remote_finished → importing → admitting → applied` or `rejected` (gates) / `stopped` / `failed` / `cancelled` / `stale`. A Cutroom auto-resume is a **continuation inside one run** (`generating` with a new runId appended), not a new run. |
| **ExternalAttempt** | `attempts.provider_attempt` (provider `cutroom`, op `commission`) | One row per POST `/v1/runs` (or POST `/resume`). Request hash + protected bytes ref, reservation = ceiling, dispatch identity = **requestId**, remote id = first runId. Liability is the whole remote chain, so the attempt also carries `settled_cents` filled when the chain is terminal. |

Attempt state machine for a Cutroom commission:

| State | Enter when | Money |
|---|---|---|
| `reserved` | admission tx: global supply ledger claim (today's `pool_claim`) + env budget hold + stored bytes | ceiling held |
| `not_sent` | cancel/deadline/lint-failure before dispatch commit | released |
| `dispatched` | committed in its own tx **before** the POST (fence, run not cancelled, engine `ready`) | held |
| `succeeded` | 202 (incl. `replayed:true`) → runId recorded; run → `generating` | held until chain terminal, then **settled = Σ chain costCents** (overage recorded, never clamped; pauses admission) |
| `failed` | 409/422 definite refusal (no run exists) | released |
| `unknown` | timeout/network/protocol/500 after the request may have left | held |
| `reconciled` (→ `_succeeded`) | `attempts.reconcile`: `lookup(requestId)` finds a run → same as `succeeded` | as succeeded |
| `reconciled` (→ `_failed`) | lookup answers 404 **and** `/v1/ready` is 200 on the same engine identity → Cutroom never committed it | released; the run may admit a **new attempt with the same requestId and the same bytes** (Cutroom replay makes this safe: if the first POST did land late, it replays, spends nothing) |
| `written_off` | engine unreachable past the liability deadline (operator decision) | ceiling recorded as written-off liability |

This keeps the blueprint rule "an unknown attempt is never resent": the only send after an unknown is
a *new admitted attempt* after a conclusive 404, and Cutroom's requestId idempotency removes the
double-charge risk that rule exists for. A caller-initiated `POST /resume` (selective remake) is always
a separate, owner-gated ExternalAttempt with its own reservation (`previewResume` first, free).

Run-level settlement: when `foldChain` says terminal, in **one transaction** write the final
result/record snapshot, move the attempt reservation to `settled_cents` (Σ chain), settle the global
supply ledger row (`pool_settle` equivalent), and enqueue `production.import` (completed video) or
close the run. **Never settle a `failed` result before reading `status.resumedBy`** (if status is
unreachable, retry later).

### 4.4 Import validation (before anything enters `MediaStore` as ready)

1. Result `status='completed'`, `until='video'`, `requestId` and `runId` equal the chain's final run;
   `video.path` matches `<engineRoot>/<finalRunId>/a<n>-render.mp4`.
2. Record checks ("witness labels"), same rule as `evaluateEngineAttestedWitness` + `evaluateEngineRecord`:
   every `chosen` picture has an accepting Gate `1` (steps technical, text, witness, reconcile) and,
   if derived, `1S`; every `used` take has accepting `2,3,4,5`; no failed check on any chosen/used
   piece; ≥1 used take; each shot has a used take **or** a degradation (held shot); `keptFrom` only names
   runs in this chain. Evidence kept: observation/reconciliation ids, labelled "engine-attested, not
   independent".
3. File: path realpath strictly inside the registered engine artifact root; `lstat` regular file (no
   symlink); size `0 < n ≤ 64 MiB` (observed 7.4–16.0 MB; today's 512 MiB ceiling is far above need).
4. Stream-copy into `MediaStore` temp object while computing sha256; fsync; ffprobe the staged copy:
   MP4 (not `qt`), H.264 + AAC, **768×1366** (accept 9:16 ±2 % as today), 24 fps, 48 kHz stereo,
   duration 20–60 s (observed 25.8–41.5 s; Cutroom targets 35–45 s), `moov` before `mdat`.
5. Atomic finalise at the logical key; record `media_object(id UUIDv7, logical_key, backend='local',
   location, sha256, size, mime 'video/mp4', revision, probe)`. Idempotent by sha256.
6. Optional extra: copy `a1-render.ass` (captions) as a sibling media object if v2 wants selectable
   captions (today they are burned in).

### 4.5 Admission into the v2 content inventory

- A completed, imported reel becomes a **Reel asset revision**: `content.asset` (kind `Reel`, explanation
  unit id, title/summary from the approved script — never from Cutroom's record) and an immutable
  `content.asset_revision` pointing at the `MediaStore` media id (logical key such as
  `reels/<assetId>/r<rev>/<sha256>.mp4`; never an absolute engine path in the shared document).
- Provenance (internal, not in the content document): production run id, attempt id, Cutroom
  requestId, chain runIds, contract revision, engine id, reported cost, engine-attested evidence, brief
  revision sha, approval ref.
- Admission gates (v2 successors of ADR-0024's seven): lineage/source support, media conformance
  (re-probe), truth label `generated`, **repetition** (template + argument fingerprints — run this
  **before ordering**, in the script linter, so no paid reel is made only to be refused), witness
  alignment (engine-attested `pass_with_label` until an independent witness exists). Pass →
  `PublishedEncounter` row + publication state `ready`; fail → revision stays `rejected` with verdicts.
- Migration of the existing reels into v2 costs **0¢**: re-import from `/srv/knowscroll/*/media/sha256/…`
  (or the engine artifacts) by sha256; carry run ids and gate verdicts as provenance. Three are published
  (greenhouse, seasons-v5, tides-v4); two (tides-v2, sunburn-v2) were refused only by the repetition
  rule and could be admitted if v2's corpus starts empty — owner call.

### 4.6 Script linter (free, before any paid order)

Encodes every rule learned in §1.3/§2.5: ≥6 sentences, exactly 6 preferred; estimated seconds per
sentence ≤ 9 (~2.5 words/s) so clips stay < 50 MiB; no sentence ends on "Sun" (P-001 watch-list);
singular subject nouns; no lettered objects; every claim referenced; one scene per claim; template and
argument fingerprints unique in the v2 corpus; then a **plan-stage rehearsal** (`until:'plan'`, 0¢,
MiniMax token plan) — it catches `split` and planner failures but not Gate 5/7 stops.

### 4.7 What the owner must decide / give before real v2 runs

1. **Which Cutroom.** Reuse `ks-cutroom@pool` (94ee04a, ready, 1.2 GB artifacts) or a fresh instance
   with its own DB and artifact root for v2. Either way: same host as the v2 worker (paths, not bytes),
   no restart while an order is open, keep the 4 h lease.
2. **Money.** The shared pool has **83¢ left of $7** (617¢ committed, no open claims); dev grants
   hold 56¢ + 27¢; stage 500¢ unused but capped by the pool. At the observed yield (14 video orders →
   5 completed → 3 published; ~$2.06 reported per published reel) **83¢ buys at most one order
   (≤56¢ ceiling on one grant, below the 75¢ per-reel ceiling used so far)**. Real v2 runs need a new
   explicit cap (suggest a v2 supply ledger, per-reel ceiling 75¢, cap sized as reels wanted × ~$2 at
   today's yield, less if the linter lifts yield).
3. **fal balance.** Unknown here (provider key not read). Last recorded **$2.61 on 2026-10-09**, before
   122¢ of reported spend. The owner must read and, if needed, top up fal (the #199 plan kept it near $6
   as a backstop). MiniMax runs on the token plan.
4. **Approvals.** Per-script approval in its PR (as #199), recorded as `approval_ref`; whether orders
   then need no further go-ahead (current rule) in v2.
5. **Policy.** Keep the engine-attested witness for v2 admission? Keep repetition rule "B" and its
   corpus scope (v2 corpus fresh or seeded with the old fingerprints)? Admit tides-v2/sunburn-v2?
6. **Caller resume.** Allow owner-initiated selective resume (e.g. a Gate 7 stop) as a new attempt, or
   not at all in v2.
