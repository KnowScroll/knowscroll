# Parallel worktrees

Prepared under `/Volumes/Mrigesh SSD/knowscroll-worktrees/`:

| Directory / branch | Issue | Local API port | Database |
|---|---|---|---|
| `mobile` / `codex/62-retirement-privacy` | #62 independent Sol privacy tests | 4312 | knowscroll_mobile |
| `core` / `codex/62-retirement-review` | #62 independent Terra SQL/concurrency review | 4313 | knowscroll_core |
| `reasoning` / `codex/62-retirement-runtime` | #62 Terra maintenance runtime and tests | 4314 | knowscroll_reasoning |
| `coordination` / `codex/62-retirement-integration` | #62 shared retention contract/migration and integration | 4315 | knowscroll_coordination |

Each has its own ignored `.env` and local Android configuration. All use the dedicated SSD PostgreSQL cluster at port55432 and the same SSD package/SDK/Gradle caches. Databases and API ports are separate. These lanes are prepared, not autonomous agents already running.

The reasoning directory also hosted the completed `codex/12-journey-proof` slice during wave one. Inspect `git worktree list`, branch status and the coordination issue before reassigning any directory. The coordinator environment has no provider credentials; generate mobile local configuration only if that checkout needs an Android build.

Wave-two ownership and dependency history is in [#21](https://github.com/KnowScroll/knowscroll/issues/21). Previous branches remain available; the directory name does not determine the current issue or grant permission to edit another component.

Wave-three ownership is in [#29](https://github.com/KnowScroll/knowscroll/issues/29). Each lane started from verified `f2cedd2` plus the shared ADR-0010 contract. Destructive privacy verification uses newly created disposable databases and the `.journey` Android package; the normal lane/owner histories are preserved.

Open Claude Code or Codex in the relevant directory and give the opening brief in [agent-workflow.md](agent-workflow.md). Read README, PROJECT-STATE and the issue before editing. Claim shared contract/schema changes with the coordinator. Use `pnpm test` for an isolated test database; use the lane’s normal API/worker commands for interactive work.

Before starting a lane, fetch and fast-forward or rebase onto current main as appropriate. Do not reset an active worktree or share a checked-out branch. The coordinator integrates PRs into the main checkout and verifies the combined journey.

To add another lane, use standard `git worktree add -b codex/<issue>-<name> <SSD-path> main`; provision a distinct local database and PORT in ignored .env, then source scripts/env.sh, install dependencies, run dev-init.sh and mobile-config.sh. Never reuse another running lane’s port or silently point at its database.

Wave four is coordinated in [#37](https://github.com/KnowScroll/knowscroll/issues/37). The mobile lane is idle after #31. Adapter/runner workers receive no provider credentials; only the coordinator executes the bounded live certification after offline verification. ADR-0011 owns the boundary.

Issue #42 uses coordinator-owned ADR/shared schema edits and read-only Sol/Terra review in the idle lanes. The [next implementation plan](reasoning-implementation-plan.md) assigns #44–#46 after storage contracts are released; their presence in the issue board does not mean workers are already executing them.

Issue #44 uses coordinator-owned migration 0004, a Sol storage-test lane, and a privacy helper lane begun by Sol and completed by Terra after a model-capacity failure. Terra independently reviews the migration, tests and helpers. No provider calls are part of this slice. #45 consumes the reviewed storage interfaces next; #46 owns process crash proof.

Issue #45 uses Sol for admission/lease/recovery, Terra for cumulative reconciliation and a separate Terra reviewer. Coordinator owns migration 0005, shared policy validation, the unwired invocation boundary and integrated SQL/HTTP proof. All provider responses remain test fixtures; #46 owns J004 next.

Issue #46 uses Sol for the disposable J004 process harness and Terra for independent review. Coordinator owns the receipt verifier, corruption counterexamples, independent SIGTERM/SIGINT cleanup checker, CI and documentation. No production module, migration, provider call or normal Android surface changes in this slice.

Issue #54 uses Terra (`gpt-5.6-terra`) for the pure deterministic model and a second Terra worker for independent adversarial review. Sol is unavailable due to a model usage limit. Coordinator owns ADR-0013, policy decisions, integration, source-stamped evidence and docs. There are no provider calls, migrations or ordinary runtime changes in this slice.

Issue #55 uses coordinator-owned migration 0006, shared transaction/preflight helpers, retained corrections/privacy and final scheduler integration. Terra supplies bounded SQL tests and an independent concurrency/privacy reviewer; Sol supplies independent sustained service tests. The original scheduler draft was superseded after review, and acceptance uses the integrated implementation. Sol also diagnosed and repaired #57 separately in merged PR #58. All provider calls remain disabled.

Issue #60 uses Terra for the compiler and focused SQL tests, a separate Terra for independent seal/lock/policy adversaries, and Sol for authentication/privacy counterexamples. Coordinator owns migration 0007, strict contracts, phase composition, original-session Job binding and integration. Completed lane branches retain their original commits; a clean branch does not mean its tree already includes the final squash merge. Inspect live state before reassignment. Issue #62 subsequently records the owner’s seven-day retention decision; see its separate maintenance implementation and deployment evidence.

Issue #62 records the owner’s seven-day decision. Coordinator owns ADR-0015, migration 0008, withdrawal stamping, process verification, CI and integration. Terra implements the maintenance helper/separate worker, Sol independently tests privacy and late usage, and another Terra reviews SQL/concurrency. Prior branches are preserved. No provider calls or normal projection-worker changes.
