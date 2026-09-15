# Parallel worktrees

Prepared under `/Volumes/Mrigesh SSD/knowscroll-worktrees/`:

| Directory / branch | Issue | Local API port | Database |
|---|---|---|---|
| `mobile` / `codex/23-session-api` | #23 (parent #2), backend-only in wave two | 4312 | knowscroll_mobile |
| `core` / `codex/22-session-foundation` | #22 (parent #4) | 4313 | knowscroll_core |
| `reasoning` / `codex/24-session-journey` | #24 (parent #12) | 4314 | knowscroll_reasoning |
| `coordination` / `codex/21-identity-wave` | #21 integration | 4315 | knowscroll_coordination |

Each has its own ignored `.env` and local Android configuration. All use the dedicated SSD PostgreSQL cluster at port55432 and the same SSD package/SDK/Gradle caches. Databases and API ports are separate. These lanes are prepared, not autonomous agents already running.

The reasoning directory also hosted the completed `codex/12-journey-proof` slice during wave one. Inspect `git worktree list`, branch status and the coordination issue before reassigning any directory. The coordinator environment has no provider credentials; generate mobile local configuration only if that checkout needs an Android build.

Wave-two ownership and dependency history is in [#21](https://github.com/KnowScroll/knowscroll/issues/21). Previous branches remain available; the directory name does not determine the current issue or grant permission to edit another component.

Open Claude Code or Codex in the relevant directory and give the opening brief in [agent-workflow.md](agent-workflow.md). Read README, PROJECT-STATE and the issue before editing. Claim shared contract/schema changes with the coordinator. Use `pnpm test` for an isolated test database; use the lane’s normal API/worker commands for interactive work.

Before starting a lane, fetch and fast-forward or rebase onto current main as appropriate. Do not reset an active worktree or share a checked-out branch. The coordinator integrates PRs into the main checkout and verifies the combined journey.

To add another lane, use standard `git worktree add -b codex/<issue>-<name> <SSD-path> main`; provision a distinct local database and PORT in ignored .env, then source scripts/env.sh, install dependencies, run dev-init.sh and mobile-config.sh. Never reuse another running lane’s port or silently point at its database.
