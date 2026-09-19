# Local Cutroom: verified handoff boundary

Status: current source audit and accepted hosting decision, 2026-09-19, #88/#89.
The owner chose local execution on this Mac with all generated media and working storage on SSD.
This resolves the pending local-versus-remote choice in ADR-0020; it does not certify a deployment.

## September 20 outcome (#89)

The client now pins upstream `86d6e2c8` ([ADR-0021](../decisions/0021-cutroom-successor-pin-and-local-host.md)).
A KnowScroll-owned operator host (`ops/cutroom-host/`) starts the pinned upstream API and worker as
separate SSD processes with upstream stand-ins and real ffmpeg. The repinned client passed a
12-scenario joined proof against that real service and storage — replay, conflict, lost response,
graceful restart, crash reclaim, cancellation and a completed stand-in video — see
[evidence](../journeys/evidence/cutroom-local/README.md). Owner decisions: KnowScroll does not modify
Cutroom; a live test of at most $2 waits until upstream ships real providers. The sections below are
the September 19 audit, kept as history.

## Current upstream and compatibility

Fresh clone: `/Volumes/Mrigesh SSD/cutroom`, remote `KnowScroll/Cutroom`, main
`52a62dd8ea8cd3f258f9be2b167cbeac4a0bda2a`. Dependencies are not installed and `steering-ref`
is uninitialized. No server was launched or provider called. Recheck before using this observation.

Compared with KnowScroll's accepted pin `238df85411108a94377311363dd296d785688f70`, six of
seven copied wire modules are unchanged. `packages/reel-contract/src/record.ts` adds a required
`takes` array, still under contract version 1. Its entries carry take/shot IDs, number, used flag,
optional observation/reconciliation IDs and gate checks. KnowScroll's strict old parser rejects
this shape. **Review a successor pin and update vectors/provenance before connecting to current
Cutroom; don't loosen validation to hide drift.** Routes remain unchanged in this comparison.

The latest commit is a Slice 2 **prompt**, following `d6ae1f1`'s reel-takes Slice 1 code. It does
not prove that retries/checkpoints/fallbacks planned for later slices are implemented. Source:
[record delta](https://github.com/KnowScroll/Cutroom/compare/238df85411108a94377311363dd296d785688f70...52a62dd8ea8cd3f258f9be2b167cbeac4a0bda2a),
[reel-takes plan](https://github.com/KnowScroll/Cutroom/blob/52a62dd8ea8cd3f258f9be2b167cbeac4a0bda2a/docs/features/reel-takes.md).

## Actual launch surface, not a fabricated command

- `apps/api/src/server.ts` exports `startApi({dbPath, port?})`, binding **127.0.0.1**.
  Default port is **0** (OS-selected), returned as `api.baseUrl`; there is no fixed default service port.
- `apps/worker/src/worker.ts` exports `startWorker(options)`. Its caller injects required adapters,
  settings, paths and lifecycle. API and worker are libraries; root/package scripts supply no
  ready `serve`/`start` command. KnowScroll's `pnpm dev:api` starts KnowScroll, not Cutroom.
- Cutroom uses **SQLite** (`packages/domain/src/db.ts`), independently of KnowScroll's PostgreSQL.
  Never point it at the owner PostgreSQL database or reuse another lane's SQLite file.
- `.env.example` documents `CUTROOM_ARTIFACTS_DIR=.artifacts`,
  `CUTROOM_DB_PATH=./data/cutroom.sqlite` and optional `CUTROOM_STEERING_DIR`.
  These names alone do not constitute a launcher: explicit host wiring must pass paths to the
  API, worker and artifact adapters. `packages/providers/src/artifacts.ts` defaults inside the repo.
- Model/image/video/narration/sensor adapters exported by `packages/providers/src/index.ts` are
  stand-ins. Local ffmpeg media/assembly is real; parts such as OCR/audio classification remain
  scripted. `docs/features/reel-render.md` explicitly defers fal H3, MiniMax T2A and other real adapters.
- Therefore there is **no current H3/M3/FAL environment-to-adapter mapping** to fill blindly.
  Implement/cooperate on the accepted provider composition in Cutroom; keep provider secrets out
  of the API and product/mobile. An H3 endpoint is not `CUTROOM_BASE_URL`.

Source: [API](https://github.com/KnowScroll/Cutroom/blob/52a62dd8ea8cd3f258f9be2b167cbeac4a0bda2a/apps/api/src/server.ts),
[worker](https://github.com/KnowScroll/Cutroom/blob/52a62dd8ea8cd3f258f9be2b167cbeac4a0bda2a/apps/worker/src/worker.ts),
[providers](https://github.com/KnowScroll/Cutroom/blob/52a62dd8ea8cd3f258f9be2b167cbeac4a0bda2a/packages/providers/src/index.ts),
[render boundary](https://github.com/KnowScroll/Cutroom/blob/52a62dd8ea8cd3f258f9be2b167cbeac4a0bda2a/docs/features/reel-render.md).
Root README/AGENTS still contain bootstrap-era “no feature code” text; source and feature receipts
contradict that status. Preserve applicable rules, but do not adopt that stale capability claim.
Cutroom has its own decision/journal/feature gates and `steering-ref` submodule pointing at
`Legend101Zz/Knowscroll-v2`. Resolve their current authority before upstream edits; do not overwrite
them using KnowScroll product ADRs or assume the old steering repo governs new product code.

## Configuration and next execution

Main product `.env` is ignored and contains populated `MINIMAX_API_KEY` and `FAL_AI_KEY`, blank
`CUTROOM_BASE_URL`. No distinct H3 endpoint variable was found. Values were not printed, copied
to worktrees or tested. Owner reports access to H3; receiving coordinator obtains only missing
endpoint/mapping details privately after inspecting local configuration. Never overwrite an
existing key merely because a provider expects a different name.

For [#89](https://github.com/KnowScroll/knowscroll/issues/89), first review the contract delta and
the minimal local host composition. Use separate SSD SQLite/artifact directories for proof,
launch real upstream API/worker with explicitly labelled stand-ins, record process/source/DB
identity and the assigned listener, and set `CUTROOM_BASE_URL` to that **observed** loopback origin.
Show start/stop/restart and original-ID reconciliation against real upstream storage. This proves
service integration, not real generation. Do not invent a `/health` route; inspect declared routes.

Then establish provider endpoint/key mapping and missing adapters, bounded live-call authorization,
all-attempt cost/unknown accounting, import root/path containment and media lifetime. KnowScroll
owns source, rights, truth, continuity, publication and playable URLs. Engine paths are untrusted
host metadata until verified/imported. Never expose filesystem paths as mobile media URLs.

The user's keys are not an unlimited spend grant. Before paid execution, provide an explicit
experiment with calls, duration/tokens, total ceiling, retry policy, media output and stop rules;
obtain the missing cap once. Continue independent work while that decision is pending.
