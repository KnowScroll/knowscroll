# Shared delivery checkpoint

Updated 2026-09-20 (Claude Code coordinator, wave 1 in flight). Coordinator-owned current steering
object, not a transcript. Replace this snapshot when reality changes; preserve prior evidence and
rationale through Git, issues and [delivery history](operations/delivery-history.md).
**Live copy protocol:** during a wave the coordinator edits this file uncommitted in the main
checkout (so compaction reloads it); the committed copy lands with the wave PR. Before pulling main
after a merge, `git checkout -- docs/CHECKPOINT.md` in the main checkout.

## Outcome and authority

Full v1 means all journeys A–I, polished mobile **and desktop**, real Cutroom generation through
import/publication/playback, reasoning, semantic/living/social experience and owner acceptance.
[Release contract](product/v1-release.md) and [#72](https://github.com/KnowScroll/knowscroll/issues/72)
remain authoritative and open. Owner Alpha is intermediate. Read [system navigation](operations/system-navigation.md).

## Verified source versus observed runtime

| Fact | Evidence and practical consequence |
|---|---|
| Main | `ab258ed` (PR #90 merged 2026-09-19T18:20Z); last product code `cfe7aba` (#87) |
| Code migrations | `packages/db/migrations/0001`–`0012`; applied files are immutable |
| Owner database | `pnpm state` 2026-09-19T18:29:11Z: **0001–0009 only**; API false; heartbeat last 2026-09-17. No owner rollout |
| Production | None certified; local test receipts are not production |
| Android | Sourced Scroll, sources, deliberate next, Keep, saved Trace revisit, bounded Clear; full UI + desktop incomplete |
| Reasoning | SQL primitives only; Ask `recorded_only`; no paid dispatch or answers |
| Cutroom upstream | `origin/main` **`86d6e2c`** (reel-takes Slice 2 code `7d5f264`; Slice 3 prompt next; active author XZNON). Canonical clone `/Volumes/Mrigesh SSD/cutroom` still at `52a62dd`, untouched |
| Wire delta 238df854→86d6e2c | Only `record.ts` (required `takes`); six other modules + `apps/api/src/server.ts` identical |
| Cutroom runtime (ours) | Detached pinned worktree `/Volumes/Mrigesh SSD/cutroom-worktrees/runtime-86d6e2c8b742`, steering-ref `e05e9f0` (115 decisions, current), deps via `/usr/local/bin/corepack pnpm` 10.15.1 + SSD store. Nvm corepack (Node20) is broken (signing keys) — don't use it |
| Real providers | Upstream model/image/video/voice/sensors are stand-ins; ffmpeg real. fal H3 / MiniMax T2A explicitly deferred upstream |

## Current wave — #89 (branch `claude/89-cutroom-local`)

- **Contract published** `72b98ec` (+ `e676bca` owner decisions in ADR-0021): successor pin 86d6e2c (record sha `057d30f0…`), strict takes
  tests (30/30 pass; negative control fails 2 on old schema), synthetic fixture journey passes.
  [ADR-0021](decisions/0021-cutroom-successor-pin-and-local-host.md): KnowScroll-owned operator
  host `ops/cutroom-host/` composes pinned upstream API + worker as separate processes, stand-ins +
  ffmpeg only; upstream untouched.
- Lanes (worktrees under `/Volumes/Mrigesh SSD/knowscroll-worktrees/`): `89-host` (`claude/89-host`),
  `89-proof` (`claude/89-proof`), both from `72b98ec`. Integration lane `89-contract`.
- Runtime data root: `$KS_DEV_ROOT/cutroom/` (`instances/`, `logs/`). Upstream check log in `logs/`.
- **Upstream suite at pin on this Mac:** check.mjs typecheck/lint/format/boundaries ok; tests 304/322
  concurrent; the same 16 fail **serially too** (deterministic here, not only load): e.g. reel-plan-endings 28
  (plans list empty after BUDGET rewrite), reel-takes-record 4, stills placing/admission/spending, render
  pass/gates/completed. Logs `upstream-tests-86d6e2c-20260919T184321Z.tap`, `upstream-serial-86d6e2c-20260919T184953Z.log`.
  Upstream journal says green on its Windows host. Owner: don't touch Cutroom — record only.
- Workflow `wf_80f519e9-f50` completed (4 agents, all `claude-sonnet-5`, ~1.31 M subagent tokens).
- Issue comment with verified state and success criteria: #89 comment 5744421559.
- **Wave result:** host 39-check self-check and 12/12 joined proof reproduced by the coordinator on the
  integration head (runs `host-selfcheck-20260919T215041Z`, `joined-proof-2026-09-19T21-51-08-110Z`);
  full backend suite 479+12 pass; independent Sonnet review **accept** (one minor, fixed). PR opened.
  Set `CUTROOM_BASE_URL` only from an observed running owner-local host listener after merge.

## Owner decisions and unresolved gates

- **Decided:** Cutroom runs on this Mac; source, SQLite, media, caches, logs on SSD.
- **Decided:** completed/failed private prompts etc. retire after seven days; Clear immediate.
- **Decided 2026-09-20:** KnowScroll does **not develop or modify Cutroom** (no upstream PRs/issues, no
  adapters built or injected). Integrate only against the published
  [reel-contract](https://github.com/KnowScroll/Cutroom/blob/main/docs/features/reel-contract.md);
  where upstream lacks real providers, proceed against the contract with stand-ins/fixtures.
- **Decided 2026-09-20:** live test cap **$2 total**, allowed **only after upstream Cutroom ships real
  providers**. Not authorized now. H3 = fal [MiniMax H3 Max](https://fal.ai/minimax-h3-max); key is in
  owner `.env` (owner-stated; presumed `FAL_AI_KEY`, value never read); used only by Cutroom's providers.
- **Decided 2026-09-20:** desktop surface = TypeScript web app (ADR-0022, #92).
- Upstream macOS test failures are recorded here/#89 only; do not file upstream (owner: don't touch Cutroom).
- Historical [#57](https://github.com/KnowScroll/knowscroll/issues/57) stays open; cause unknown.

## Parallel lane — #91 (branch `claude/91-reader-explain`, from main `ab258ed`)

- UI slice under #3 on released contracts only: reader "Why this appeared" sheet (API facts only,
  Law 13) + "Sign out this device" (`POST /v1/session/revoke`). Mobile Ask excluded by ADR-0016.
- Lane `/Volumes/Mrigesh SSD/knowscroll-worktrees/91-reader-explain`; coordinator-made provider-free
  `.env` (non-owner DB name `knowscroll_lane91_unused`, fresh token, PORT 4391) + local.properties.
  Worker owns the emulator (AVD `KnowScroll_API36`) for this task.
- Workflow `wf_6fba50cf-036` (task `wt0xx1pyb`): Sonnet builder → Sonnet reviewer.
- UI gap map (read-only agent, verified spot-checks): feed hardcodes `kind='Scroll'`; single `:app`
  module; Reel/branches/worlds/social/pause/export blocked on missing contracts.

## Parallel lane — #92 desktop web (branch `claude/92-web-reader`, from `ab258ed`)

- **Owner decision 2026-09-20: desktop = TypeScript web app.** ADR-0022 committed `0339b63`
  (React/TS/Vite `apps/web`; loopback dev proxy injects token server-side; production refused until #2).
- Lane `/Volumes/Mrigesh SSD/knowscroll-worktrees/92-web-reader`, provider-free `.env`
  (`knowscroll_lane92_unused`, fresh token, PORT 4392). Playwright browsers → `$KS_DEV_ROOT/playwright-browsers`.
- Workflow `wf_1b1e6a7a-93a` (task `ws3awaeo0`): Sonnet builder → Sonnet reviewer.
- Merge note: #89 (ADR-0021) and #92 (ADR-0022) both append to `docs/decisions/README.md` and
  component-map.json — resolve at merge.

## Next work after #89

1. Coordinator contracts under #8/#9: durable scoped generation intent/admission, all-attempt
   accounting, verified host-file import (containment/copy/hash into KnowScroll storage).
2. Import against real stand-in Cutroom output; publication gates (source/rights/truth/continuity).
3. #3 UI against released contracts (mobile Reel playback, cosmic navigation); desktop decision.

## Progress reporting

Existing [Project](https://github.com/orgs/KnowScroll/projects/1), issues #2–#12, [Owner Alpha](https://github.com/KnowScroll/knowscroll/milestone/2),
#72. #89 moved to In Progress 2026-09-20. Owner Alpha 5 closed / 6 open is bookkeeping, not v1 %.
Workers: Sonnet forced (`CLAUDE_CODE_SUBAGENT_MODEL=sonnet`, FORCE=1); report actual models from results.
