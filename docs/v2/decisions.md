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

## D-018 · 2026-10-19 · Owner: Cutroom budget for v2 Reels — up to $2

The owner allows v2 to spend **up to $2 (200¢)** on new Cutroom Reels. The shared `knowscroll_pool` record stays the single money record: its cap moves from 700¢ to 900¢ ($7 + $2) through a new pool migration (never editing an applied one), and v2 holds one grant of at most 200¢; Cutroom's own per-Reel cap stays 75¢. The owner still approves each reel script in its PR (CF-62). Before the first paid order the fal balance is read server-side and must cover the order. Applies from S4.2 (Phase 4).

## D-019 · 2026-10-19 · Owner: Android builds and native journeys run in GitHub Actions

GitHub-hosted runners may build the Expo Android app (prebuild + Gradle) and run emulator/Maestro journeys; this supersedes the v1 "Android builds only on the owner's Mac" rule (CF-31) for v2. The owner tests on a real phone later; until then native acceptance is labelled emulator evidence, never physical-device evidence. No self-hosted runner, no signing secrets in CI until release work needs them.

## D-020 · 2026-10-19 · Owner: `checks` is required on `dev`

Ruleset `25423111` ("dev: v2 checks must pass") requires the GitHub Actions checks `integrity`, `static`, `backend`, `build`, `client` and `release` on `dev`, with no bypass actors. The two existing rulesets (no deletion/force-push; only promoters update main and stage) are unchanged.

## D-021 · 2026-10-19 · Owner: personal-context model roles may use MiniMax for real users

Planner, Cartographer, Scenario Planner and room AI roles may send bounded personal-context-derived inputs to MiniMax for real users, not only test accounts (owner, 2026-10-19), knowing MiniMax's terms allow inputs to improve its services. The blueprint's minimisation still applies: each role sends only its prepared, bounded context (topic/unit references and authorised thread excerpts), never secrets, raw observation streams or another person's private data; requests are not logged; the privacy screen (P02) states that a third-party model processes exploration context.

## D-022 · 2026-10-19 · Identity: first-party magic links and sessions, not better-auth (S1.3 #226)

