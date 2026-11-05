# Repository cleanup inventory

Issue [#679](https://github.com/KnowScroll/knowscroll/issues/679). Base: `11222a21a823` on `dev`.
One branch: `claude/679-repository-cleanup`. Continue in the SSD worktree
`/Volumes/Mrigesh SSD/knowscroll-worktrees/repository-cleanup`.

The area review is complete. Each row records the ownership, source/caller and documentation
pass; unchanged areas are retained with a concrete reason. This is a maintenance review, not a
claim that static analysis proves every runtime path or that no future cleanup is possible. Counts are at the
base revision. Generated dependencies are outside the inventory. Archive and immutable inputs
are retained as history. The PR carries the short progress checklist.

## Reading order

Start with [Account](../../../packages/backend/src/modules/identity/README.md#account-deletion-d-043),
then the app/package entry points, backend modules and infrastructure, and finally migrations,
tests, scripts and operations. Read changes by commit; focused checks belong beside each result.

## Areas

| Tracked area | Files | README(s) | Review result |
| --- | ---: | --- | --- |
| `.claude` | 3 | — | Already clear: main-update hook preserves owner-only main writes; refusal/allowance fixtures passed. |
| `.dependency-cruiser.cjs` | 1 | Changed: clarified current client roots; reviewed composition, pure-layer, public-port, play and Launch walls. Rules unchanged; probes cover forbidden imports. |
| `.gitattributes` | 1 | — | Already clear: design CRLF bytes are protected against checkout conversion; unchanged. |
| `.github` | 6 | Already clear: checked six hosted jobs, push-only deployment and optional label/dispatch native lane with disposable API; no runner, trigger or deploy authority changed. |
| `.gitignore` | 1 | — | Already clear: credentials, build output, caches and local generated state are excluded; unchanged. |
| `.npmrc` | 1 | — | Already clear: pnpm store follows KS_DEV_ROOT; frozen install used the SSD root. |
| `.nvmrc` | 1 | — | Already clear: exact Node version linked by root setup; unchanged. |
| `.prettierignore` | 1 | — | Already clear: code/config scope intentionally excludes Markdown, immutable inputs and generated database types; checked changed Markdown links separately. |
| `.prettierrc.json` | 1 | — | Already clear: deterministic code format; current format check passed, no config edit. |
| `apps/api` | 105 | Changed: checked explicit controllers, scoped caller guard, sessionless receipts/downloads, public share landing and operator CLI; clarified guard intent and retained every HTTP/CLI entry. |
| `apps/client` | 10 | Changed: corrected optional native CI and direct-open versus Composer paths; manifests, Metro/Jest/Expo entries and build flags retain web/native resolution. |
| `apps/client/app` | 46 | Already clear: enumerated all file routes, layouts, redirects, dynamic parameters and gated gallery requires. Expo default exports are runtime entry points, not deletions. |
| `apps/client/e2e` | 77 | Changed: added production/gallery server, fixture, browser and focused-command guide; retained specs, helper fixtures and media used by smoke journeys. |
| `apps/client/features/account` | 14 | Changed: Account walkthrough covers sessions, export and deletion; device preferences remain outside scope, deletion receipt survives sign-out. No UI or command semantics changed. |
| `apps/client/features/auth` | 11 | Already clear: explicit peek/redemption, stable command retry, recovery and native verifier boundaries match Identity; no link/token becomes navigation or diagnostic data. |
| `apps/client/features/conversations` | 33 | Already clear: direct inbox/current refs, message catch-up, replies and mutual SEEN use scoped controllers; private content positions remain separate from DM read receipts. |
| `apps/client/features/diagnostics` | 5 | Already clear: development evidence and health surfaces have explicit export gates and positive-control markers; production exclusion is checked by hosted exports. |
| `apps/client/features/encounter` | 46 | Already clear: scope-owned controller parks across view detours, owns activation/recorders and stable retry identity; platform gestures distinguish reading, child input and navigation. |
| `apps/client/features/explore` | 6 | Already clear: mounts the current encounter or first-arrival state; foreground controls activation and recorder visibility. Prepared offers do not become reading evidence. |
| `apps/client/features/feedback` | 9 | [apps/client/features/feedback/README.md](../../../apps/client/features/feedback/README.md) | Changed: added request ownership and focused check; retained stable report IDs, offline queue and no-consumption semantics. |
| `apps/client/features/friends` | 13 | Changed: completed roster, opaque cursor and native/web invite intake review; initial native launch is discarded once, fresh tokens never cross account/epoch remounts. |
| `apps/client/features/gallery` | 7 | Already clear: authored examples enter only gated gallery exports; dynamic requires and marker checks are intentional. Retained fixtures, never imported as product activity. |
| `apps/client/features/not-found` | 1 | Already clear: real missing-page state with a valid Explore link and title; route export remains required. |
| `apps/client/features/operator` | 7 | Already clear: reads scoped diagnostic panels and journeys only after server authorization; nonoperators see the missing-page state. No consumer diagnostic machinery added. |
| `apps/client/features/privacy` | 10 | Changed: completed recording, Clear, export and deletion review; unknown sends keep original commands, current reads grant policy, and live completion remains separate from backup/provider copies. |
| `apps/client/features/reel` | 5 | Already clear: exact exposure, scoped media grants, foreground playback and disposal; grant renewal does not create another encounter and credentials are not persisted. |
| `apps/client/features/requests` | 23 | Already clear: private draft/current waiter, stable command IDs, bounded fast/slow reads and cancellation; readiness comes from a current read, never a replayed acceptance. |
| `apps/client/features/rooms` | 104 | Already clear: workspace, discussion/feed/Today/activities routes use member controllers; foreground presence timers and socket watches clean up. Launch/watch/ritual state stays outside ranking evidence. |
| `apps/client/features/saved` | 17 | Already clear: bounded pages and cursor history, exact membership/CAS places, removal and Undo use current scoped reads; a previous removal cannot delete a later Save. |
| `apps/client/features/scenarios` | 35 | Already clear: draft proposals, explicit choice, branch map and member-only reader remain separate; each person opens an ordinary encounter at their own pace. |
| `apps/client/features/scroll` | 23 | Already clear: direct-open lineage, v1/v2 parser and declared renderer capabilities, recorder lifetime and stop/block positions match the mounted surface; no admission compiler on device. |
| `apps/client/features/sharing` | 19 | Already clear: deliberate share/copy/revoke, ephemeral note/token and exact asset revision; API owns public landing. External clipboard copies cannot be recalled. |
| `apps/client/features/shell` | 7 | Already clear: frames/navigation keep links, responsive insets and route history; rendering and layout helpers grant no backend authority. |
| `apps/client/features/threads` | 41 | Changed: corrected coarse-place privacy comment against D-065/D-066; checked stage/snippet reader, explicit finished-part share, membership, hiding and private playhead boundaries. |
| `apps/client/features/universe` | 138 | Changed: corrected native camera persistence documentation; checked read-only camera/preview, stored look rendering, current formation claim and unknown-ack retry. Browsing and landmarks create no evidence. |
| `apps/client/features/visibility` | 7 | [apps/client/features/visibility/README.md](../../../apps/client/features/visibility/README.md) | Changed: added controller-to-backend reading path and focused check; retained separate visibility, availability and SEEN commands. |
| `apps/client/features/visit` | 9 | [apps/client/features/visit/README.md](../../../apps/client/features/visit/README.md) | Changed: corrected obsolete no-rooms wording and added focused request/check path; retained memory-only visit and revocation rules. |
| `apps/client/maestro` | 13 | Changed: documented hosted emulator entry, fixture API, restart flows, origin flags and evidence limits; preserved every YAML/fixture and local generated-project exclusion. |
| `apps/client/platform` | 36 | Changed: added platform-selection, storage, credentials/history and mounted-resource guide; corrected obsolete native-link comment. Web siblings and secure-store recovery stay intact. |
| `apps/client/plugins` | 3 | Changed: documented app.json registrations, reflection/R8 keep rules, activity config and fixture-only cleartext. Plugins remain native build entry points, not unused helpers. |
| `apps/client/providers` | 4 | Changed: documented scope-keyed subtree, current-policy refresh and device preferences above scope; source retains cleanup and account/epoch response fences. |
| `apps/client/theme` | 2 | Already clear: font-family registration uses bundled licensed assets and semantic themes; no values, family names or font bytes changed. |
| `apps/worker` | 29 | Changed: checked explicit consumers, flag-gated production/room work and all operator dispatches; jobs recheck their own authority, schedules remain migration-owned and paid attempts remain ledger-bound. |
| `content` | 89 | [content/README.md](../../../content/README.md) | Already clear: frozen v1 assets are tied to history and paid request hashes; retained every file and README. |
| `docs` | 1 | Already clear: Status separates deployed evidence from known gaps and links current handovers; cleanup does not revise prior product acceptance claims. |
| `docs/archive` | 8 | [docs/archive/README.md](../../../docs/archive/README.md), [docs/archive/discovery-2026-10-19/README.md](../../../docs/archive/discovery-2026-10-19/README.md) | Already clear: history explicitly points at current v2 authority; retained all archived material. |
| `docs/v2` | 240 | Changed: clarified procedures versus execution evidence in the index; reviewed current/historical routing, design precedence and runbook pointers. Binding rulings, archives and immutable inputs retained. |
| `migrations` | 110 | [migrations/README.md](../../../migrations/README.md) | Changed: added schema-change journey, focused commands and historical rollout label; retained all SQL/checksums. Registry fixtures passed. |
| `ops/pool` | 4 | [ops/pool/README.md](../../../ops/pool/README.md) | Already clear: functions, authority, spend ceiling, immutable migrations and separate live-state caveat are documented; retained all pool rows and SQL. |
| `ops/vps` | 58 | [ops/vps/README.md](../../../ops/vps/README.md) | Changed: added source reading order and pure fixture command; preserved schema refusal, stop ordering, installation and forward-recovery rules. Host fixtures passed. |
| `packages/backend` | 6 | [packages/backend/README.md](../../../packages/backend/README.md) | Changed: replaced obsolete unwired-feature summaries with current module ownership and focused checks; checked package exports and composition roots. |
| `packages/backend/src/erasure-registry.ts` | 1 | Changed: clarified roots are removed last rather than unowned; checked explicit module order, schema inventory, Clear proof and account/export registry construction. |
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
| `packages/backend/src/job-queues.ts` | 1 | Already clear: explicit release queue list installs versioned payloads and schedules; worker registry owns gated consumption, while each module owns job erasure and business idempotency. |
| `packages/backend/src/modules/composer` | 40 | Changed: added activation-to-buffer/ranking guide; checked PC injection, policy replay, Jev/recording and pruning. Retained serialized v0/v1 policies; removed only the proven-unregistered token. |
| `packages/backend/src/modules/content` | 188 | Changed: completed coverage/admission, nested production/library and vendored-wire review; held library revisions require review, shared content/spend survives personal erasure and vendor bytes remain pinned. |
| `packages/backend/src/modules/evidence` | 40 | [packages/backend/src/modules/evidence/README.md](../../../packages/backend/src/modules/evidence/README.md) | Changed: intake-to-projection journey, recording-batch example and current composition; retained original-generation and erasure rules. |
| `packages/backend/src/modules/experience` | 55 | Changed: completed navigation/activation, exact Keep membership/CAS and legacy outcome review; clarified removal replay. Two short transactions recheck drift, authority and original generation. |
| `packages/backend/src/modules/feedback` | 14 | Changed: added report/retry/retention reading path; checked target access, stable receipts, no notification and separate reported-account tombstone retention. Not interested remains Experience-owned. |
| `packages/backend/src/modules/geography` | 31 | Changed: completed formation/quiet/coverage README and source review; code reconciles model proposals with qualified varied support, inactivity only quiets places, and Scene effects commit with apply. |
| `packages/backend/src/modules/identity` | 41 | Changed: completed redemption/session, recording/Clear, export and deletion review; clarified verifier comment. Root/account gates, old receipt readers, sweeps and erasure/recovery retained. |
| `packages/backend/src/modules/operator` | 16 | Changed: added allowlisted inspection guide and removed stale panel/dev assertions; checked current operator access, bounded journey search and CLI-only person scope. |
| `packages/backend/src/modules/personal-context` | 19 | [packages/backend/src/modules/personal-context/README.md](../../../packages/backend/src/modules/personal-context/README.md) | Changed: explained snapshot consumers and separated legacy unavailable facets from implemented trusted coverage. Recording and erasure rules preserved. |
| `packages/backend/src/modules/planner` | 17 | Changed: added frozen-context/run/recovery guide and corrected planned Supply commissioning text; original generation, live claim and unknown liability remain authoritative. |
| `packages/backend/src/modules/play` | 19 | Changed: added lock/receipt/wall guide and corrected room-play/old rollout prose; checked activated exact revision, first lock, paused no-save, private results and read-only landmarks. |
| `packages/backend/src/modules/rooms` | 181 | Changed: added room-message/member/worker journey; checked gate/command frames, named schedules, scoped/personal versus ambient model grants, activity walls, tombstones and erasure/export declarations. |
| `packages/backend/src/modules/scenarios` | 35 | Changed: added proposal-versus-choice and audience guide; checked current thread standing, branch removal, generation fences, resolver/answer jobs and retained shared branch content. |
| `packages/backend/src/modules/scenes` | 20 | [packages/backend/src/modules/scenes/README.md](../../../packages/backend/src/modules/scenes/README.md) | Changed: replaced obsolete future-adapter wording with current projection/API/formation journey and focused checks; retained allocation and recovery rules. |
| `packages/backend/src/modules/social` | 76 | Changed: added share/message/gate guide; checked friendship versus thread roots, durable cursors/hints, current memberships, coarse places, mutual SEEN and declared erasure/tombstones. |
| `packages/backend/src/modules/supply` | 51 | Changed: added Reuse/Join/Create and waiter/retry guide; checked private request/receipt, caps, source/admission rechecks, planned demand and unknown-paid-attempt handling. |
| `packages/backend/src/reasoning` | 48 | Changed: added attempt lifecycle and transport guide; corrected obsolete operator-only/acceptance prose. Reviewed admission/dispatch/settlement, scope grants, unknown outcomes, caps and protected-payload erasure. |
| `packages/client-core` | 145 | Changed: completed controller/recorder, recording/Clear, Keep, social/room and scope-lifetime review; corrected v2 reader wording while preserving stable retries, compatibility readers and fixture entries. |
| `packages/contracts` | 85 | Changed: added journey-to-owner map and updated receiving-adapter language; reviewed schema versions, strict branch refusal, confidential cursors, scoped reads and sessionless exceptions. No wire or serialized shape changed. |
| `packages/design-tokens` | 20 | [packages/design-tokens/README.md](../../../packages/design-tokens/README.md), [packages/design-tokens/fonts/README.md](../../../packages/design-tokens/fonts/README.md) | Changed: added semantic-token editing journey and focused checks; preserved all visual values, fonts and licences. 88 token tests passed. |
| `packages/scene-core` | 34 | [packages/scene-core/README.md](../../../packages/scene-core/README.md) | Changed: replaced obsolete future-consumer introduction with current projector/renderer boundary and focused checks; 128 tests passed; Hermes parity still unverified. |
| `packages/scroll-model` | 165 | [packages/scroll-model/README.md](../../../packages/scroll-model/README.md), [packages/scroll-model/fixtures/README.md](../../../packages/scroll-model/fixtures/README.md) | Changed: clarified production/admission/device path and compatibility exports; preserved producer fixtures and runtime rules. 846 tests passed. |
| `packages/ui` | 286 | Changed: completed primitive/renderer/platform export review; shared tokens, admission exclusion and semantic callbacks remain clear. Full serial suite passed 75 files/733 tests; visual values unchanged. |
| `root` | 11 | Changed: completed root manifest/scripts/toolchain/boundary and README pass; commands use pinned workspace versions and SSD data. No dependency, task runner or release permission changed. |
| `scripts` | 4 | — | Changed: added CLI/caller/effect/recovery map; traced source-check and vendor build dynamic entry points; retained promotion contract. |
| `scripts/issue-context` | 3 | — | Already clear: CLI usage and offline behavior covered by issue workflow; lookup fixtures passed. |
| `scripts/release` | 3 | — | Already clear: builder and smoke headers specify archive layout, exact artifact identity and disposable start; linked shared host validators in scripts guide. |
| `tests/integration` | 215 | [tests/integration/README.md](../../../tests/integration/README.md) | Changed: checked test projects, template-clone isolation, fixture queues, installed-release runners and boundary probes; database/release checks passed in prior hosted CI and rerun on the final head. |

## Removal evidence and retained candidates

Baseline `pnpm knip` passed with no reported unused code. An additional
`pnpm exec knip --include-entry-exports` scan exposed public-entry candidates; most require
preservation (Expo routes, platform variants, supported contracts and fixture/compatibility exports).
Two declarations were proven unused and removed:

| Removed declaration | Former purpose | Caller and dynamic-entry check | Regression check |
| --- | --- | --- | --- |
| `LIVE_WORLD` in config `processes.ts`, and its index re-export | Named the string `live` | Tracked-tree search found only definition/re-export; no namespace/dynamic consumer. Operator refusal uses `OPERATOR_WORLDS`, not this constant. No HTTP/CLI field or stored value changes. | Config fixtures include live and differently named production-world refusals; typecheck and normal Knip. |
| `READ_PREPARED_EVIDENCE_INPUT` in Composer `public.ts` | Advertised an injection token for prepared ranking input | No provider, injection or other tracked reference to the symbol/name. Current navigation and buffer providers explicitly inject `READ_COMPOSER_CONTEXT`. Retain the used `ReadPreparedEvidenceInput` type and compatibility adapters. The unregistered Symbol is not a queue/job name, wire field or serialized record discriminator. | Composer fixtures, typecheck, boundaries and installed API/worker boot in hosted CI. |

Knip is a lead, not a proof: retain package exports, Nest providers, pg-boss payloads/schedules,
Expo routes, platform variants, operator commands and compatibility readers until callers and
supported records have been traced. Do not delete migrations, pinned Cutroom wire files,
immutable design inputs or supported-behavior fixtures.

## Retained export candidates

The expanded scan is intentionally stricter than normal Knip. Each category was reviewed and
retained when framework resolution, a supported contract or incomplete retirement evidence made
deletion unsafe. These decisions close the maintenance pass; they do not invent a caller.

| Candidate class | Examples and caller check | Decision / open question |
| --- | --- | --- |
| File routes and platform exports | Expo default route exports; web SpaceCanvas, ReelGestureStage, storage, history and link adapters | Retain: Expo/Metro selects them through filenames/platform resolution, with production/gallery and web/native fixtures. |
| Policy and stored outcome readers | Composer v0/v1, activity policy versions, action/open/activate outcome schemas | Retain: old decisions and receipts outlive a release. Removing a version needs a supported-record and compatibility retirement decision. |
| Public package constants/types/helpers | Config release readers, erasure/export helpers, scene/Scroll schemas and producer types | Retain: package exports are supported surfaces; absence of a production import alone does not prove safe removal. Which unused re-exports can be retired is still an explicit contract question. |
| Operator, native and build-only entry points | Source checker dynamic built imports, vendor compiler, Expo plugins, optional native fixtures | Retain: invoked by commands, runbooks, app config or hosted workflows, not ordinary runtime imports. |
| Fixtures, migrations, vendor/design/history | Labelled renderer/provider fixtures, registry SQL, pinned wire/design files and v1 content | Retain: regression or immutable historical inputs; static non-use in a bundle is expected. |

## Verification and release evidence

All 94 base inventory areas have a changed/already-clear result, including the earlier partial
passes. New README files explain platform/providers/plugins, browser and emulator entry points.
No dependency, wire shape, migration, provider request, visual value or product behavior changed.
Executable removals remain the two proven-unused declarations above; other source edits are comments.

The resumed backend pass ran 137 files / 1,785 tests successfully. API and focused client boundary
fixtures also ran without changing assertions or timeouts. Earlier full suites and six hosted
checks on `e8bed6ab` passed; final combined checks, complete-diff review and the exact merged dev
revision are recorded in [PR #680](https://github.com/KnowScroll/knowscroll/pull/680). A green earlier
commit is not a green final head.

Local limits remain labelled: the broad backend run encountered the Mac's absent `/usr/bin/ffprobe`;
hosted CI installs it. Client serial assertions passed but its runner retained an async handle,
tracked separately in [#681](https://github.com/KnowScroll/knowscroll/issues/681). Isolated/full serial
reruns resolved earlier parallel timeouts without weakening an assertion. Immutable-input hashes,
relative links and declaration-removal caller checks were verified separately.

No destructive journey ran against an owner's account/database, no provider call was needed, and
no production promotion is part of this PR. Post-merge dev verification must compare `/health`
with the actual squash commit and confirm the deploy workflow. Source and fixture checks alone do
not prove a live deletion, emulator/physical-device parity or provider quality.
