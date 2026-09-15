# Parallel worktrees

Prepared under `/Volumes/Mrigesh SSD/knowscroll-worktrees/`:

| Directory / branch | Issue | Local API port | Database |
|---|---|---|---|
| `mobile` / `codex/3-mobile-experience` | #3 | 4312 | knowscroll_mobile |
| `core` / `codex/4-ledger-state` | #4 | 4313 | knowscroll_core |
| `reasoning` / `codex/7-reasoning-plane` | #7 | 4314 | knowscroll_reasoning |

Each has its own ignored `.env` and local Android configuration. All use the dedicated SSD PostgreSQL cluster at port55432 and the same SSD package/SDK/Gradle caches. Databases and API ports are separate. These lanes are prepared, not autonomous agents already running.

Open Claude Code or Codex in the relevant directory and give the opening brief in [agent-workflow.md](agent-workflow.md). Read README, PROJECT-STATE and the issue before editing. Claim shared contract/schema changes with the coordinator. Use `pnpm test` for an isolated test database; use the lane’s normal API/worker commands for interactive work.

Before starting a lane, fetch and fast-forward or rebase onto current main as appropriate. Do not reset an active worktree or share a checked-out branch. The coordinator integrates PRs into the main checkout and verifies the combined journey.

To add another lane, use standard `git worktree add -b codex/<issue>-<name> <SSD-path> main`; provision a distinct local database and PORT in ignored .env, then source scripts/env.sh, install dependencies, run dev-init.sh and mobile-config.sh. Never reuse another running lane’s port or silently point at its database.
