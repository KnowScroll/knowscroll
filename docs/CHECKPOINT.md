# Shared delivery checkpoint

Updated 2026-09-20 (Claude Code coordinator). Coordinator-owned current steering object, not a
transcript. Replace this snapshot when reality changes; preserve prior evidence and rationale through
Git, issues and [delivery history](operations/delivery-history.md).
**Live copy protocol:** during a wave the coordinator edits this file uncommitted in the main
checkout (so compaction reloads it); the committed copy lands with a wave PR. After a merge,
re-apply anything newer here before running `git checkout -- docs/CHECKPOINT.md`.

## Outcome and authority

Full v1 means all journeys A–I, polished mobile **and desktop**, real Cutroom generation through
import/publication/playback, reasoning, semantic/living/social experience and owner acceptance.
[Release contract](product/v1-release.md) and [#72](https://github.com/KnowScroll/knowscroll/issues/72)
remain authoritative and open. Owner Alpha is intermediate. Read [system navigation](operations/system-navigation.md).

## Verified source versus observed runtime

| Fact | Evidence and practical consequence |
|---|---|
| Main | **`363c818`** (PR #98, #94 generation supply); `b8bfe3e` (#91), `e5573b4` (#92), `7449677` (#89) |
| Code migrations | `0001`–**`0013`** on main (0013 is generation supply); owner database still at 0009 |
| Owner database | `pnpm state` 2026-09-19T18:29Z: **0001–0009 only**; API false; heartbeat 2026-09-17. No owner rollout |
| Android | Sourced Scroll, sources, deliberate next, Keep, Trace revisit, bounded Clear, **why-this sheet and device sign-out** (#91). Sheet state across recreation: #97 |
| Desktop | `apps/web` first slice **on main** (#92): reader parity, dev-only loopback auth, no production identity |
| Reasoning | SQL primitives only; Ask `recorded_only`; no paid dispatch, no mobile Ask (ADR-0016) |
| Cutroom upstream | `origin/main` `86d6e2c` (active author XZNON). Canonical clone `/Volumes/Mrigesh SSD/cutroom` at `52a62dd`, untouched |
| Cutroom runtime (ours) | Pinned detached worktree `/Volumes/Mrigesh SSD/cutroom-worktrees/runtime-86d6e2c8b742`, deps installed. Use `/usr/local/bin/corepack` (nvm corepack is broken) |
| Upstream suite at pin | 16 of 322 tests fail deterministically on this Mac (logs in `$KS_DEV_ROOT/cutroom/logs/`). Record only — owner: don't touch Cutroom |
| Real providers | Upstream model/image/video/voice/sensors are stand-ins; ffmpeg real. fal H3 / MiniMax T2A deferred upstream |

## Delivered — #89 (PR #93 → `7449677`)

Successor pin `86d6e2c` (required `RunRecord.takes`); `ops/cutroom-host/` runs the pinned upstream
API/worker as separate SSD processes with stand-ins + ffmpeg; 12-scenario joined proof and host
self-check reproduced by the coordinator; backend 479+12 pass; CI green; independent review accept.
Evidence: `docs/journeys/evidence/cutroom-local/`.

**Running owner-local stand-in engine** (from main, started 2026-09-19T22:00Z): instance
`$KS_DEV_ROOT/cutroom/instances/owner-local-standin`, **API PID 6937 on 127.0.0.1:4390**, **worker
PID 6939**, providers `standin`, no stand-in script (a real request fails at the first model call —
honest). `CUTROOM_BASE_URL=http://127.0.0.1:4390` set in the owner `.env` (that line only; it was
blank). Not guaranteed across reboot/SSD eject; stop with SIGTERM to both PIDs.

## Owner decisions and unresolved gates

- **Decided:** Cutroom runs on this Mac; source, SQLite, media, caches, logs on SSD.
- **Decided:** completed/failed private prompts retire after seven days; Clear immediate.
- **Decided 2026-09-20:** KnowScroll does **not develop or modify Cutroom**; integrate only against the
  published [reel-contract](https://github.com/KnowScroll/Cutroom/blob/main/docs/features/reel-contract.md).
- **Decided 2026-09-20:** live test cap **$2 total**, only **after upstream ships real providers**; not
  authorized now, and enforced in migration 0013. H3 = fal [MiniMax H3 Max](https://fal.ai/minimax-h3-max),
  key in owner `.env`, used only by Cutroom's providers (value never read).
- **Decided 2026-09-20:** desktop surface = TypeScript web app (ADR-0022, #92).
- Historical [#57](https://github.com/KnowScroll/knowscroll/issues/57) stays open; cause unknown.

## Active lanes

None. #89, #91, #92 and #94 are merged; their worktrees are removed and their branches pushed.
`claude-handoff` (#88) and `revisit` remain from earlier work. Records lane `claude/99-records`
carries this update.

## Next work

1. Merge #95 after CI; finish the #91 repair, re-run its evidence, PR and merge.
2. #94 stages B and A2 (one worker slot free now that #92 merged); then the publication/eligibility + media-serving contract (gates, truth
   labels, stand-in fence), then feed inclusion and Reel playback on Android and web.
3. Follow-up #97 filed: transient reader sheet state is lost across Activity recreation (Law 14).
4. Keep #2 identity in view: web has dev-only auth, Android a dev token; neither is production.

## Progress reporting

[Project](https://github.com/orgs/KnowScroll/projects/1), issues #2–#12, [Owner Alpha](https://github.com/KnowScroll/knowscroll/milestone/2), #72.
#89 Done; #91/#92/#94 In Progress. Issue counts are bookkeeping, not a v1 percentage. Workers are
Sonnet (`claude-sonnet-5`, forced); the coordinator reproduces every claim before merge.
