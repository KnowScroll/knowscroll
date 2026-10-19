# v2 decision log

Append-only. Each entry: date, decision, reason, consequence. When a later entry changes an earlier one, it says so; earlier entries are not rewritten. Blueprint = `architecture/02d-greenfield-blueprint.md`. Facts carried from v1 are in `carried-forward-facts.md` (CF-nn).

## D-001 · 2026-10-19 · Programme authority

The owner's implementation request of 2026-10-19 authorises building the blueprint's architecture and the complete v2.1 UI in this repository, with deployment to dev and stage. It supersedes the "documentation only" scope of the architecture documents and of #72. Product, privacy and reliability rules are unchanged. PIO is not used; the Software Factory skill and its gates are retired and are not reinstated. The blueprint governs architecture and behaviour; the v2.1 export governs visuals; conflicts are resolved in this log.

## D-002 · 2026-10-19 · Branches and promotion

- Integration branch `codex/release-knowscroll-v2` (from `dev@106c4701`). Feature branches `codex/<issue>-<purpose>` reach it by squash-merged PRs (the repository allows squash merges only).
- A tested integration revision reaches `dev` by a squash-merged PR. Immediately afterwards `dev` is merged back into the integration branch (a plain merge pushed to the integration branch) so the next promotion has a fresh merge base and does not re-conflict with its own squash.
- `dev` deploys the dev world on push. `stage` follows by `scripts/promote.sh stage` (fast-forward to the tested `dev` commit; same release artifact, no rebuild).
- Agents never update `main` or deploy production. The main-targeted PR is prepared for the owner and not merged.
- The coordinator may merge feature PRs into the integration branch after green CI on the exact head and an independent review with no blocking finding, and may merge integration → `dev` after the same plus hands-on verification. Owner-only approvals that remain owner-only: reel-script approval and spend (CF-62), main/production.

## D-003 · 2026-10-19 · The v1 implementation and docs leave this line of history

Tag `legacy/v1-final` → `106c4701` marks the last v1 revision on `dev`. The integration branch removes the v1 apps, packages, tests, scripts, docs, ADRs and agent instructions so future sessions cannot mistake them for current rules. Retained, because v2 needs them:

| Kept | Why |
|---|---|
| `.claude/settings.json`, `.claude/hooks/refuse-main-update.mjs` | Enforces "agents never update main" (strengthened, D-012) |
| `ops/vps/**` | The live VPS provisioning and `ks` deploy tool; v2 extends it (S1.5) |
| `ops/pool/migrations/` (was `packages/db/pool-migrations/`) | Schema of the live `knowscroll_pool` spend database (CF-30) |
| `packages/backend/src/modules/content/adapters/cutroom/wire-v1/` (was `packages/contracts/src/cutroom-v1/`) | Byte-for-byte vendored Cutroom wire schema pinned to `94ee04a1` (CF-61) |
| `packages/design-tokens/fonts/` | Bricolage Grotesque, Instrument Sans, DM Mono with their OFL licences |
| `content/**` | Frozen v1 data: editorial and model-written Scrolls, approved reel scripts bound to paid history (D-005) |
| `scripts/promote.sh`, `.github/workflows/deploy.yml` | Promotion and the v1 deploy path; deploy is replaced for v2 in S1.5 |

## D-004 · 2026-10-19 · Where v2 runs

v2 runs in the **existing dev and stage worlds** (`app.dev`/`backend.dev`, `app.stage`/`backend.stage`), replacing v1 in a world when a v2 revision is promoted there. It uses new databases `knowscroll_v2_dev` and `knowscroll_v2_stage`, new roles and new media directories. The v1 databases `knowscroll_test_dev|stage`, their media and the shared `knowscroll_pool` record are left untouched and are not dropped. The owner's Mac database `knowscroll` is not read, migrated or changed.

Reason: the owner asked for promotion to dev then stage; separate `v2dev`/`v2stage` worlds (the discovery alternative) would need new DNS records in hPanel and new environments, and would leave dev/stage showing a product that is being replaced. Consequence: stage keeps running v1 until the first v2 promotion to stage (planned once the Phase 2 journeys pass on dev). Live remains untouched.

