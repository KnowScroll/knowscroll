# @knowscroll/contracts

The wire schemas of the backend: zod shapes for the requests, responses and stored payloads that
cross a process or package boundary (exposures and Keeps, the feed, Asks and answers, reasoning
jobs and sealed contexts, Atlas, Relics, rooms, generation briefs, publication gates, privacy and
sign-in). Parsing a shape here grants no authority and performs no database transition: it only
says what is well formed.

## Entry points

- `src/index.ts` is the package root (`@knowscroll/contracts`): it re-exports the topical modules
  most callers need (`asks`, `ledger`, `privacy`, `sign-in`, and `uuid`).
- Every other module is imported by subpath with no extension, for example
  `@knowscroll/contracts/inventory` or `@knowscroll/contracts/reasoning-context`
  (the `exports` map in `package.json` is `"."` and `"./*"` to `./src/*.ts`).
- `src/cutroom-v1/` is the vendored Cutroom protocol: copied byte-for-byte, hash-checked by
  `tests/cutroom-http.test.ts`. Never edit it.

## Rules a contributor must not break

- Imports no other workspace package, `pg`, `fastify` or a provider SDK; only `zod` and the
  standard library. Lint (`pnpm lint`, Biome `noRestrictedImports`) enforces it
  ([ADR-0048](../../docs/decisions/0048-backend-module-boundaries.md)).
- Input schemas are strict: an unknown field is a refusal, never silently dropped.
- PostgreSQL `bigint` wire values stay strings (`reasoningCounter`); no value passes through a lossy
  JS number.
- Stored hashes depend on the pinned compiler versions and limits in `reasoning-context.ts` and
  `reasoning-ask-context.ts`; change them only through a new version.
- Import and comment conventions are in the "Code conventions" section of
  [CONTRIBUTING.md](../../CONTRIBUTING.md). The scoped ownership rules for the packages that
  consume these schemas are in [packages/core/AGENTS.md](../core/AGENTS.md) and
  [packages/db/AGENTS.md](../db/AGENTS.md).

## Where to start reading

1. `src/primitives.ts`: the shared `uuid` and `privacyEpoch` types.
2. `src/ledger.ts`: exposure, Keep and Scroll asset shapes, the smallest complete example.
3. `src/inventory.ts`: the feed items and `parseFeedKinds`.
4. `src/reasoning.ts`, then `src/reasoning-context.ts`: the job lifecycle and the sealed context.
5. `src/generation.ts` and `src/publication.ts`: editorial briefs and publication gates.

The package and folder dependency graph is in
[docs/architecture/module-map.md](../../docs/architecture/module-map.md); old file paths are in
[docs/architecture/moved-paths.md](../../docs/architecture/moved-paths.md).
