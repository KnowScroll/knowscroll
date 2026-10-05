# @knowscroll/core

Pure, deterministic rules: the Composer that ranks candidates into a slate, the Cartographer that
places a reader's sightings into an Atlas, the room Keeper, Quartermaster inventory targets, the
Scroll writing and validation rules, semantic attention and bridge validation, and the Cutroom
request preparer. Every function takes a recorded snapshot and returns a result; the caller loads
the snapshot and persists the output.

## Entry points

There is no package root and no barrel. Import by subpath with no extension, for example
`@knowscroll/core/composer/semantic` or `@knowscroll/core/shared/canonical-json`
(the `exports` map is `"./*"` to `./src/*.ts`).

| Folder | Owns |
|---|---|
| `src/composer/` | `signals.ts` (composer-signals-v1/v2) and `semantic.ts` (composer-semantic-v3/v4) |
| `src/semantic/` | attention hypotheses, bridge validation, source text |
| `src/atlas/`, `src/rooms/` | the Cartographer and the room Keeper |
| `src/scrolls/` | Scroll material, writing rules, the web artifact |
| `src/reasoning/` | wire shapes for answers and bridge inquiries |
| `src/inventory/`, `src/cutroom/` | Quartermaster targets, Cutroom request preparation |
| `src/shared/` | canonical JSON, comparison, FNV hashing, number helpers |

## Rules a contributor must not break

- No database, HTTP, provider or UI import: no `pg`, `fastify`, provider SDK or `@knowscroll/db`.
  `pnpm lint` enforces it ([ADR-0048](../../docs/decisions/0048-backend-module-boundaries.md)).
- Ranking changes need a new immutable policy version and journey evidence, never an edit to a
  scoring constant ([AGENTS.md](AGENTS.md); ADR-0029, ADR-0032).
- `src/shared/canonical-json.ts` is sorted-key canonical JSON. The insertion-order `JSON.stringify`
  hashes in `packages/db/src/reasoning/` are different on purpose; never unify them.
- Core reads nothing from the clock or the environment on its own: time and randomness arrive as
  arguments so a reader can recompute a stored decision.
- Import, layout and comment conventions: "Code conventions" in
  [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Where to start reading

1. [AGENTS.md](AGENTS.md): the ownership notes, including the Composer history.
2. `src/shared/canonical-json.ts` and `src/shared/fnv.ts`: the two hash helpers many rules rely on.
3. `src/composer/signals.ts`: the smaller ranking policy, a complete pure example.
4. `src/composer/semantic.ts`: the default Composer.
5. `src/atlas/cartographer.ts`, then `src/rooms/keeper.ts`.

Dependency graph: [docs/architecture/module-map.md](../../docs/architecture/module-map.md).
Moved files: [docs/architecture/moved-paths.md](../../docs/architecture/moved-paths.md).