## D-005 · 2026-10-19 · Legacy content and generated content

- `content/` is frozen v1 data. Its 14 reel scripts are bound to paid history by request id (CF-63); never edit them.
- v1 Scrolls (23 editorial, 70 model-written) are **not** imported into the v2 inventory: their format differs and v2 must demonstrate its own generation. Importing them later is a separate decision.
- Reels already produced by Cutroom from owner-approved scripts (greenhouse, seasons-v5, tides-v4) may be admitted into v2 through the v2 Cutroom adapter's lookup/import path, with provenance (run id, script, approval ref). This is a real Cutroom result reused at no new cost; it does not count as proof of a new commission.
- v2 model-generated content lives in the database and media store, not in Git. Test fixtures are labelled as fixtures.
- One authored editorial starter Scroll may seed the Phase 1 thin journey; it is labelled `authored_editorial` provenance and never presented as generated.

## D-006 · 2026-10-19 · Design conflicts resolved (v2.1 export vs blueprint and product rules)

| # | Conflict | Resolution |
|---|---|---|
| a | "Speculative" label drawn in two styles beside "Hypothetical" | Status labels are only **Hypothetical** and **Corrected/Updated**. Speculative premises are expressed in the Hypothetical card's assumption text. |
| b | Reel and Scroll not drawn as equals (yellow on Reel card, louder "Open Scroll" on D01, Scroll actions on the opposite side) | One action set (Like, Save, Share, Ask, Reel/Scroll switch, ⋯) in the same placement for both. Yellow means continuation only. No extra Open-Scroll button. |
| c | Four tabs (Explore, Universe, Talk, Keep) vs blueprint's "recommend three" | Four tabs adopted: the blueprint left final placement to mockup review. Account is reachable from the avatar in every tab header, not only Keep/Universe. |
| d | Route `/s/:id` for Scrolls collides with `/s/:token` share previews | `/s/[token]` = share preview. Content: `/reel/[assetId]`, `/scroll/[assetId]` (with `#block` anchors and `?t=` for Reel time). Threads `/threads/[id]`, explorations `/x/[id]/[node]`, universe `/universe?cam=`. |
| e | Presence shown by default (D03) | Availability is opt-in; default is unknown/hidden. |
| f | "Ravi asked" on a preparing part | Allowed: contribution history (blueprint §17). Never playback/seen/current position of another person. |
| g | Snippet block settings shared by default (H03, E09 personal values) | Settings travel only when explicitly included; personal input values default to excluded; the card states whether settings are included. |
| h | Revoked share landing names the sender | It names nobody; it says the link is no longer available. |
| i | What-if summary "computed locally" | A server draft command returns bounded suggestions; it starts no production. |
| j | "Finished" in the E05 trail | Neutral "Visited" (the caller's own history), never a completion grade. |
| k | N01 contradicts itself on Share pausing the Reel | The share sheet pauses playback while open and restores the prior play state when dismissed. Overlays never enter Back history. |
| l | Operator page assumes Grafana + Loki/Tempo/Alloy | Implement over Tier 0 (journald, `ops` SQL views, read-only Grafana on PostgreSQL, `pnpm journey <id>`). Panels with no Tier 0 source are shown as unavailable, not faked. |
| m | Planet sizes in D02 look meaningful | Size comes from the visual family/template only; it never encodes consumption. |
| n | Five controls under 44 px; focus ring invisible on cobalt media; "Talk •" as accessible name | Touch targets ≥ 44 px; focus ring uses the yellow/cream token on dark/cobalt surfaces; unread state is a separate accessible description. |
| o | Rooms have no owning tab | Room stations open from the Universe; joined rooms are also listed in Talk. |
| p | ~15 unnamed colour values and unnamed 12/13/14 px type roles in use | Normalised into named tokens in `packages/design-tokens`; the token set, not individual artboards, is the source. |
| q | Storyboard privacy copy ("delete conversations you started", "complete only when every copy is cleared") | Use P02's copy and the blueprint §19 policy. |
| r | Room "Scroll version" placed in the episode navigator | Format switching uses the Reel/Scroll switch everywhere. |
| s | Suggested and made branches look alike in C04 | Suggested branches use the dashed/"Suggested" treatment and carry no episode number. |

States the export does not draw (loading, corrected Scroll, Scroll as a thread item, revoked invitation, blocked conversation, etc.) are designed from the existing tokens and components and listed in the coverage matrix on the tracker.

**Amendment to b (coordinator ruling on the review of #255, 2026-10-19).** "Yellow means continuation only" covers pressed toggles too. A pressed Like, Save or other two-state control uses the filled cobalt treatment on the poster register (cobalt fill, filled cream glyph) and the filled cream treatment on dark and media surfaces (opaque cream, filled ink glyph); never yellow. The large-text grid uses the primary (cobalt) button for a pressed action. This departs from Components.html, which draws pressed toggles yellow. Tokens: `toggle.pressedOnLight` / `toggle.pressedOnDark` in `packages/design-tokens`. Still yellow, as drawn and not toggles: the signed-in person's avatar (`avatar.self`), the A03 hint's offset shadow and the focus ring on dark surfaces (D-006 n).

## D-007 · 2026-10-19 · Identity (to be proven in S1.3)

Use better-auth (MIT) with its email magic-link plugin and Expo plugin, sessions stored in PostgreSQL (`identity` schema). Web uses same-origin secure cookies with origin/CSRF checks; native uses a bearer session in platform secure storage. Mail is sent through the existing AgentMail inbox (CF-40) by the API, one send, no retry, no address oracle. Disposable test accounts on dev/stage can additionally be signed in with an operator-minted one-time link created from a server shell; this path is disabled in production by configuration and refused at startup if enabled there. If the S1.3 proof shows better-auth cannot meet these constraints with Nest/Express and Expo, the fallback is a small first-party magic-link implementation following the same rules, recorded here.

## D-008 · 2026-10-19 · One origin per world

The Expo web export is served statically by Caddy on `app.<world>`. The same host proxies `/v1/*`, `/auth/*`, `/socket.io/*` (WebSocket upgrade), `/media/*`, `/s/*` share previews and `/health` to the Nest API, so web needs no CORS and cookies stay first-party. Native clients call the same origin. `backend.<world>` keeps proxying everything to the API.

## D-009 · 2026-10-19 · Phase order adjusted

The reasoning harness, Scroll DSL/renderer and Scroll production move into Phase 2, ahead of Planner/Cartographer, so real model-generated interactive Scrolls exist before journeys that depend on inventory. Cutroom **reuse/import** of already-produced Reels also lands in Phase 2; a new paid **commission** is Phase 4 and needs an owner budget. Reason: authored fixtures cannot prove generation quality, and every later journey needs real admitted content.

## D-010 · 2026-10-19 · Where tests run

Automated suites and release checks run in GitHub Actions (owner rule 2026-10-19). Local runs are only for starting and using the product by hand, with data on the SSD. Required checks are never weakened or skipped to obtain a green run.

## D-011 · 2026-10-19 · The main-update hook was strengthened

`.claude/hooks/refuse-main-update.mjs` now also refuses `git -C <dir> push … main`, quoted refs, a bare `git push` from a `main` checkout, `gh pr merge` whose base is `main` (or cannot be confirmed), `gh api … base=main` and `gh repo sync --branch main`. `gh pr create --base main` stays allowed: preparing the owner's PR is in scope, merging it is not. The hook only loads for Claude sessions started inside a checkout of this repository; sessions started elsewhere rely on discipline.

## D-012 · 2026-10-19 · Scroll document DSL `scroll-document.v1`

The blueprint names a ScrollDocument but defines no schema; against the v2.1 screens it covers 4 of 37 needed capabilities (discovery `scroll-dsl.md`). v2 adopts the proposed declarative DSL with these rulings: 17 authored block types (paragraph with passage offsets, subheading, list, quote, callout, disclosure, code, table, figure/media, comparison, timeline, sequence, diagram with authored frames, chart, simulation with a closed set of formula kinds and views) plus a server-emitted `fallback`; no `predict_reveal` in v1 (it risks reading as a quiz); no expression grammar in v1; three separate artefacts (model draft, consumer document, internal provenance) with the client forbidden from importing provenance; code, not the model, sets reading time, coverage weights, gestures and the integrity hash; personal simulation parameters never enter telemetry and enter a snippet only when explicitly included; limits `scroll-limits.v1` as listed in the package README; client capability negotiation with per-block fallbacks. No model-generated JavaScript is ever executed.

## D-013 · 2026-10-19 · Research sources for generated Scrolls

v1 allowed only NASA, NOAA and USGS pages, which cannot support ML, history or football Scrolls. v2's research allowlist adds, per host and reviewed in code: English Wikipedia, arXiv abstract pages, US government `.gov` sites, Our World in Data, and official technical documentation (e.g. MDN, language/framework docs). OpenStax stays excluded (owner, 2026-09-24). The writer produces original prose: a copy check refuses any run of more than eight consecutive words from the material, quotes are kept internally for claim checking, and readers never see sources (owner rule) while provenance stays correctable. Pages are fetched by code (https only, size-bounded, redirects re-checked, no cookies), never by the model.

## D-014 · 2026-10-19 · Workspace, toolchain and release-tree conventions (S1.1 #224)

Status: accepted (coordinator, 2026-10-19), amended after the independent review of #252.

- **Pinned matrix.** Every third-party version is pinned exactly in the pnpm catalog (`catalogMode: strict`, `savePrefix: ''`, `strictPeerDependencies: true`) and recorded with dates, peers, licences and what CI proves in `operations/dependency-matrix.md`. Node 22.23.x (engines `>=22.23.0 <23`), pnpm 10.34.7, TypeScript 6.0.3, Nest 12.1.3 (not 12.2.0, released the same day with behaviour changes), oRPC 1.15.7, Expo SDK 58 (`expo@58.0.14` and its bundled module versions), PostgreSQL 16. pnpm 11/12 are not adopted: 11 renames build-script settings and adds release-age gates, 12 is moving fast (14 minors in 7 weeks); neither gives this workspace something it needs yet.
- **Sources inside, `dist/` outside.** Library packages (`contracts`, `backend`, `migrations`) export their TypeScript sources under the custom condition `@knowscroll/source` (type-checking, Vitest through `vitest.workspace-sources.ts`, dependency-cruiser) and their compiled `dist/` otherwise (builds, Node at runtime). A build never compiles another package's sources.
- **Release trees come from the lockfile.** After building, `pnpm --config.inject-workspace-packages=true --filter @knowscroll/api deploy --prod <release>/api` (contains `dist/main.js` and `dist/migrate.js`), the same for the worker, and the Expo web export for `web/`. Injecting workspace packages (on the command line only; ordinary installs keep linked packages) makes `pnpm deploy` install from the shared `pnpm-lock.yaml`; `--legacy` re-resolved instead and is no longer used (`scripts/release/build.mjs` uses the same command). The CI `build` job checks every installed version in both trees against the lockfile and boots the trees against PostgreSQL. The `.pnpm` folder names of injected workspace packages embed a hash of the build directory, so two checkouts produce different folder names (never different versions). Layout and variables: `engineering/workspace.md`, `engineering/runtime-configuration.md`.
- **Migrations** are the workspace package `@knowscroll/migrations`: reviewed `NNNN_name.sql` files at `migrations/` and a static registry with each file's SHA-256. `dist/migrate.js` refuses a file whose text does not match its recorded hash and a database whose applied migrations were applied with different text (hashes recorded in `migrator.migration_checksum` in the migration's own transaction), applies the pending batch forward-only in one transaction (a failure applies nothing), then installs pg-boss and applies every declared queue policy.
- **One tool per job.** Prettier (formatter), typescript-eslint typed rules (linter; a `default:` branch never counts as handling a union member), dependency-cruiser (boundaries, blueprint §22, with a CI probe proving each rule rejects a forbidden import and a manifest check for workspace dependencies), knip (unused code), squawk (migration hazards), Vitest (backend and pure code), jest-expo + React Native Testing Library (client). Automated suites run in GitHub Actions only (D-010).
- **Packages are created when code needs them.** `client-core`, `ui`, `scroll-model`, `scene-core` and `design-tokens` (as a package) arrive with their first code; the boundary rules for client packages already name them.

## D-015 · 2026-10-19 · @orpc/nest 1.15.7 on Nest 12.1.3 accepted; no OpenAPI-first fallback (S1.2 #225)

Status: accepted (coordinator, 2026-10-19).

The compatibility spike passed in CI through the deployed release trees: contract-first routes with `@Implement`/`implement()` (GET and JSON POST), request-derived callers through Nest's `@Req()` inside the handler closure, input validation, `customErrorResponseBodyEncoder` plus a `sendResponseInterceptors` entry that answers every error as `application/problem+json` (RFC 9457) with stable codes, a Nest exception filter and an Express error middleware for failures outside oRPC (unknown routes, body parser 413/400, non-JSON 415), the typed `@orpc/openapi-client` link from `@knowscroll/contracts`, and OpenAPI generation (`@orpc/openapi` + `@orpc/zod/zod4`). oRPC errors are not the public error format: oRPC's own 4xx codes map to their problem codes (any other 4xx stays a client error), and lock waits, statement timeouts, deadlocks and serialisation failures anywhere in the cause chain answer a retryable 503 with `Retry-After` (logged once as `http.retryable_failure` with their code, since a timeout or deadlock is usually a real fault) instead of a 500. oRPC 2.x (beta, tested upstream on Nest ^12.1.3) is not adopted; revisit when it is stable. OpenAPI-first remains the fallback only if a later oRPC release breaks this test.

## D-016 · 2026-10-19 · Command receipts are an infrastructure facility with their own schema (S1.2 #225)

Status: accepted (coordinator, 2026-10-19), amended after the independent review and re-review of #253.

Blueprint §5 lists "command receipts" under Experience, but every module's commands need them (social, scenarios, privacy), and modules write only their own data. Receipts therefore live in `packages/backend/src/infrastructure/receipts` with the infrastructure-owned schema `receipts`, erased per universe through the erasure registry:

- `personal_commands` keyed `(universe_id, command_id)`, read and written only inside the locked personal scope; the request hash covers the operation and the canonical validated request (keys in code-point order; non-plain data refused) including the revisions it relied on.
- A replay returns the stored outcome only when the receipt's privacy epoch equals the caller's and its `outcome_version` is the one the caller reads. A receipt from before a privacy reset is never replayed; the caller is already at the current epoch, so it answers `COMMAND_KEY_REUSED` (mint a new ID) rather than a reload-and-retry problem that would loop. Outcome versions: a release that writes version N also reads N-1; a receipt written by a newer release (rolling deploy) answers a retryable 503 and is never re-applied; one in a retired older shape answers `COMMAND_KEY_REUSED`.
- `shared_commands` keyed by scope kind and ID, actor, operation and command ID, usable only through a `SharedScopeTx`, which `enterSharedRoot` hands out at most once per personal scope after the personal root is locked (blueprint §19 lock order).
- **Refusals.** Retryable refusals (lock busy, stale epoch, missing or stale asset) write no receipt and are evaluated again on retry. A future command with a *terminal* refusal (for example, sending to a room the person has left) must either store the refusal as its outcome or require the client to mint a new command ID; each such command states which.

## D-017 · 2026-10-19 · Diagnostics carry no free text (S1.2 #225)

Status: accepted (coordinator, 2026-10-19), amended after the independent review and re-review of #253.

`logEvent` fields are IDs, codes, route templates, counts, durations, configuration problems as `VARIABLE: kind_code`, and sanitised errors (class, code, shortened frames; never messages). Framework messages are reduced to recognised lifecycle codes; pg-boss warnings to their kind; plain-object errors keep only their code. The journal projection withholds personal-linkable IDs (blueprint §26 "Logging retention and erasure must agree"). Secret-shaped values are refused even in identifier-shaped fields (the canary test found a token that passed an ID pattern). The same rule covers job state: a failed job's stored output (`pgboss.job.output`, kept for days, dead letters for two weeks) is a code-only record (`{failure, errorClass, code}`), never the error's message, stack or driver detail; a payload that does not match its queue is dead-lettered at once. Consequence: some debugging detail (exception messages) is unavailable in the journal; rich, personal detail belongs in erasable, access-controlled decision records when they arrive.
