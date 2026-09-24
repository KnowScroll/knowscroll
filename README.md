# KnowScroll

**Come here when you want to scroll. Leave with a slightly larger world.**

KnowScroll is an emergent personal universe: Reel and Scroll encounters lead to questions, connections and revisable worlds. Planets, Stars, rooms and social exploration are central to the product. Engagement alone is not the objective.

## Start here

1. **[Shared checkpoint](docs/CHECKPOINT.md)** — owner decisions, deployed-versus-source truth and next action.
2. **[Project state](docs/PROJECT-STATE.md)** — what exists, evidence, next work and blockers.
3. **[Architecture](docs/architecture/README.md)** — the system and who owns each responsibility.
4. **[v1 release contract](docs/product/v1-release.md)** — the full experience/UI, real video integration and end-to-end acceptance required for v1.

The full [product definition](docs/product/definition.md) remains the target. This repository begins with one executable slice; it does not claim the full recommendation engine is built.

## Current delivery sequence

The owner requests [six implementation phases with continuous verification](docs/handoffs/2026-09-24-core-to-android.md)
under #72: semantics, reasoning, full Composer, living-world/Android integration, owner access/privacy,
and performance/acceptance. Cutroom stays last and owner-led; Social/Blend is deferred in #137
under the accepted single-user scope. PR130 is merged; these six phases are not yet delivered.
Older verified-slice descriptions below are historical bounded evidence, not current coverage of
every later capability. Start with the checkpoint and source.

## Verified slice

The Android app reads sourced Scrolls, records visible exposures and explicit keeps, and restores reading position after process death and Activity recreation. It offers source access while reading and deliberate end-of-content discovery with retained-page retry and finite-library rest. A real API and separate worker persist scoped events and saved Traces in PostgreSQL. Saved Traces reopen their verified original Scroll/source with read-only origin and fresh authority checks after restoration. Operator-issued device sessions expire and can be revoked; privacy epochs prevent obsolete work from changing state. Backend single-owner magic-link sign-in and AgentMail delivery exist; release-client sign-in, real generated Reels and semantic world evolution remain incomplete.

Clear Scroll history removes recorded encounters and saved Traces, preserves the shared library, and signs out other devices. Its retry and local-restoration boundaries are defined in [ADR-0010](docs/decisions/0010-clear-scroll-history.md). [Project state](docs/PROJECT-STATE.md) distinguishes implementation from the broader target and links runtime evidence.

A separate [MiniMax development certification](docs/journeys/evidence/wave4-certification/README.md) passed three live synthetic cases: JSON, a tool call with native thinking, and exact native continuation. Product reasoning remains unimplemented; the [runner guide](docs/operations/minimax-certification.md) defines the bounded experiment.

The accepted [reasoning admission protocol](docs/decisions/0012-reasoning-admission-and-reconciliation.md) defines the next implementation boundary: durable attempts, reservations, privacy fences and late usage. Its metadata schemas and [storage/privacy helpers](docs/operations/reasoning-storage.md) are implemented. [Atomic admission and cumulative reconciliation primitives](docs/operations/reasoning-runtime.md) now exist, with an unwired one-invocation worker boundary. [J004](docs/journeys/J004.md) verifies separate-process crash and late-usage boundaries with local fixtures; product dispatch remains disabled. [The accepted fairness policy/model](docs/operations/reasoning-fairness.md) validates bounded class and universe turns with deterministic traces. [Durable SQL fairness](docs/operations/reasoning-sql-fairness.md) now combines bounded service turns, claim and reservation, with retained corrections and privacy-safe debt. [Authorized frozen Scroll contexts](docs/operations/reasoning-context.md) now bind literal Keep evidence to the original session, exact source snapshot and typed reads. [Separate reasoning maintenance](docs/operations/reasoning-retirement.md) retires safely withdrawn cancelled/expired and safely completed/failed private context after seven days while preserving unresolved accounting. [Literal Ask recording](docs/operations/explicit-asks.md) now preserves exposure-anchored person-written questions with a recorded-only receipt. It creates no queue, answer or mobile control. [Sealed literal Ask contexts](docs/operations/reasoning-ask-context.md) now bind a separately supplied direct Job to the original Ask/session and exact source dependencies. Proposal, intent-execution lifecycle and broader privacy gates still precede product reasoning.

The [pinned Cutroom HTTP client](docs/operations/cutroom-http-client.md), bounded generation/import, publication gates, eligible inventory and authenticated media-serving foundations exist. Supplied test media has actual Android playback evidence. Real provider generation and the Visual Witness gate remain unproved; owner-led Cutroom integration is deferred until after the six personal delivery phases.

## Chosen stack

| Part | Choice |
|---|---|
| Android | Kotlin + Jetpack Compose; native Android first |
| API / deterministic core | TypeScript, Node 22, Fastify |
| History, state and jobs | PostgreSQL 16; separate API and worker processes |
| Reasoning | AI SDK behind a provider port; bounded MiniMax development certification passed |
| Video generation | [Cutroom](https://github.com/KnowScroll/Cutroom), separate service; client/import/publication foundations, real-provider integration deferred |

See the [ADRs](docs/decisions/README.md) for alternatives and consequences. One repository lets contracts evolve together; deployments remain independent.

## Run it

These are setup commands, not a claim the owner deployment is current. Read the checkpoint
before running initialization against existing data; use disposable environments for acceptance.

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

Upgrading the owner's installation (a verified backup before every migrate, rollback by restoring it, restart and health checks) is [deployment](docs/operations/deployment.md); the three inputs only the owner supplies for a release are [release inputs](docs/operations/release-inputs.md).

For repeatable acceptance without consuming the owner's remaining library, use `pnpm exec tsx scripts/run-isolated-journey.ts` (J001) and `pnpm exec tsx scripts/run-isolated-session-journey.ts` (J002), plus `pnpm exec tsx scripts/run-isolated-history-journey.ts` (J003). [J004](docs/journeys/J004.md) adds reasoning fault cases and independent interruption cleanup checks. These launch disposable PostgreSQL/API/worker runtimes. See [development operations](docs/operations/development.md) for session provisioning, Android checks and evidence limits.

## Work together

[GitHub Project](https://github.com/orgs/KnowScroll/projects/1) · [Issues](https://github.com/KnowScroll/knowscroll/issues) · [Contribution workflow](CONTRIBUTING.md)

Agents start with [AGENTS.md](AGENTS.md); Claude imports it through CLAUDE.md. Use separate SSD worktrees and scoped ownership. This project does not depend on a custom orchestrator.
