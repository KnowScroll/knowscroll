# @knowscroll/worker

The background processes: the projection loop, the two product provider paths (Ask answers and
background bridge inquiries), Scroll supply, publication gates, Reel generation and reasoning
maintenance. It runs loops and provider I/O and calls `@knowscroll/db` for every state change.
Provider keys exist only in this app's environment.

## Entry points

- `src/main.ts`: the projection worker (`pnpm dev:worker`). Each turn runs, in fixed order:
  heartbeat, projection, answer pass, inquiry pass, abandoned-work sweeps, supply pass,
  correction refresh, then a short pause.
- `src/generation/main.ts`: the generation worker (`pnpm dev:generation`); operator commands
  go through `scripts/generation.ts`.
- `src/reasoning/maintenance-main.ts`: bounded reasoning maintenance (`pnpm maintenance:reasoning`).
- `src/publication/cli.ts`: the publication evaluate and mint command.
- Folders: `reasoning/` (answer and inquiry workers, `invoke.ts`), `providers/` (MiniMax
  transports, certification, fixtures), `scrolls/`, `cutroom/`, `runtime/` (log, settings, stop
  signal) and `project.ts`.

## Rules a contributor must not break

- No SQL: `pnpm lint` runs `scripts/check-architecture.mjs`, which fails on `.query(` under `apps/`.
  Reads and writes go through `packages/db`, including `reasoning/worker-reads.ts`
  ([ADR-0048](../../docs/decisions/0048-backend-module-boundaries.md)).
- Imports no `fastify` and no API file; relative specifiers never leave the app.
- Lock the universe before the job, including failure settlement; re-read a selected candidate under
  that lock; stale work is discarded, never reported completed ([AGENTS.md](AGENTS.md)).
- Paid provider calls go only through the reasoning plane (fair admission, one invocation,
  reconciliation; ADR-0019, ADR-0033, ADR-0038). `SKIP LOCKED` distributes work, not exactly-once
  external effects.
- Log codes and exit codes are contract: `runtime/settings.ts` keeps `strictIntSetting` (exit
  `invalid_config`) and `lenientIntSetting` (clamp) deliberately separate.
- No credentials or provider errors in logs; certification workers receive no live credentials.
- Conventions: "Code conventions" in [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Where to start reading

1. [AGENTS.md](AGENTS.md).
2. `src/main.ts`: the loop and its duties.
3. `src/runtime/settings.ts` and `src/runtime/log.ts`: how configuration and logging behave.
4. `src/reasoning/answer-worker.ts`, then `src/reasoning/invoke.ts`: one admitted attempt, one provider call.
5. `src/scrolls/supply-worker.ts`: supply passes and requests.
6. `src/generation/main.ts`: the separate generation process.

Dependency graph: [docs/architecture/module-map.md](../../docs/architecture/module-map.md).
Moved files, including the SQL that moved into `packages/db`: [docs/architecture/moved-paths.md](../../docs/architecture/moved-paths.md).