Status: accepted (coordinator, 2026-10-20; proposed by the S1.3 worker 2026-10-19, revised after the independent review and re-review of PR #257, merged as `d467f664`, applied and verified on dev 2026-10-20). Applies D-007's fallback clause.

D-007 asked S1.3 to prove better-auth first. The spike ran better-auth **1.7.10** (MIT; magic-link and bearer plugins, Kysely adapter with `schemaName: 'identity'` and snake_case field maps, `generateId` → UUIDs) on Nest 12.1.3 / Express 5.2.1 against a throwaway PostgreSQL 16 (hands-on, real database; script and output in `/Volumes/Mrigesh SSD/knowscroll-dev/v2/evidence/s13/spike-better-auth/`, and in branch history at `13f738f6`). What worked: mounting under `/auth/*` before Nest's JSON parser (other routes kept their body parsing), storage in the `identity` schema, hashed single-use tokens (`storeToken: 'hashed'`), cookie and bearer session lookup, an origin check on its own routes. What it cannot satisfy without being taken apart:

1. **A GET signs in.** The link points at `GET /magic-link/verify`; a request with no cookie and no origin — what a mail scanner or prefetcher sends — answered 302 with a session cookie and created a session. The rule is "consumed by POST; a prefetched GET cannot sign in". Keeping better-auth would mean disabling its verify route and calling its server API from a POST of our own.
2. **No account and universe root in one transaction.** `databaseHooks.user.create.after` runs after the user insert (queued after its transaction by design); a failure there left an account without a universe and answered 500. The rule is one transaction with a receipt.
3. **Its error and log formats are not ours.** Errors are `application/json {message, code}`, not RFC 9457 problem details (D-015); it logs free-text messages and stacks (D-017) unless its logger is replaced.
4. **Operator sign-in would couple to its internals** (its verification identifier and value format), and it needs a signing secret per world that we would have to provision.

What remained after the necessary workarounds was a session table and token hashing behind a framework that owns its tables, routes and error shapes. The first-party implementation (`packages/backend/src/modules/identity`, README there) has exactly D-007's properties:

- Links: 32 random bytes (`ksl_…`), only the SHA-256 stored, at most 15 minutes (database check), single use, consumed only by `POST /auth/redeem`. The token rides in the URL fragment; the redeem page first asks `POST /auth/peek` whose account the link opens (the full address for a web link) and redeems only after the person taps "Continue as <address>" (login forgery by link shows itself). Addresses: a strict RFC 5321 subset (printable ASCII, dot-atom local part, LDH domain; anything else `422`). Budgets: 10 requests per client (an IPv6 client is its /64; an in-memory flood brake, not a source of truth) before anything else; then, durably and counting only links actually issued, 3 per address, 60 per recipient domain and 300 per world per 15 minutes (domain and world each under an advisory lock), each answering `429` with `Retry-After`, a filled domain or world budget logged once per window (`identity.sign_in_budget_full`). `202` for every acceptable address and no account created before redemption (no address oracle); one AgentMail send per link, not awaited, never retried. Expired links and long-ended sessions are removed by a scheduled pg-boss job (`identity.sweep-sign-in-records`, every 15 minutes), never in a request.
- Native links are bound to the device (PKCE-style, RFC 7636 S256): the app keeps a verifier in its secure store and asks for the link with its challenge; only the verifier redeems it (and peeks at it). A link asked for without a challenge is redeemed by the web only. This is the device binding §19 asks for; OAuth itself stays out of scope. **Off on every world** (`KS_NATIVE_SIGN_IN_BINDING`) until the native app ships, because as built anyone could bind a person's links to their own challenge and lock the address out of its budget; before enabling it, count the address budget per binding or let the web redeem a bound link with a code from the mail body (re-review N1).
- Redemption: one transaction — address advisory lock → link row lock → find or create account + address + universe root (epoch 1) → `WithResolvedPersonalScope` locks and rechecks the root → receipt `(universe, commandId)` → session. Every refusal rolls the whole transaction back, so a refused redemption consumes nothing. Retrying the same command replays only while the session that redemption issued is still live, and replaces it; concurrent retries and two links for one address never create a second root.
- Sessions: 32 random bytes (`kss_…`), hash stored, 30 days, revocable; web gets an HttpOnly, SameSite=Lax, `__Host-` Secure cookie and cookie-authenticated mutations and socket handshakes must carry the world's `Origin`; native gets a bearer token once for its secure store; a web token is never accepted as a bearer token or vice versa. Authority (account, universe, current epoch) is re-read on every request; revoked or expired sessions are 401.
- The scope claim (one guard in front of every `/v1` route; opt-outs only via the reviewed `UNSCOPED_V1_ROUTES`): every account request carries `X-KS-Scope: <accountId>:<privacyEpoch>` and every socket handshake the same in `auth.scope`; the API serves it only when it names the presented session's account and current epoch (`409 SCOPE_MISMATCH` otherwise, nothing read or written). The client's AccountScope owns its own credential and ends before a switching redemption is sent; on `SCOPE_MISMATCH` it rereads the session. So an account switch in another tab, or a privacy reset whose revocation notice was lost, never serves one scope another's answers.
- Operator sign-in for disposable accounts (`dist/operator.js issue-sign-in`): only in the allow-listed worlds dev, stage, ci and local (refused elsewhere, live included whatever it is called), only with `KS_ALLOW_OPERATOR_SIGN_IN=1`, and only for addresses matching the world's `KS_OPERATOR_SIGN_IN_PATTERN` (dev and stage: `*@test.knowscroll.space`), checked at API startup, at command startup, at run time, when the link is issued and again when it is redeemed. An account whose address proved itself by mail is never opened by an operator link. Each issue writes a durable audit row (`ops.operator_sign_ins`: world, time, `cli:<operator>`, account) that survives "clear history" and becomes a tombstone on account deletion.

Consequences: `KS_AUTH_ADAPTER` defaults to `session` (`none` is gone; `test-bearer` stays a CI fixture, and it too must send the scope claim). Production refuses to start unless `KS_MAIL_SENDER=agentmail` is fully configured; the v2 API unit reads `/etc/knowscroll/secrets/shared/agentmail.env` and the v2 settings gain `KS_MAIL_SENDER=agentmail`, `KS_ALLOW_OPERATOR_SIGN_IN=1` and `KS_OPERATOR_SIGN_IN_PATTERN` (Ansible `roles/worlds_v2`; apply before deploying a revision with S1.3). The v2 programs run as their own users `ks2-<world>` with `/etc/knowscroll` invisible to them, and the v2 web app gets a Content-Security-Policy and `X-Frame-Options: DENY` from Caddy (both applied by Ansible). No signing secret is needed. Open for the owner before live (re-review N2): valid addresses still spend the domain and world budgets, so a few dozen client addresses can switch sign-in off for a domain or the world; the options are in the identity README ("Before live"). OAuth does not apply until a third-party provider is added ("other sign-in options" stays a placeholder); when one is, revisit this entry rather than growing the first-party code into an OAuth server.


## D-023 · 2026-10-20 · Owner: continuation through remaining phases

The owner's Codex continuation request authorises continuing the existing v2 programme through all remaining implementation phases, connected real-service journeys and verified dev/stage delivery. The earlier inferred pause before Phase 3 is superseded; report after each phase and continue the next unblocked phase. Main/production, total paid budgets, individual Reel-script approval, destructive actions and unavailable credentials retain their explicit owner controls. No PIO or Software Factory workflow is reinstated.

Use the existing tracker #222, branches and implementation work. The Codex coordinator integrates, reviews, merges and deploys; bounded Sol agents own named issues/worktrees. Historical Claude agent IDs and attribution settings are not current assignments or controls.


## D-024 · 2026-10-20 · Owner: bounded additional MiniMax allowance for Scroll production

For #232 the owner explicitly approved up to 24 additional MiniMax model requests total: 12 development and 12 dev generation. Every admitted attempt/repair must be recorded, uncertainty consumes the allocation until reconciliation, and a new agent/session does not reset it. The historical harness six-call grant is exhausted and separate. Coordinator shared ledger: SSD `knowscroll-dev/v2/agents/coordinator/provider-allowance-232.json`; harness database attempts remain the execution authority. This does not change D-018's separate Cutroom budget or per-script approvals.


## D-025 · 2026-10-20 · Coordinator: navigation lineage and mutable encounter context

Implementation interpretation of blueprint §§8–9 and N01/J1/J5: platform Back restores a parked
AccountScope entry without a command, activation or new evidence/return bonus. A later deliberate
navigation may name any previously activated, still-authorized member offer/exposure of that same
session and epoch. It must carry the latest server intent revision, not the parked snapshot's old
revision. Cross-session, stale, withdrawn or otherwise ineligible lineage is refused. The new move
commits its new intent atomically; restoring Back does not manufacture a server encounter.

An authorized exposure-context read supplies current action state, latest Composer session revision
when applicable, and bounded existing series/related/format availability. Mutable context is not
stored in immutable offers/receipts. A ready continuation descriptor is not activation authority; a
card-selected expected link/revision is revalidated rather than silently substituted. Pending always
requires existing durable authorized work; no invented series total, future part or generated supply.

Explicit actions may carry an exposure ID. The consumer rechecks ownership, activation, epoch and
exact revision before using it for encounter attribution. An action without this lineage remains an
asset preference only; never guess the latest exposure or award encounter qualification/bonuses.
Saved keeps its original immutable revision; a current revision may appear only with corrected
availability and must differ. Neither Saved nor a context read bypasses withdrawal.

New command branches stay strict. Existing legacy unknown-field stripping remains compatible
except newly reserved discriminators (`target` for activation, `status` for open responses and
`sessionId` for activation responses); malformed new branches cannot downgrade into legacy effects.
Interim consumers refuse unsupported new commands before any effect. Shared contracts land and
pass independent review/Actions before feature consumers.


## D-026 · 2026-10-20 · Coordinator: initial layered2D Universe renderer

Use the existing react-native-svg dependency for the initial layered2D Universe renderer, with ordinary accessible RN/Web controls and lists. The [source/design study](discovery/scene-renderer-study.md) evaluates committed U01–U08/D02, blueprint§13/§18 and current scene-core/Scroll runtime evidence; U07 explicitly permits layered SVG without3D. This is an initial implementation choice, not populated-scene or physical-device performance acceptance. Keep descriptor/formation/identity independent of rendering and revisit from actual scene/device evidence if needed.

The server persists meaning-selected family/template, opaque personal seed, generator version and anchors; rendering never rerolls identity from sibling order or activity. Full/low/reduced-motion keep the same semantic targets and framing. No arbitrary model SVG/scripts/URLs, placeholder growth, evidence-from-map-visits or client-invented region offers. Exact scoped camera return, supported Composer Open and durable per-account shown/skipped transition acknowledgement remain explicit acceptance work; origin IDs or client memory alone do not establish cross-device once-only presentation.


Initial finite scene convention (coordinator refinement2026-10-20, clarified2026-10-21): the established Earth system and its star retain distinct object kinds, and both use the existing terraced.v1 family/template fields. Star names an object kind and renderer semantic, not a fourth SceneFamily; the earlier phrase “star family” was ambiguous. Seasons uses terraced.v1, Tides archipelago.v1, and Greenhouse ridged.v1. Regions inherit their canonical parent's selected family. These are cosmetic rendering conventions, not scientific classifications, formation evidence or new meaning authority. Persist family/template, seed, generator and anchors before variation; unsupported/ambiguous meaning labels fail closed and alias resolution remains Geography-owned. The initial projector does not bootstrap nonempty historical worlds: empty worlds remain empty, and any later bootstrap requires an explicit reviewed maintenance path.


## D-027 · 2026-10-20 · Coordinator: public social view revisions do not expose private transitions

Sharing contracts distinguish caller-visible view revisions from internal pair/authority revisions. Silent decline leaves the sender's pending view, expiry and visible revision unchanged until the fixed public expiry; revision staleness/refusals cannot disclose a recipient-private transition. Future consumers still lock/recheck internal authority before replay or effects. Hidden, expired and unknown presence share one constant unknown wire branch with no event-bearing revision, expiry or TTL; authorized visible availability may carry bounded validity. Public visitor IDs are publication-scoped identities, never serialized private Geography/Scene/universe IDs. The initial visitor wire may support an explicit semantic/list fallback; this does not implement the U06 visual renderer or server projection.

## D-028 · 2026-10-21 · Owner: Scroll MiniMax allowance increase

In response to the concrete #232 request to add ten dev MiniMax calls (24 → 34 total, development12 + dev22), the owner answered “yes you can increase as you like.” The coordinator applies the reviewed bounded34 ceiling now; this permission permits further necessary #232 increases with an explicit bounded ledger entry before any calls, rather than an unrecorded or session-based reset. All21 previous calls remain counted (development11/dev10); reservations and unknowns remain zero. The old24 ledger is preserved byte-for-byte on the SSD, and every prior allocation/attempt is unchanged.

The immediate plan remains three new greenhouse Scroll jobs, at least two interactive, maximum four calls per job including repairs, unchanged token caps and stable roles/generation/brakes. Only the two Scroll roles’ request ceilings may rise as needed, to at most12 each under this reviewed plan. Current-day runtime counters are separate from cumulative programme allowance: UTC rollover does not erase historical calls or liabilities. Deployment, exact source/operation review and launch preflights remain required. This grants no Planner/Cartographer/Quartermaster calls, Cutroom spend or Reel-script approval.


**Recorded bounded extension, 21Oct15:59UTC:** after30 settled requests (development11/dev19), the coordinator applied43 total =development12+dev31 under this existing owner authority. The +9 dev ceiling leaves at most12 future dev calls for three separately reviewed max4 jobs, including two interactive recipes. Ledger7abd9961 preserves all12 prior allocations/authorizations; zero reserved/unknown, no new calls. Daily22/per-role12, token caps, brakes and generation1 stay unchanged. Prior98c500/34 remains retained. Each job still requires its own deployment/preservation, fresh baseline, reservation, independent concrete review, one-use launch and terminal settlement.

## D-029 · 2026-10-21 · Coordinator: initial Friends request window

The first backend Friends slice uses one fixed seven-day public request window. Its sender resubmission cooldown ends at that same public expiry. A private recipient decline changes neither the sender's pending view nor this deadline, revision, no-op/replay behavior or notices (D027). Reads and commands evaluate expiry from server time even if cleanup stalls; expiry materializes its public revision at most once. Reciprocal request is not acceptance. Block and unblock never restore a friendship or pending request.

This selects the initial versioned server policy for the backend foundation; it does not mount Social HTTP, authorize list-index housekeeping, choose presence/invite/cursor lifetimes or establish a real two-person journey. Those later slices retain their separate contract, privacy, source and runtime acceptance. Account-lifetime profile/membership inventory is not an account-deletion executor.

## D-030 · 2026-10-23 · Owner: the Codex run ends; new working flow and budgets

The Codex coordinator was stopped on 2026-10-23 after an audit found the foundation sound but every completion requirement open: no generated Scroll accepted, dev not promoted, stage on v1, and most time spent on review and evidence ceremony. A Claude coordinator (Opus 5.5) continues with Sonnet 5.5 subagents and workflows. The owner decided:

- **Working flow:** `AGENTS.md` "How we work" replaces the previous working rules and `docs/CHECKPOINT.md`. Status lives in `docs/STATUS.md` (one page, plain language) and tracker #222. New branches are `claude/<issue>-<purpose>`; the integration branch keeps its name `codex/release-knowscroll-v2`.
- **Tests (supersedes D-010):** unit and integration suites may run locally, against a disposable PostgreSQL on the SSD, while building. GitHub Actions `checks` remains the required gate before any merge. Browser, Android and end-to-end journeys run in Actions or against dev.
- **Model budget (supersedes the call ledgers of D-024 and D-028):** MiniMax may be used as much as needed until the token plan's 5-hour window limit is reached; work then continues on other tasks and generation resumes after the window resets. No per-call reservation or ledger beyond the product's own attempt ledger. Scroll writing uses `MiniMax-M3.1-Flash`. Target: 50–60 generated Scrolls through the real production pipeline, at least 20 with interactive blocks.
- **Cutroom (supersedes D-018's $2 and, for v2 Reels, CF-62's per-script approval):** up to **$4 (400¢)** of new fal spend for v2 Reels. The coordinator may write, check and order Reel scripts itself; each script and its settled cost is logged in #240. The pool spend record changes only through its own functions and migrations.
- **Dev database:** `knowscroll_v2_dev` may be dumped to the SSD and recreated so testing starts from a known state. The v1 databases and `knowscroll_pool` are not touched.
- **Dev and stage:** the coordinator may promote integration to `dev` (D-002) whenever testing needs it, and promote to `stage` with `scripts/promote.sh stage` for the release candidate. `main` and production stay owner-only.
- **Existing code:** keep what follows the blueprint. Code that contradicts the blueprint is corrected to it; nothing is replaced with quick shortcuts. Quality and strict conformance to the agreed architecture come before speed.

## D-031 · 2026-10-23 · MiniMax model naming

`/v1/models` lists `MiniMax-M3.1-Flash`, `MiniMax-M3`, `MiniMax-M2.7`, `MiniMax-M2.7-highspeed`, `MiniMax-M2.5(-highspeed)`, `MiniMax-M2.1(-highspeed)` and `MiniMax-M2`. A request for an unlisted name such as `MiniMax-M3.1` or `MiniMax-M3.1-Pro` is served by `MiniMax-M3.1-Flash` without an error, so the adapter must check the response's `model` field against the configured model. `MiniMax-M3.1-Flash` returns a `thinking` content block before its text by default; `MiniMax-M3` does not. `MiniMax-M3` is the verified vision model; whether `MiniMax-M3.1-Flash` accepts images is unverified.

## D-036 · 2026-10-24 · Coordinator: deploys stay on the push path; one-use deploy admission reverted

#390 made every dev or stage deploy wait for a root-prepared, one-use intent and a separate `ks-deploy@` service. It was never installed on the server, and it contradicts the owner's flow (AGENTS.md: `dev` deploys on push; `stage` moves by `scripts/promote.sh stage`). Installing it with the next Ansible run would have blocked every deploy. It is reverted. The repository's `ops/vps/tool` now matches what the server runs. The deploy lock, the pre-migrate dump, the exact schema check before activation and the rollback guards stay as they were.
