# SSD workspace inventory

Status: current local inventory after #88 cleanup, 2026-09-19. Recheck `git worktree list`,
`git status` and process references before changing anything. Old lane tables were historical
and have been replaced; their Git history and issue receipts remain available.

| Path under `/Volumes/Mrigesh SSD` | Purpose and current status |
|---|---|
| `knowscroll-product` | Canonical product checkout on main; ignored owner `.env`, dependencies and accepted local artifacts. Preserve owner data/configuration |
| `knowscroll-worktrees/claude-handoff` | #88 documentation/coordinator lane, branch `codex/88-claude-handoff`; no private `.env` or runtime |
| `cutroom-worktrees/runtime-86d6e2c8b742` | Pinned detached Cutroom runtime for `ops/cutroom-host` (#89): dependencies installed, `steering-ref` initialized, read-only to workers. Never edit or let Cutroom write its defaults here |
| `knowscroll-dev/cutroom/` | Local engine data: `instances/<name>/` (SQLite, artifacts, logs) and `logs/`. Holds the running owner-local stand-in instance and retained journey evidence |
| `knowscroll-worktrees/revisit` | Completed #78 lane at `d37933e`; retained because ADB PID44151 referenced it during cleanup. Old code, not a current work starting point |
| `knowscroll-dev` | Shared SDK/AVD/user files, Gradle, Corepack/npm/pnpm caches, tooling, PostgreSQL data on port55432, logs/temp/evidence, pio run records, private archives |
| `cutroom` | Separate fresh upstream source clone at52a62dd; dependencies/submodule not initialized, no service started |
| `knowscroll-bootstrap` | **Removed after verified archive.** One-time Sept15 scripts, downloaded metadata, issue drafts and founding inventory; never current product source |

## Completed cleanup

Nineteen clean inactive product worktrees were archived and removed with `git worktree remove`
without force. Their branch references remain, and `source-branches.bundle` captures all refs.
Local ignored evidence/configuration was archived with per-file SHA256 verification before removal.
Regenerable `node_modules`, `build`, `.gradle`, `.kotlin` and `dist` were excluded. Bootstrap scratch
was archived and verified before its original folder was removed. The normal owner database,
main artifacts, existing dev/tmp failure logs and referenced revisit lane were preserved.

Private archive root: `/Volumes/Mrigesh SSD/knowscroll-dev/archive/2026-09-19-handoff/`.
Directory mode0700, archives/manifests mode0600; these may contain local secrets and must not be
uploaded. `cleanup.json` maps former paths to archives and retained commits; each
`<lane>-manifest.json` verifies local files. Historical absolute evidence paths from deleted
lanes resolve via those archives. Use an isolated SSD restore directory to extract only needed
files; never overwrite current `.env` or restore old configuration wholesale.

A sanitized [cleanup receipt](../journeys/evidence/claude-handoff/cleanup.json) is checked in.
Do not remove `knowscroll-dev`: it holds the owner's actual PostgreSQL cluster and accepted evidence.
Do not drop old test databases whose ownership is unknown. This cleanup makes no claim that every
historic test database or app-managed internal-drive file has been removed.

## September 20 lanes

Issues #89, #91, #92 and #94 were delivered from short-lived lanes (`89-contract/host/proof`,
`91-reader-explain`, `92-web-reader`, `94-generation/runtime/import/joined`). All were merged,
their branches pushed to `origin` for recoverable history, and their worktrees removed with
`git worktree remove` (no force). Each lane had a coordinator-made, provider-free `.env` with a
non-owner database name and a fresh token; none received a provider key. Worker agents must never
print a secret or anything derived from one — see `.claude/agents/knowscroll-builder.md`.

## New workers

Coordinator creates a fresh named issue branch from verified current main in this SSD worktree
parent. Assign explicit nonoverlapping files, a unique database, port and owned process set;
shared caches are fine, shared running databases are not. Source `scripts/env.sh` from the checkout
before installs/builds/tests. Create a provider-free ignored `.env` only when needed; don't copy
owner keys into worker lanes. Only one coordinator operates the Android emulator; destructive UI
checks use the separate `.journey` app and disposable database. Inspect scoped AGENTS/CLAUDE files.

Git isolation does not isolate ports, SQLite, PostgreSQL, media roots or budgets. Never reset,
force-delete or reassign an active lane. Before retiring a completed lane, confirm clean tracked
and untracked work, no process references, retained Git commits and verified local evidence archives.
