# Repository cleanup inventory

Issue [#679](https://github.com/KnowScroll/knowscroll/issues/679). Base: `11222a21a823` on `dev`.
One branch: `claude/679-repository-cleanup`. Continue in the SSD worktree
`/Volumes/Mrigesh SSD/knowscroll-worktrees/repository-cleanup`.

This is a tracked-tree inventory, not a claim that every file has been reviewed. A pending area
still needs its source, dynamic callers, owning decisions and README checked. Counts are at the
base revision. Generated dependencies are outside the inventory. Archive and immutable inputs
are retained as history. The PR carries the short progress checklist.

## Reading order

Start with [Account](../../../packages/backend/src/modules/identity/README.md#account-deletion-d-043),
then the app/package entry points, backend modules and infrastructure, and finally migrations,
tests, scripts and operations. Read changes by commit; focused checks belong beside each result.

## Areas

| Tracked area | Files | README(s) | Review result |
| --- | ---: | --- | --- |
| `.claude` | 3 | — | Pending |
| `.dependency-cruiser.cjs` | 1 | — | Pending |
| `.gitattributes` | 1 | — | Pending |
| `.github` | 6 | — | Pending |
| `.gitignore` | 1 | — | Pending |
| `.npmrc` | 1 | — | Pending |
| `.nvmrc` | 1 | — | Pending |
| `.prettierignore` | 1 | — | Pending |
| `.prettierrc.json` | 1 | — | Pending |
| `apps/api` | 105 | [apps/api/README.md](../../../apps/api/README.md) | Changed: added request/wiring/check entry points and corrected route-index comment. Account traced; other controllers/operators pending. |
| `apps/client` | 10 | [apps/client/README.md](../../../apps/client/README.md) | Pending |
| `apps/client/app` | 46 | — | Pending |
| `apps/client/e2e` | 77 | — | Pending |
| `apps/client/features/account` | 14 | — | Pending |
| `apps/client/features/auth` | 11 | — | Pending |
| `apps/client/features/conversations` | 33 | — | Pending |
| `apps/client/features/diagnostics` | 5 | — | Pending |
| `apps/client/features/encounter` | 46 | — | Pending |
| `apps/client/features/explore` | 6 | — | Pending |
| `apps/client/features/feedback` | 9 | [apps/client/features/feedback/README.md](../../../apps/client/features/feedback/README.md) | Pending |
| `apps/client/features/friends` | 13 | [apps/client/features/friends/README.md](../../../apps/client/features/friends/README.md) | Pending |
| `apps/client/features/gallery` | 7 | — | Pending |
| `apps/client/features/not-found` | 1 | — | Pending |
| `apps/client/features/operator` | 7 | — | Pending |
| `apps/client/features/privacy` | 10 | [apps/client/features/privacy/README.md](../../../apps/client/features/privacy/README.md) | Changed: linked deletion authority walkthrough and corrected native persistence; remaining privacy controls pending. |
| `apps/client/features/reel` | 5 | — | Pending |
| `apps/client/features/requests` | 23 | — | Pending |
| `apps/client/features/rooms` | 104 | — | Pending |
| `apps/client/features/saved` | 17 | — | Pending |
| `apps/client/features/scenarios` | 35 | — | Pending |
| `apps/client/features/scroll` | 23 | — | Pending |
| `apps/client/features/sharing` | 19 | — | Pending |
| `apps/client/features/shell` | 7 | — | Pending |
| `apps/client/features/threads` | 41 | — | Pending |
| `apps/client/features/universe` | 138 | — | Pending |
| `apps/client/features/visibility` | 7 | [apps/client/features/visibility/README.md](../../../apps/client/features/visibility/README.md) | Pending |
| `apps/client/features/visit` | 9 | [apps/client/features/visit/README.md](../../../apps/client/features/visit/README.md) | Pending |
| `apps/client/maestro` | 13 | — | Pending |
| `apps/client/platform` | 36 | — | Pending |
| `apps/client/plugins` | 3 | — | Pending |
| `apps/client/providers` | 4 | — | Pending |
| `apps/client/theme` | 2 | — | Pending |
| `apps/worker` | 29 | [apps/worker/README.md](../../../apps/worker/README.md) | Changed: added delivery/authority/operator reading order; worker unit tests passed with SSD TMPDIR. Remaining consumers/operators pending. |
| `content` | 89 | [content/README.md](../../../content/README.md) | Pending |
| `docs` | 1 | — | Pending |
| `docs/archive` | 8 | [docs/archive/README.md](../../../docs/archive/README.md), [docs/archive/discovery-2026-10-19/README.md](../../../docs/archive/discovery-2026-10-19/README.md) | Pending |
| `docs/v2` | 240 | [docs/v2/README.md](../../../docs/v2/README.md), [docs/v2/architecture/README.md](../../../docs/v2/architecture/README.md), [docs/v2/architecture/design-references/README.md](../../../docs/v2/architecture/design-references/README.md), [docs/v2/design/README.md](../../../docs/v2/design/README.md), [docs/v2/design/v3/README.md](../../../docs/v2/design/v3/README.md), [docs/v2/v3-revamp/README.md](../../../docs/v2/v3-revamp/README.md) | Pending |
| `migrations` | 110 | [migrations/README.md](../../../migrations/README.md) | Pending |
| `ops/pool` | 4 | [ops/pool/README.md](../../../ops/pool/README.md) | Pending |
| `ops/vps` | 58 | [ops/vps/README.md](../../../ops/vps/README.md) | Pending |
| `packages/backend` | 6 | [packages/backend/README.md](../../../packages/backend/README.md) | Changed: replaced obsolete unwired-feature summaries with current module ownership and focused checks; checked package exports and composition roots. |
| `packages/backend/src/erasure-registry.ts` | 1 | — | Pending |
| `packages/backend/src/infrastructure/config` | 7 | [packages/backend/src/infrastructure/config/README.md](../../../packages/backend/src/infrastructure/config/README.md) | Changed: retained the clear ownership/authority/recovery reference and added runnable focused checks. |
| `packages/backend/src/infrastructure/erasure` | 7 | [packages/backend/src/infrastructure/erasure/README.md](../../../packages/backend/src/infrastructure/erasure/README.md) | Changed: retained the clear ownership/authority/recovery reference and added runnable focused checks. |
| `packages/backend/src/infrastructure/ids` | 6 | [packages/backend/src/infrastructure/ids/README.md](../../../packages/backend/src/infrastructure/ids/README.md) | Changed: documented both UUID helpers, job identity and authority limits. |
| `packages/backend/src/infrastructure/jobs` | 8 | [packages/backend/src/infrastructure/jobs/README.md](../../../packages/backend/src/infrastructure/jobs/README.md) | Changed: linked the complete release and gated consumer registries; preserved schedule and retry ownership. |
| `packages/backend/src/infrastructure/lifecycle` | 3 | [packages/backend/src/infrastructure/lifecycle/README.md](../../../packages/backend/src/infrastructure/lifecycle/README.md) | Changed: retained the clear ownership/authority/recovery reference and added runnable focused checks. |
| `packages/backend/src/infrastructure/media-store` | 4 | [packages/backend/src/infrastructure/media-store/README.md](../../../packages/backend/src/infrastructure/media-store/README.md) | Changed: rewrote staging, publication, filesystem safety and crash recovery as an import journey. |
| `packages/backend/src/infrastructure/notices` | 5 | [packages/backend/src/infrastructure/notices/README.md](../../../packages/backend/src/infrastructure/notices/README.md) | Changed: retained the clear ownership/authority/recovery reference and added runnable focused checks. |
| `packages/backend/src/infrastructure/observability` | 8 | [packages/backend/src/infrastructure/observability/README.md](../../../packages/backend/src/infrastructure/observability/README.md) | Changed: retained the clear ownership/authority/recovery reference and added runnable focused checks. |
| `packages/backend/src/infrastructure/postgres` | 11 | [packages/backend/src/infrastructure/postgres/README.md](../../../packages/backend/src/infrastructure/postgres/README.md) | Changed: retained the clear ownership/authority/recovery reference and added runnable focused checks. |
| `packages/backend/src/infrastructure/receipts` | 7 | [packages/backend/src/infrastructure/receipts/README.md](../../../packages/backend/src/infrastructure/receipts/README.md) | Changed: retained the clear ownership/authority/recovery reference and added runnable focused checks. |
| `packages/backend/src/infrastructure/research` | 2 | [README](../../../packages/backend/src/infrastructure/research/README.md) (added) | Changed: added the missing caller, network-policy, refusal and fixture guide. |
| `packages/backend/src/job-queues.ts` | 1 | — | Pending |
| `packages/backend/src/modules/composer` | 40 | [packages/backend/src/modules/composer/README.md](../../../packages/backend/src/modules/composer/README.md) | Pending |
| `packages/backend/src/modules/content` | 188 | [packages/backend/src/modules/content/README.md](../../../packages/backend/src/modules/content/README.md), [packages/backend/src/modules/content/adapters/cutroom/wire-v1/README.md](../../../packages/backend/src/modules/content/adapters/cutroom/wire-v1/README.md), [packages/backend/src/modules/content/domain/library/README.md](../../../packages/backend/src/modules/content/domain/library/README.md), [packages/backend/src/modules/content/production/README.md](../../../packages/backend/src/modules/content/production/README.md) | Changed: added production/admission journey and checks; coverage and nested library/production/vendor review pending. |
| `packages/backend/src/modules/evidence` | 40 | [packages/backend/src/modules/evidence/README.md](../../../packages/backend/src/modules/evidence/README.md) | Changed: intake-to-projection journey, recording-batch example and current composition; retained original-generation and erasure rules. |
| `packages/backend/src/modules/experience` | 55 | [packages/backend/src/modules/experience/README.md](../../../packages/backend/src/modules/experience/README.md) | Changed: explained offer/open/activation distinction and retry behavior; corrected open comment to include Reels. Remaining navigation/Keep paths pending. |
| `packages/backend/src/modules/feedback` | 14 | [packages/backend/src/modules/feedback/README.md](../../../packages/backend/src/modules/feedback/README.md) | Pending |
| `packages/backend/src/modules/geography` | 31 | [packages/backend/src/modules/geography/README.md](../../../packages/backend/src/modules/geography/README.md) | Changed: clarified reasoning-harness authority comment against active-run/claim/hash checks. Remaining formation rules and README pass pending. |
| `packages/backend/src/modules/identity` | 41 | [packages/backend/src/modules/identity/README.md](../../../packages/backend/src/modules/identity/README.md) | Changed: traced deletion across device, API, locks, erasers and recovery; replaced stale native-storage guidance. Other Identity paths pending. |
| `packages/backend/src/modules/operator` | 16 | [packages/backend/src/modules/operator/README.md](../../../packages/backend/src/modules/operator/README.md) | Pending |
| `packages/backend/src/modules/personal-context` | 19 | [packages/backend/src/modules/personal-context/README.md](../../../packages/backend/src/modules/personal-context/README.md) | Changed: explained snapshot consumers and separated legacy unavailable facets from implemented trusted coverage. Recording and erasure rules preserved. |
| `packages/backend/src/modules/planner` | 17 | [packages/backend/src/modules/planner/README.md](../../../packages/backend/src/modules/planner/README.md) | Pending |
| `packages/backend/src/modules/play` | 19 | [packages/backend/src/modules/play/README.md](../../../packages/backend/src/modules/play/README.md) | Pending |
| `packages/backend/src/modules/rooms` | 181 | [packages/backend/src/modules/rooms/README.md](../../../packages/backend/src/modules/rooms/README.md) | Pending |
| `packages/backend/src/modules/scenarios` | 35 | [packages/backend/src/modules/scenarios/README.md](../../../packages/backend/src/modules/scenarios/README.md) | Pending |
| `packages/backend/src/modules/scenes` | 20 | [packages/backend/src/modules/scenes/README.md](../../../packages/backend/src/modules/scenes/README.md) | Changed: replaced obsolete future-adapter wording with current projection/API/formation journey and focused checks; retained allocation and recovery rules. |
| `packages/backend/src/modules/social` | 76 | [packages/backend/src/modules/social/README.md](../../../packages/backend/src/modules/social/README.md) | Pending |
| `packages/backend/src/modules/supply` | 51 | [packages/backend/src/modules/supply/README.md](../../../packages/backend/src/modules/supply/README.md) | Pending |
| `packages/backend/src/reasoning` | 48 | [packages/backend/src/reasoning/README.md](../../../packages/backend/src/reasoning/README.md), [packages/backend/src/reasoning/adapters/minimax/README.md](../../../packages/backend/src/reasoning/adapters/minimax/README.md) | Pending |
| `packages/client-core` | 145 | [packages/client-core/README.md](../../../packages/client-core/README.md) | Changed: added account lifetime and recovery reading order; 64 files / 872 unit tests passed. Remaining controller review pending. |
| `packages/contracts` | 85 | [packages/contracts/README.md](../../../packages/contracts/README.md) | Changed: explained schema versus runtime authority, compatibility and focused tests; contract reference review remains pending. |
| `packages/design-tokens` | 20 | [packages/design-tokens/README.md](../../../packages/design-tokens/README.md), [packages/design-tokens/fonts/README.md](../../../packages/design-tokens/fonts/README.md) | Pending |
| `packages/scene-core` | 34 | [packages/scene-core/README.md](../../../packages/scene-core/README.md) | Pending |
| `packages/scroll-model` | 165 | [packages/scroll-model/README.md](../../../packages/scroll-model/README.md), [packages/scroll-model/fixtures/README.md](../../../packages/scroll-model/fixtures/README.md) | Pending |
| `packages/ui` | 286 | [packages/ui/README.md](../../../packages/ui/README.md) | Pending |
| `root` | 11 | [README.md](../../../README.md) | Changed: newcomer setup, request journey, package map and check commands; root configuration/dependency manifests checked. Root tooling review continues below. |
| `scripts` | 4 | — | Pending |
| `scripts/issue-context` | 3 | — | Pending |
| `scripts/release` | 3 | — | Pending |
| `tests/integration` | 215 | [tests/integration/README.md](../../../tests/integration/README.md) | Pending |

## Removal evidence and retained candidates

Baseline `pnpm knip` passed with no reported unused code. No deletion has yet been justified.
Knip is a lead, not a proof: retain package exports, Nest providers, pg-boss payloads/schedules,
Expo routes, platform variants, operator commands and compatibility readers until callers and
supported records have been traced. Do not delete migrations, pinned Cutroom wire files,
immutable design inputs or supported-behavior fixtures.

## Verification and next action

Dependencies installed from the frozen lockfile. Account source traced against D-043; no live
account deletion performed. Client-core suite passed: 64 files, 872 tests (the package command forwarded `--` and ran the full suite). Continue the pending inventory.
Format, typecheck and dependency boundaries passed after Account. API, worker and contracts unit suites passed after entry-point edits with `TMPDIR` on the SSD. The first worker run used macOS default temp paths and hit the intentional symlink refusal; no assertion was changed. Combined checks on the final head, complete-diff review, merge and dev verification remain outstanding.

Backend baseline unit run: 196 files / 2,298 tests passed; one media-probe test failed because
its default executable `/usr/bin/ffprobe` is absent on this Mac (Homebrew has `/opt/homebrew/bin/ffprobe`).
No media implementation or assertion was changed. Hosted CI installs the expected executable.
This is an environment limitation, not a passing full backend suite.

Focused module and infrastructure suites passed after these documentation/comment changes (see PR verification).
Retained CLI candidate: `scripts/check-library-sources.mjs` is called by the Scroll production runbook;
its dynamic import reaches the built research adapter. Retained `build-cutroom-wire.mjs` is called by
the backend build and copies the pinned vendor schema. Neither is dead merely because it lacks a
TypeScript importer. No runtime or immutable-input removal is proposed.
