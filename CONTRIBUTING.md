# Working together

## Start a session

Read CHECKPOINT → README → PROJECT-STATE → assigned issue → relevant ADR/contract and scoped AGENTS. Check `git status`, fetch remote, and inspect `pnpm state` when changing runtime. Do not reconstruct the project from historical proposals.

Claim an issue in GitHub and name your lane. Use a separate worktree under `/Volumes/Mrigesh SSD/knowscroll-worktrees/`. Do not let two sessions own the same schema or contract edit. Shared contracts land first, then dependent consumers rebase. A worktree isolates files, not ports, databases or provider budgets: give running lanes distinct ports/databases; integration uses the coordinator environment.

## Main brain

The coordinator selects the next useful outcome, clarifies acceptance and dependencies, assigns bounded lanes, reviews the actual diff and evidence, integrates contracts/ADRs, verifies the joined journey, and updates project state. Claude Code, Codex and GitHub are enough. No KnowScroll-specific orchestration service is required.

## Review and integration

Use `codex/<issue>-<name>` or the chosen harness prefix; PRs target main. Keep main runnable. No force pushes or resets of another session's work. Keep Cutroom changes in Cutroom with an explicit versioned contract proposal. Agent advice is untrusted until reviewed.

A PR explains the user-visible change, relevant issue/ADR, changed boundaries, implementation checks, observed journey and exact limitations. Put routine session handoffs in the issue or PR, not permanent chat transcripts. If work pauses before a PR exists, leave the same short handoff in its issue.

## Truth update rule

A substantial change reconnects six things: owner outcome → issue requirements → ADR/architecture → code → runtime receipt → next-session entry point. Update only artifacts whose truth changed. A fresh snapshot belongs in evidence; a new permanent capability belongs in PROJECT-STATE. Architecture changes supersede ADRs instead of editing history away.

Do not mark a journey proven because typecheck passed. Do not mark target components implemented because an interface exists. Do not commit secrets, local database content, raw provider thinking, or large generated media.

## GitHub enforcement limitation

GitHub returned HTTP403 when enabling branch protection for this private repository on the current plan. The repository remains private. CI and PR templates are active, but required checks/reviews and force-push protection are not server-enforced. Use the documented review workflow; enabling enforcement later requires an eligible GitHub plan. No subscription was changed.

## Shared checkpoint

Read [system navigation](docs/operations/system-navigation.md) and keep the coordinator-owned
[checkpoint](docs/CHECKPOINT.md) current through compaction and handoffs. Runtime observations
are timestamped and distinct from source status. [Delivery history](docs/operations/delivery-history.md)
links decisions to changes; GitHub remains the task board.

## Code conventions

The backend (`apps/api`, `apps/worker`, `packages/*`) follows [ADR-0048](docs/decisions/0048-backend-module-boundaries.md).
The package and folder layout is in [the module map](docs/architecture/module-map.md); each package and
app has a README with its entry points and the rules local to it. `pnpm lint` and `pnpm format:check`
enforce what a tool can check.

### Imports

- Across packages, import `@knowscroll/<pkg>` or `@knowscroll/<pkg>/<subpath>`, with no file extension.
- Within a package, import by relative path, ending in `.ts`. A relative path never leaves its package or app.
- Apps are imported only by the repository-level `tests/` and `scripts/`, by relative path.
- Order imports as node built-ins, external packages, `@knowscroll/*`, then relative (Biome `organizeImports`).
- Use `import type` for imports that are only used as types. When every name in an import is a type,
  write `import type { a, b }` rather than `import { type a, type b }`.

### Module layout

- One responsibility per file.
- A file that grows too large keeps its entry module as its public face and moves internals into a
  folder named after it, beside it (`reasoning/admission.ts` with `reasoning/admission/`).
- No `index.ts` barrels inside a package. Only the package root may have one.

### SQL

- SQL lives only in `packages/db`; `scripts/check-architecture.mjs` (run by `pnpm lint`) fails on a
  `.query(` call under `apps/`. API handlers and worker loops call db functions.
- A db function's JSDoc says whether it owns its transaction or needs the caller's `client`, and which
  locks it expects to be held.
- Some tests observe live statements in `pg_stat_activity`. Those statements are pinned in
  `TEXT_OBSERVED_BY_TESTS` in `scripts/format-query-sql.mjs`; moving one never changes its text.

### Errors

- `packages/db` throws a domain error carrying `statusCode` for a refusal the client can see, or returns
  a `{ kind }` union where callers branch.
- The API maps errors in one place, the global handler in `apps/api/src/app.ts`, plus the two documented
  `kind` mappers (`routes/asks.ts` and `routes/universe.ts`).

### Comments

- Start each file with a header of one to six lines: what the module owns, the invariants a reader must
  not break, and the governing ADRs.
- Write JSDoc on an exported function only when the signature does not tell the story: transaction or
  lock preconditions, idempotent replay, or what a refusal looks like.
- Inline comments explain why, never what the next line does.
- Do not leave positional, diff-narration or process-history comments ("this slice", "review I3", "used
  to"). Put ADR and issue citations at the end of a sentence, not at the start.
