# Shared delivery checkpoint

Updated 2026-09-19. Coordinator-owned current steering object, not a transcript. Replace this
snapshot when reality changes; preserve its prior evidence and rationale through Git, issues
and [delivery history](operations/delivery-history.md). Every harness starts here.

## Outcome and authority

Full v1 means all journeys A–I, polished mobile **and desktop**, real Cutroom generation through
import/publication/playback, reasoning, semantic/living/social experience and owner acceptance.
[Release contract](product/v1-release.md) and [#72](https://github.com/KnowScroll/knowscroll/issues/72)
remain authoritative and open. Owner Alpha is intermediate. Read [system navigation](operations/system-navigation.md)
for the distinct authorities for product, design, implementation and runtime.

## Verified source versus observed runtime

| Fact | Evidence and practical consequence |
|---|---|
| Last product code | `cfe7ababdd9de0209582fd143c2ae71fc87b9602`, PR #87; handoff docs are in #88 / PR #90 |
| Code migrations | `packages/db/migrations/0001` through `0012`; applied files are immutable |
| Owner database | Observed **0001–0009 only**, 2026-09-19 17:55:29 UTC; 0010–0012 are not deployed there |
| Owner API/worker | Health probe false; projection heartbeat last seen Sept 17, not recent. No owner rollout performed |
| Production | No production deployment or active full-product path is certified; do not call local test receipts production |
| Verification | 474 backend tests including 30 HTTP checks; final product-code main CI run `35454296487` passed |
| Android | Sourced Scroll, source access, deliberate next discovery, Keep, saved Trace revisit/restoration, bounded Clear; full UI remains incomplete |
| Reasoning | SQL safety/context/fairness/lifecycle/retirement primitives implemented; Ask is `recorded_only`; no product paid dispatch or answers |
| Cutroom client | Strict, unwired client pinned to `238df854`; synthetic HTTP/restart proof only |
| Current Cutroom checkout | `/Volumes/Mrigesh SSD/cutroom`, clean at `52a62dd8ea8cd3f258f9be2b167cbeac4a0bda2a`; source only, not installed or launched |
| Current incompatibility | Upstream now requires `RunRecord.takes` within version 1; old strict record parser rejects it. Next #89 must repin/test |
| Real providers | Upstream model/image/video/voice/sensors remain stand-ins; local ffmpeg is real. H3/FAL adapters and service launcher are not supplied |

Runtime receipt: [handoff evidence](journeys/evidence/claude-handoff/README.md). `pnpm state`
reads a timestamped local observation; its capability flags are hard-coded, not live dispatch tracing.

## Owner decisions and unresolved gates

- **Decided:** run Cutroom on this Mac, with source, SQLite, media, caches and logs on the external SSD.
- **Decided:** completed/failed private prompts, frozen context and unsaved outputs retire seven days
  after safe terminal stamping. Saved content/accounting have separate rules; Clear remains immediate.
- Owner reports M3/H3/FAL access. Only `.env` names/presence were inspected: `MINIMAX_API_KEY`
  and `FAL_AI_KEY` populated, `CUTROOM_BASE_URL` blank. No separate H3 endpoint name was found.
  Do not overwrite keys, assume interchangeability, or invent an endpoint variable.
- A live experiment still needs an explicit bounded call/cost cap, correct provider mapping and
  uncertainty/accounting rules. Existing credentials and old certification are not unlimited authority.
- Historical [#57](https://github.com/KnowScroll/knowscroll/issues/57) remains open; its original
  missing-cleanup-ack cause is unknown. Keep first failures and changed-successor receipts.

## Next work and current lanes

1. Receiving coordinator reads [Claude handoff](handoffs/claude-code-v1.md), verifies PR #90's merge and current state.
2. Start [#89](https://github.com/KnowScroll/knowscroll/issues/89): review the newer record contract,
   establish actual local Cutroom API/worker bootstrap with isolated SSD storage, and verify actual
   upstream HTTP/storage without paid providers. Set `CUTROOM_BASE_URL` only from the observed listener.
3. Then coordinate #8/#9 intent/admission and import/publication boundaries plus missing upstream
   real-provider adapters. Run independent #3 UI work only against released contracts.

At handoff, the #88 documentation lane remains in `knowscroll-worktrees/claude-handoff`; no
implementation workers are running. `revisit` is retained because ADB references it; it is an old completed branch,
not the starting point for new work. Other 19 obsolete checkouts and bootstrap scratch were archived
and removed. [Workspace inventory](operations/worktrees.md) gives recovery locations and constraints.

## Progress reporting

Use the [existing Project](https://github.com/orgs/KnowScroll/projects/1), component issues #2–#12,
[Owner Alpha](https://github.com/KnowScroll/knowscroll/milestone/2), and #72. Sept 19 snapshot:
Owner Alpha has **5 closed / 6 open** issues; this is issue bookkeeping, **not a v1 percentage**.
No complete A–I release journey has joined release-UI and owner acceptance recorded.
At each wave report: shipped outcome, evidence level, release gates advanced, remaining blockers,
next action, actual worker models and measured usage when available. Keep the owner informed at
wave start, material findings/failures, integration and completion; don't leave long silent runs.
