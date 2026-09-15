# KnowScroll

**Come here when you want to scroll. Leave with a slightly larger world.**

KnowScroll is an emergent personal universe: Reel and Scroll encounters lead to questions, connections and revisable worlds. Planets, Stars, rooms and social exploration are central to the product. Engagement alone is not the objective.

## Start here

1. **[Project state](docs/PROJECT-STATE.md)** — what exists, evidence, next work and blockers.
2. **[Architecture](docs/architecture/README.md)** — the system and who owns each responsibility.

The full [product definition](docs/product/definition.md) remains the target. This repository begins with one executable slice; it does not claim the full recommendation engine is built.

## Chosen stack

| Part | Choice |
|---|---|
| Android | Kotlin + Jetpack Compose; native Android first |
| API / deterministic core | TypeScript, Node 22, Fastify |
| History, state and jobs | PostgreSQL 16; separate API and worker processes |
| Reasoning | AI SDK behind a provider port; MiniMax certification pending |
| Video generation | [Cutroom](https://github.com/KnowScroll/Cutroom), separately deployed |

See the [ADRs](docs/decisions/README.md) for alternatives and consequences. One repository lets contracts evolve together; deployments remain independent.

## Run it

```sh
# From this repository on the configured Mac:
. ./scripts/env.sh
pnpm install --frozen-lockfile
./scripts/dev-init.sh
pnpm dev:api       # terminal 1
pnpm dev:worker    # terminal 2
# Android build/install: docs/operations/development.md
```

`pnpm typecheck` and `pnpm test` check implementation. `pnpm verify:journey` exercises real HTTP, worker and database; Android evidence is a separate check. `pnpm state` reads current migrations, worker heartbeat and API availability.

## Work together

[GitHub Project](https://github.com/orgs/KnowScroll/projects/1) · [Issues](https://github.com/KnowScroll/knowscroll/issues) · [Contribution workflow](CONTRIBUTING.md)

Agents start with [AGENTS.md](AGENTS.md); Claude imports it through CLAUDE.md. Use separate SSD worktrees and scoped ownership. This project does not depend on a custom orchestrator.
