# Moved paths

The backend refactor in [#196](https://github.com/KnowScroll/knowscroll/issues/196) ([ADR-0048](../decisions/0048-backend-module-boundaries.md))
moved files without changing what they do. Accepted ADRs, handoffs and journey evidence keep the paths they
were written with; this table maps each old path to its current home. Imports across packages now use package
names (`@knowscroll/db/reasoning/admission`, not a relative path).

## packages/db and packages/core (R4)

| Old path | Current path |
|---|---|
| `packages/db/src/reasoning-admission.ts` | `packages/db/src/reasoning/admission.ts` |
| `packages/db/src/reasoning-answers.ts` | `packages/db/src/reasoning/answers.ts` |
| `packages/db/src/reasoning-ask-context.ts` | `packages/db/src/reasoning/ask-context.ts` |
| `packages/db/src/reasoning-context-authority.ts` | `packages/db/src/reasoning/context-authority.ts` |
| `packages/db/src/reasoning-context-session.ts` | `packages/db/src/reasoning/context-session.ts` |
| `packages/db/src/reasoning-context.ts` | `packages/db/src/reasoning/context.ts` |
| `packages/db/src/reasoning-fairness-accounting.ts` | `packages/db/src/reasoning/fairness-accounting.ts` |
| `packages/db/src/reasoning-fairness-policy.ts` | `packages/db/src/reasoning/fairness-policy.ts` |
| `packages/db/src/reasoning-fairness.ts` | `packages/db/src/reasoning/fairness.ts` |
| `packages/db/src/reasoning-idle-fairness.ts` | `packages/db/src/reasoning/idle-fairness.ts` |
| `packages/db/src/reasoning-idle-lifecycle-contract.ts` | `packages/db/src/reasoning/idle-lifecycle-contract.ts` |
| `packages/db/src/reasoning-idle-lifecycle.ts` | `packages/db/src/reasoning/idle-lifecycle.ts` |
| `packages/db/src/reasoning-inquiries.ts` | `packages/db/src/reasoning/inquiries.ts` |
| `packages/db/src/reasoning-inquiry-context.ts` | `packages/db/src/reasoning/inquiry-context.ts` |
| `packages/db/src/reasoning-inquiry-execution.ts` | `packages/db/src/reasoning/inquiry-execution.ts` |
| `packages/db/src/reasoning-maintenance.ts` | `packages/db/src/reasoning/maintenance.ts` |
| `packages/db/src/reasoning-reconciliation.ts` | `packages/db/src/reasoning/reconciliation.ts` |
| `packages/db/src/reasoning-runtime-policy.ts` | `packages/db/src/reasoning/runtime-policy.ts` |
| `packages/db/src/reasoning-storage.ts` | `packages/db/src/reasoning/storage.ts` |
| `packages/db/src/composer-signals.ts` | `packages/db/src/composer/signals.ts` |
| `packages/core/src/composer.ts` | `packages/core/src/composer/signals.ts` |

The db barrel's infrastructure (`loadLocalEnv`, `pool`, `OWNER_ID`, `transaction`, `lockUniverse`) moved from
`packages/db/src/index.ts` into `packages/db/src/connection.ts`; `@knowscroll/db` still exports the same names.

## apps/worker (R11)

| Old path | Current path |
|---|---|
| `apps/worker/src/providers/answer-fixture.ts` | `apps/worker/src/providers/fixtures/answer.ts` |
| `apps/worker/src/providers/inquiry-fixture.ts` | `apps/worker/src/providers/fixtures/inquiry.ts` |
| `apps/worker/src/providers/scroll-fixture.ts` | `apps/worker/src/providers/fixtures/scroll.ts` |
| `apps/worker/src/providers/certification-contract.ts` | `apps/worker/src/providers/certification/contract.ts` |
| `apps/worker/src/providers/certification-journal.ts` | `apps/worker/src/providers/certification/journal.ts` |
| `apps/worker/src/providers/minimax-certification.ts` | `apps/worker/src/providers/certification/minimax.ts` |
| `apps/worker/src/reasoning/answer-loop.ts` | `apps/worker/src/reasoning/transport-selection.ts` (`answerTransportsFromEnvironment`) |
| `apps/worker/src/reasoning/inquiry-loop.ts` | `apps/worker/src/reasoning/transport-selection.ts` (`inquiryTransportsFromEnvironment`) |

The transport and observation types moved from `answer-worker.ts`, `inquiry-worker.ts` and `scrolls/write-scroll.ts` into `apps/worker/src/providers/transports.ts`; `createReadinessGate` from `answer-worker.ts` into `reasoning/readiness-gate.ts`; `scrollTransportsFromEnvironment` from `scrolls/supply-worker.ts` into `reasoning/transport-selection.ts`. `cutroom/port.ts` and `providers/port.ts` were unused reservations and are deleted.
