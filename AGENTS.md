# KnowScroll

## Start with the task

- Resolving or auditing a GitHub issue: run `pnpm issue-context <number>`. Investigating a report: run `pnpm issue-context new "short symptom or UI text"`. Both print reading pointers. For offline usage and issue drafting, see [issue workflow](docs/v2/engineering/issue-context.md).
- Read the acceptance criteria, the README of each package/module you change, and the specific rules and design screens that govern the journey. Expand when a boundary, amendment or runtime result is unclear. Look up a decision with `pnpm issue-context decision D-319`.
- Use [status](docs/STATUS.md) for coordination, and verify Git, CI and deployed health before making runtime claims. [#661](https://github.com/KnowScroll/knowscroll/issues/661) tracks owner feedback, #462 the v3 revamp and #222 v2 history. Handoffs belong in the issue or PR: branch/commit, verified outcome and next action.
- The [blueprint](docs/v2/architecture/02d-greenfield-blueprint.md) governs architecture and behavior, amended by [decisions](docs/v2/decisions.md) and the applicable [carried-forward rulings](docs/v2/carried-forward-facts.md). Consult the [architecture handoff](docs/v2/architecture/02e-future-session-handoff.md) for durable intent. V3 governs Universe, Scrolls, rooms and Talk; v2.1 governs other visuals. Use the [design index](docs/v2/README.md). Examples are authored, never product data. [Archived discovery](docs/archive/README.md) and `legacy/v1-final` are historical evidence.

## Product and reliability

- Only actual personal Reel/Scroll encounters supply consumption evidence. Adapt quickly to intent and cautiously to lasting meaning. Reel and Scroll have equal status; learn format per topic/context. Keep sequels, format variants, related perspectives and What-if branches distinct.
- Planet formation needs qualified, conceptually varied evidence. Inactivity changes activity only. Play results never affect ranking, planning, evidence or formation; landmarks are read-only overlays.
- Peer playback, branches and seen state are private except for member-only coarse thread places with per-person hiding (D-065) and mutual DM receipts (D-066). Label AI. Never invent activity, content, provider output or runtime evidence.
- Keep internal prompts, reasoning, scores, sources panels and operational machinery out of consumer UI. Sparks, landmarks, stars and per-Launch podiums are allowed; leaderboards, karma and levels are forbidden.
- Models propose. Code checks structure, authority and effects. Use `withPersonalScope` to lock the personal root and recheck epoch/authority after waiting. Workers check their own authority. Account/epoch changes fence and purge client resources.
- Commit receipt, effects and required pg-boss work together. Durable reads recover disposable live hints. Separate queue deliveries, business runs and paid attempts; consult the ledger and reconcile unknown outcomes. Keep external waits/model calls outside transactions and HTTP navigation. No second queue, Kafka, graph DB, microservices or autonomous model tool loops.

## How we work

- Follow the [contributor workflow](docs/v2/engineering/contributing.md#how-we-work): issue first, one vertical slice per isolated `claude/<issue>-<purpose>` worktree from `codex/release-knowscroll-v2`, local checks, one fresh review, squash on green. Check responsive UI against its artboard. Coordinators own status and promotion. Verify dev with disposable accounts.
- Keep domain rules pure, effects visible, and cross-module access through `public.ts`. Use clear names. Document public authority, effects, failures and retry behavior; comment on non-obvious invariants. Update owning READMEs. Remove code made obsolete by the slice after checking public callers, workers, routes and platform entries. Keep unrelated cleanup separate.
- Never update main or deploy production. Dev deploys on push; stage only through the promotion script. Never switch the shared checkout, reset, force-push, edit another agent’s files or kill process groups. Use the team’s dedicated worktree/data roots (SSD on the owner’s Mac).
- Read the [provider budgets](docs/v2/engineering/contributing.md#providers-and-money) before provider use and the [environment rules](docs/v2/engineering/contributing.md#environments-and-safety) before database or release work. Protect the owner’s and legacy databases, production media and pool rows. Destructive tests use disposable data. Never print secrets, env values or signed URLs. Use hosted CI runners and keep deployment off PR workflows.
