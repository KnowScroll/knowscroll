# ADR-0048 — Backend module boundaries: workspace packages, one import convention, and SQL only in packages/db

Date: 2026-10-04. Status: accepted by the coordinator for [#196](https://github.com/KnowScroll/knowscroll/issues/196),
on the owner's decisions recorded in that issue. Behavior-preserving: nothing here changes a status, header,
body, message, SQL text, transaction boundary, lock order, timing constant, log code or exit code.

## Context

`apps/api`, `apps/worker` and `packages/{contracts,core,db}` (about 43k lines run directly by `tsx`) grew
without written boundaries. Every cross-package import was a deep relative path
(`../../../packages/db/src/x.ts`), so a file move broke dozens of importers and the boundaries were invisible.
The rules (core is pure, the API makes no provider calls, packages never import apps) existed only as prose in
`AGENTS.md`. Importing any `packages/db` module silently loaded `.env` and opened a pool through a barrel that
mixed infrastructure with re-exports, which also produced a 15-file import cycle. SQL lived in three places:
`packages/db`, eight API handlers, and nine worker files.

## Decision

1. **Workspace packages.** `@knowscroll/contracts`, `@knowscroll/core` and `@knowscroll/db` each have a
   `package.json` whose `exports` map is `"."` → `./src/index.ts` (where an index exists; `core` has none)
   and `"./*"` → `./src/*.ts`. `apps/api` and `apps/worker` declare their own dependencies; only the worker
   declares the provider SDKs (`ai`, `vercel-minimax-ai-provider`). `apps/web` depends on
   `@knowscroll/contracts`. There is no build step: `tsx`, `tsc`, Vite and vitest resolve the `.ts` targets
   through pnpm's workspace links.
2. **Import convention.**
   - Across packages: `@knowscroll/<pkg>` or `@knowscroll/<pkg>/<subpath>`, with no extension.
   - Within a package: relative paths ending in `.ts`.
   - Apps are imported only by the repository's `tests/` and `scripts/`, by relative path.
   - Order: node built-ins, external packages, `@knowscroll/*`, relative. Type-only imports use `import type`.
3. **Layering.**
   - `apps/api` is the HTTP adapter: authenticate, parse, call a `packages/db` function, reply. It maps errors
     in one place (the global handler) plus two documented `kind` mappers.
   - `packages/db` holds the domain transaction scripts and persistence. A function either takes the caller's
     `client` (and says in its JSDoc which transaction and locks it expects) or owns its transaction through
     the pool. `connection.ts` owns `.env` loading, the pool, `transaction` and `lockUniverse`; importing a db
     module that needs the pool still loads `.env` exactly as before.
   - `packages/core` holds pure rules; `packages/contracts` holds wire schemas.
   - `apps/worker` runs loops and provider I/O and calls `packages/db` for state.
   - A separate repository layer under the db functions was rejected: the db functions already are that layer,
     and adding one would be a rewrite with no behavioral benefit.
4. **SQL lives only in `packages/db`.** API handlers and worker modules call db functions. SQL text is part of
   the observable behavior (tests observe it in `pg_stat_activity`), so moving a query never reformats it,
   except where `scripts/format-query-sql.mjs` already formats that text; queries tests observe are pinned in
   that script.
5. **Enforcement.** Biome `noRestrictedImports` overrides per package and app, and `noUndeclaredDependencies`
   against each `package.json`, run in `pnpm lint`. A forbidden import fails CI:
   - contracts imports no workspace package, `pg`, `fastify` or provider SDK;
   - core imports no `pg`, `fastify`, provider SDK or `@knowscroll/db`;
   - db imports no `fastify` or provider SDK;
   - the API imports no provider SDK and no worker file; the worker imports no `fastify` and no API file;
   - no relative specifier leaves its package or app.
6. **Module layout.** One responsibility per file. A split file keeps its entry module (its public face) and
   puts internals in a `<entry>/` folder beside it. No `index.ts` barrels inside a package other than the
   package root.
7. **Comments.** A file header (one to six lines) says what the module owns, the invariants a reader must not
   break, and the governing ADRs. Exported functions get JSDoc only when the signature does not tell the story
   (preconditions such as the transaction and locks, idempotent replay, what a refusal looks like). Inline
   comments explain why, never what. Positional, diff-narration and process-history comments are deleted; ADR
   and issue citations go at the end of a sentence.

## Consequences

- Old paths keep working in history only: [`docs/architecture/moved-paths.md`](../architecture/moved-paths.md)
  maps every moved file. Accepted ADRs, handoffs and journey evidence keep the paths they were written with.
- `package.json` changes in a package are now part of its contract; a new dependency must be declared where
  it is imported, or lint fails.
- Nothing here grants new authority to any component. Production identity (#2), provider dispatch rules and
  every privacy contract are unchanged.
