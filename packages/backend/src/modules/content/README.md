# modules/content

Content owns the shared explanations people can open: immutable admitted asset revisions,
documents, source provenance, catalogue relationships, media and production. Experience asks it
for an exact readable revision. Supply and operator commands can request production; workers
call providers through the reasoning harness, validate the result and store it. Library release
has its own review gate. A stored candidate is not automatically public content.

Start with [public.ts](public.ts), then [the library plan](domain/library/README.md) and
[production](production/README.md). Personal erasure removes personal ownership links through the
registry; it does not delete shared library content or forget a paid attempt whose result is unknown.
The sections below retain the coverage, media and spend recovery rules.

Run `pnpm --filter @knowscroll/backend exec vitest run src/modules/content` from the root.
Database, fake-provider and installed-process checks are in the
[integration suite](../../../../../tests/integration/README.md). Real provider calls require the
[provider budget rules](../../../../../docs/v2/engineering/contributing.md#providers-and-money).

## Library plan and the topic catalogue (#674, D-419)

The topic catalogue (`content-concepts.v1`) is **data in Postgres**: **systems**, **planets** (topics) and **facets** (kinds of angle), each a
node with a stable id that is never reused, a label, a meaning and a chain of immutable revisions. The library plan in TypeScript
([`domain/library/`](domain/library/README.md)) is its authoring source and the recipes the generator runs; what the code reads of
topics is the `Catalogue` port (`CATALOGUE`, `current()` and `release(n)`), never a constant. Prefixes, titles, discovery tags and personal
or model labels never establish membership. _Implemented; migration 0116 seeds release 1 exactly as the plan was._

- **Releases.** A release is one numbered, append-only step. The catalogue of release N is every node and revision introduced up to N, so
  what a Geography run pinned reads the same for ever. A release's digest is the SHA-256 of the meanings in the first catalogue's
  shape (so release 1's is the digest every earlier mapping recorded as `catalogueSha256`); it also covers topics not yet servable and
  nodes that retired, and only when there are any. The pointer (`content.concept_current`) only moves forward.
- **Snapshots.** `CatalogueSnapshot` is one release, immutable and synchronous: `concept(id)`, `systems()`, `topics()`, `allTopics()`, `children(system)`,
  `slice(ids)`, `systemOf`, `meaning`, `meaningSha256`, `acceptsMeaning`, `label`, `sceneFamilyOf`, `hazeOf`, with formation thresholds on each node
  (defaults 2, 3 and 2). A use case reads one snapshot and everything from it, so a rule that looks twice never sees two releases. A lookup by id finds
  a node of any status; the listings leave out retired nodes and topics that are not servable. `adapters/catalogue-store.ts` reads a release once per process
  (keyed by release and digest) and `makeCatalogue(db)` re-checks the pointer every few seconds without blocking a reader (a stale release is a valid
  catalogue), so a release made by one process is read by the others without a restart. Content's own adapters read the release through the transaction they are already in.
- **Admission is by code** (`domain/catalogue/release.ts`): an id has the plan's shape and sits under its parent, a parent exists and is of the right kind and
  live, a normalised id and a normalised label are unique among their siblings, a meaning is 16 to 300 characters without an address or markup, a topic has two to sixteen facets
  in its own release, a node keeps its place, kind, silhouette and haze for ever, and a rewording is declared the same meaning only of the wording it replaces.
  Any refusal refuses the whole release. A facet is never retired alone, only with its topic.
- **A new topic waits for supply.** It is added not servable (not offered, matched, listed or made a room) until the library has released, coverage-mapped supply
  for it: at least three distinct explanations over two of its own facets by default (its own thresholds), counted from `content.region_bindings` of admitted
  Scrolls only (`readReleasedCoverage`). `showServableTopics` makes such topics servable in a release of its own; the gap loop's scan runs it each pass, and
  `content catalogue sync` runs it too. Production and the gap loop work on topics that are not yet servable (`allTopics()`).
- **A wording-only revision keeps certificates valid.** A revision lists the identities of the earlier wordings it only rephrases (`compatible_with`), so
  `acceptsMeaning` still accepts a certificate decided against them; a semantic change lists none and the binding is dropped from reads, never thrown on. New decisions
  pin the current wording (`meaningSha256`). A release that changes nothing a binding pins changes only the digest, which a read never compares, and re-admission
  treats it as no change (no new coverage head).
- **Import.** `dist/operator.js content catalogue sync [--dry-run]` compares the plan with the current release (ids, labels, meanings, looks), adds what is new, revises what
  changed (a changed silhouette or haze is refused), reports what the plan no longer names (it retires nothing), splits a large plan into releases of at most 20,000
  nodes (never between a topic and its facets), and then makes servable the topics with supply. Running it twice makes one release.
  `content catalogue status` prints the release and counts. Output is counts and codes only.
- **Prompts that listed the catalogue** (free-text match, the scope of a question asked from a Scroll) are shown a bounded, code-built shortlist
  (`shortlistTopics`: all servable topics while there are at most 24, otherwise the 24 whose label, meaning or facets share the most key words with the text) and the
  model's answer must be one of them. Where nothing shares a key word the free-text match makes no call and says no topic fits.

A coverage mapping records the catalogue digest (of the release) it was decided against, but reads do not compare it: the catalogue grows, and every
release changes it. Each binding pins its own facet meaning instead. When a read finds a binding whose facet has vanished or changed meaning (and no
revision declared the old wording the same), it leaves that binding out of the returned mapping (the facet is unmapped), and never throws. Target identity
and locators must still fit the immutable document, and a mismatch there is corrupt data and throws. Geography ignores supports whose meaning changed in
the same way. _Implemented._

After a semantic change, the operator runs `dist/operator.js content readmit-coverage [--dry-run]`. It decides coverage again for every published
generated Scroll revision through `admitRecipeCoverage` (and every Reel made from an approved script through `admitReelCoverage`), one short transaction each: an unchanged decision appends nothing, a changed one appends a corrected
head, and history is kept. It prints counts (`considered`, `appended`, `unchanged`, `skipped`). It uses shared content only (no provider, personal root or
network) and is refused outside the operator worlds. _Implemented; not yet run against dev._

_Implemented; real-PostgreSQL tests: `tests/integration/modules/catalogue-release.test.ts`._

## Scroll coverage

`0022_content_coverage` adds shared `coverage_revisions` (one immutable, <=32KiB mapping per
correction/retraction) and `coverage_heads` (one monotonic head per exact asset revision). Both use
the immutable asset-revision FK and exact indexed keys; neither contains a person, observation or
consumption result. History is retained; personal erasure leaves this shared content metadata.
No migration seeds or backfills coverage.

**Generated Scrolls: code decides coverage (D-033).** The private production hook
(`completeWriterPublication`) publishes the revision, attributes its planet and then calls
`admitRecipeCoverage`, all in the one production transaction. No person or model approves the
mapping, and no model call or network wait is involved. The rule `scroll-recipe-coverage.v1` binds
the recipe's declared facets to blocks of the stored document:

- Eligible blocks are top-level paragraphs, quotes and callouts whose claims are documented.
- The primary facet needs the first, middle and last eligible block, so skimming the opening never
  counts.
- A supporting facet, when the recipe declares one, needs the last two eligible blocks.
- Fewer than three eligible blocks, or a revision that is not an admissible factual Scroll, binds
  nothing. The Scroll still publishes and keeps its planet, stays unmapped, and the job's outcomes
  record `coverage_too_few_body_blocks` or `coverage_target_unavailable`.

**Coverage v2 (D-127), implemented, runtime-verified on real PostgreSQL with a labelled fixture.** A
`scroll-document.v2` has no paragraphs, so its rule is `scroll-recipe-coverage.v2` over its units
(reading facts v3, D-128): the eligible units are the **read stops** that cite at least one documented
claim, with the same first-middle-last and last-two shape and the same bar of three. **Calls bind
nothing** (play does not form places, D-063), and admission refuses a mapping that names one. The stored
mapping keeps the policy `scroll-static-coverage.v1` so region bindings still read it; its
`readingFactsVersion` is 3 and its review reference says `scroll-recipe-coverage.v2:<unit>`. The rule is
chosen by the revision's facts version, so v1 revisions are decided exactly as before, including by
`content readmit-coverage`.

`lockCurrentCoverageAuthorities` is the recheck every apply path makes: each named authority must still be the current mapping
head, held under a `SHARE` lock until the transaction ends. `readCurrentCoverageAuthorities` (D-411) is the same recheck without
the locks, for the read-only dry runs: PostgreSQL refuses a row lock in a READ ONLY transaction, and a dry run applies nothing
they would protect. It must never run before a write.

The rule is structural, not semantic. It says which blocks a reader must have seen for a facet to
count, and cannot judge whether the prose teaches the facet. The recipe brief and the writer checks
govern that. The mapping's basis is stored as `scroll-recipe-coverage.v1:<explanation unit>`.
A failed coverage write rolls back the publication, the closure and the topic together, and the same
paid writer answer resumes without a resend. Correction appends a new head (A to B to A uses new
revisions); retraction appends a retained head. _Implemented; real-PostgreSQL CI fixture tests
cover it. Not yet exercised with a real provider._

The standalone `coverageAdmissionUseCase(db)` is a separate, default-deny seam for a command a
person has reviewed, such as an authored Scroll. Its approval list is empty and only CI fixtures use
it. Never supply its approval callback from a request, environment or model output. There is no
HTTP, admin or operator command for either path.

A command binds exact asset/revision, document/provenance SHA, explanation unit, factual framing
digest, derived reading-facts v2 digest, catalogue and meaning digests. It can map <=16 topic/facet
bindings, each an ALL-OF set of 1-8 existing top-level paragraph/quote/callout IDs. Nested children,
disclosure parents, headings, interactive states, Reel, hypothetical/perspective framing and fixture
production provenance are refused. Admitted immutable Scroll/document/provenance identities are
rechecked from storage; reading facts are derived through the existing Content compiler.
Mapped claim bindings must have documented/synthesis truth states; interpretation, disputed,
modelled, counterfactual, fictional or missing claims are unsupported in this initial policy.
Documents, provenance, discovery tags and access/withdrawal rules are not modified.

Admission takes the per-asset/revision advisory lock, then the asset SHARE lock, then the head
UPDATE lock. The standalone path opens its own short Content transaction. The generated path joins
the production transaction after the revision is stored. Expected head revision fences concurrent
corrections, and an identical decision replays without appending. Database triggers reject revision
update/delete and nonmonotonic/removed heads. Failure rolls the whole transaction back. Admission
never takes a personal root or performs network/model waits.

`READ_ADMITTED_COVERAGE_MAPPING` reads one exact revision in an existing personal transaction and
returns mapped/unmapped/retracted/unavailable. An older revision is still exact historical content;
a withdrawn asset is unavailable. This read confers no opening permission and proves no reading.
`LOCK_CURRENT_COVERAGE_AUTHORITIES` accepts 1-100 unique exact expected heads (<=128KiB), normalizes
UUIDs and orders locks by canonical asset UUID/revision. Lock order is caller personal root -> all
asset SHARE locks -> head SHARE locks. It revalidates active heads, hashes and current admission;
false means the consumer must reject its proposal. SHARE locks remain until the caller transaction
ends, blocking head correction and asset withdrawal. No personal revision/effect is written.

Consumers: Evidence credits a binding only when a qualified reading saw every required block
(`observedBindings`), and Region candidates come from `content.region_bindings` (below). Neither
changes qualification policy. A Reel's coverage is its own (next section).

## Reel coverage (#674, slice 5.1, D-421)

Status: implemented, CI-tested against real PostgreSQL. Not yet run against dev. Migration 0116.

A Reel binds facets by the same kind of code rule, over what its script says. `reel-recipe-coverage.v1`
(`domain/reel-coverage.ts`, `application/admit-reel-coverage.ts`) runs in the Reel's publication transaction
(`postgresReelPublisher`), as `scroll-recipe-coverage.v1` runs in a Scroll's, with no model call and no network wait:

- A **segment** is one narration sentence of the approved script (one sentence is one shot, as the script check requires),
  numbered `s1`, `s2` ... Cutroom reports no shot times, so a segment's media window is estimated from its share of the
  narration's words over the admitted duration: the windows tile the Reel from its first
  millisecond to its last. The cut is part of the rule's version. The estimate is why Evidence judges watching against a widened window.
- A segment is **eligible** when every claim it cites is listed in the script and rests on the twin Scroll at the revision the
  script names. The primary facet of the recipe needs the first, middle and last eligible segment, so watching the opening
  never counts; a supporting facet, when declared, needs the last two. Fewer than three eligible segments bind nothing: the
  Reel stays published, watchable and unmapped, and the publication result names the code (`coverage`).
- The mapping is `reel-static-coverage.v1`, in the same `coverage_revisions` and `coverage_heads` tables, for the Reel's
  asset revision. Its bindings name the segment ids (`requiredBlockIds`) and each segment's window (`requiredSpans`), so the
  observed coverage can be judged from the mapping alone. Its framing is factual, the digest a factual Scroll's is, and the
  reading facts it binds are the Reel's stored duration facts.
- The Reel's target is read from the stored document, provenance (`reel-provenance.v1` with its `brief`) and facts, and
  from the twin Scroll revision, which must exist, be served under the same rules as the Reel, **be the Scroll's current
  revision**, share its explanation unit and be factual. A fixture Reel, a Reel whose provenance has no script (the three
  imported before scripts carried claims), and a Reel whose twin is withdrawn, still held at the review gate, or has been
  corrected since (a newer revision) have no target and no coverage: they stop crediting readers the moment that
  happens, and `readmit-coverage` finds no target and appends nothing.
- A segment is truth-supported only when every claim of the twin's provenance is documented or a synthesis, the truth
  states the Scroll rule accepts. A Reel's claims are named locally (`c1`) and rest on the twin revision as a whole, so
  which twin claims a segment depends on cannot be told, and a twin with an interpretation, a disputed, modelled,
  counterfactual or fictional claim leaves every segment unsupported.
- A re-cut is another asset revision. It has its own head and windows; the earlier revision's readings keep proving what
  they proved, as for a Scroll revision.
- A Reel never joins a region by its own coverage. The mapping's policy differs from a Scroll's, the derived region lookup
  keeps only the Scroll policy, and migration 0116 makes a revision of coverage whose policy does not match the kind of its
  asset a data error. A Reel reaches a region only as the twin of a Scroll (D-404, below).
- The standalone reviewed-command path cannot map a Reel (`CONTENT_COVERAGE_REEL_REQUIRES_RECIPE`); it can retract a
  Reel's head.

`content readmit-coverage` decides every Reel that has a script again, with the recipe its provenance names, and
counts it with the Scrolls; a Reel whose recipe is no longer in the plan is skipped as `no_recipe`. A head an operator
retracted stays retracted while the decision is what it was (a new catalogue digest alone is not a new decision) and is
counted as skipped (`retracted`); only a different reading, such as another script or facet, appends a head after it. It names the units it
changed so their readers are judged again.

A region also offers each covering Scroll's current Reel twin (#709, D-404): the admitted Reel sharing the Scroll
revision's explanation unit, under the Scroll's own coverage. `readRegionEncounterCandidates` lists the Scroll, then its
twin when the client can play it, and finds an expected Reel through the Scroll it is the twin of.
`lockRegionEncounterCandidates` locks each shared coverage once and rechecks the twin under lock. A Reel never gains a
binding or a facet of its own; a Reel with no Scroll twin is not in any region.

Verification is labelled CI fixture: unit tests for the rule, in-memory admission and the library
plan; real PostgreSQL tests for publication, the consumers' reads, rollback, append-only history,
concurrency/SHARE-lock, correction/retraction and stale or forged inputs. Automated suites run in
GitHub Actions; no real provider has produced a Scroll through this path yet.

Shared, immutable content: assets, their admitted revisions, and the internal provenance each
revision rests on. **Content is not personal data**: no table here has a `universe_id` or an account
column, none is in the erasure registry (clearing a universe, a privacy reset or deleting an account
leaves it), and nothing here records who read what.

## Tables

| Table                                                   | Migration                                        | Holds                                                                                                                                                                                                                                                                             | Erasure                    |
| ------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `content.assets`                                        | `0003_content_assets`, status `held` in `0072`   | Asset identity, `kind` (`reel`/`scroll`), `status` (`admitted`/`held`/`withdrawn`) and the **current** revision. `held`: no revision has been served yet, because the first one waits at the review gate (D-138)                                                                  | None: shared content       |
| `content.asset_revisions`                               | `0010_content_asset_revisions`                   | One immutable row per admitted revision: `provenance_kind` (`authored_editorial` · `generated` · `cutroom_import`, D-005), the consumer document (`document_version`, `document`, `document_sha256`), `explanation_unit_id`, `language`, `title`, and the derived `reading_facts` | None: shared content       |
| `content.asset_provenance`                              | `0010_content_asset_revisions`                   | The internal provenance of a revision (claims, sources, bindings, checks, production record). Written by admission, **read by no API route**: the consumer document and its provenance are separate tables, so no read of the document can return them                            | None: shared content       |
| `content.scroll_production_runs`                        | `0015_scroll_production`, key shape `0045`       | Private nonpersonal recipe-key/version jobs, frozen research/passages, accepted claims, code-only outcomes, draft and publication pointer; no consumer read port                                                                                                                  | None: shared public supply |
| `content.recipes`                                       | `0111_content_recipes`                           | Recipes stored in the database (D-412): key (`gen-…` for a proposal), origin (`code` / `proposal`), status (`checked` / `queued` / `produced` / `retired`), title, planet, facet, optional supporting facet, asset id and explanation unit derived by code, brief, one to three pages, the plain v2 plan SQL pins, the proposing run and the check numbers. Authoritative, shared and nonpersonal | None: shared content       |
| `content.concept_releases`                              | `0116_topic_catalogue`                           | One row per catalogue release (D-419): its number, the SHA-256 digest of the catalogue it made, its source (`seed`, `plan`, `visibility`, `operator`) and counts. Append-only (a trigger refuses an update or a delete). Authoritative, shared and nonpersonal | None: shared content       |
| `content.concept_nodes`                                 | `0116_topic_catalogue`                           | The systems, topics and facets by stable id (never reused), parent, creation order (`seq`, a facet's site), `introduced_in`, `visible_in` (when a topic became servable), `retired_in`, status and `merged_into`. Only the last three and `visible_in` may change, once (a trigger); never deleted. Shared and nonpersonal | None: shared content       |
| `content.concept_node_revisions`                        | `0116_topic_catalogue`                           | Immutable revisions of a node: label, meaning, the identity of the wording, `compatible_with` (earlier wordings it only rephrases), formation thresholds, silhouette and haze. Shared and nonpersonal | None: shared content       |
| `content.concept_current`                               | `0116_topic_catalogue`                           | The one row that names the current release; it only moves forward | None: shared content       |
| `content.recipe_proposals`                              | `0111_content_recipes`                           | One proposing run of the recipe brief role (D-412): its run id, planet, facet, UTC day and retry number, the frozen context it was sent (public pages and library text only), and `open` / `completed` / `failed`. Authoritative, shared and nonpersonal | None: shared content       |
| `content.revision_reviews`                              | `0072_content_review_gate`                       | The review gate (D-138): one row for each v2 library revision that was stored held, its state `held` / `released` / `rejected`, and for a decision who (`cli:<operator>`), when and (rejection) why                                                                            | None: shared content       |
| `content.library_support_checks`                        | `0113_library_support_checks`                    | What a version of the library support check (D-415) said about a stored library revision: the state, the verdict code decided from the sentences, the counts and every sentence's outcome. Informs the operator at the review gate and is the measure of the check; releases and rejects nothing | None: shared content       |
| `content.release_topic_approvals`                       | `0115_content_release_policy`                    | The topics a person approved for the release policy (D-418): one row for each approval, who and when, and when, by whom and why it was revoked (`operator` or `withdrawal`). One live row for a topic at most. Approving changes nothing by itself: the policy is off until the owner switches it on | None: shared content       |
| `content.release_withdrawals`                           | `0115_content_release_policy`                    | Who withdrew a Scroll the release policy released, when, and what became of its topic's approval (D-418); the first withdrawal of a revision is kept | None: shared content       |
| `content.release_policy_looks`                          | `0115_content_release_policy`                    | The last look of the release policy's sweep at each held library revision: the hold code and the rules version, so the sweep pages past revisions that stay held (D-418). A hint: deleting one only makes the sweep look again | None: shared content       |
| `content.release_risk_raises`                           | `0115_content_release_policy`                    | Raises of one library revision's risk class (D-418): a model's or a person's proposal that the Scroll touches a sensitive category, so it waits for a person. Append-only (a trigger refuses any change), so a proposal can never lower anything                                               | None: shared content       |
| `content.coverage_revisions` / `content.coverage_heads` | `0022_content_coverage`, kind guard `0116`        | One immutable facet-to-block (a Reel's: facet-to-segment) mapping per correction or retraction, and one monotonic head per asset revision. `content.region_bindings` (`0037`) is the derived lookup by planet and facet                                                                                        | None: shared content       |
| `content.reel_orders` / `content.reel_attempts`         | `0053_reel_orders`                               | The business run "make a Reel of this script" and the ledger of every request sent to Cutroom for it (request bytes, state, pool claim, cost). See "Reels from Cutroom"                                                                                                           | None: shared public        |
| `content.media_objects` / `content.reel_imports`        | `0014_media_reels`, name check relaxed in `0053` | Content-addressed Reel bytes and which Cutroom run became which Reel revision                                                                                                                                                                                                     | None: shared content       |

A revision’s document, provenance and identity are never updated; a content change is a new revision, and anything that rests on one (an exposure,
a saved item) keeps pointing at exactly the bytes it presented.

The storage adapter validates derived reading facts against the canonical Scroll block registry. Domain facts stay plain data; evidence checks declared interactions through content’s framework-free public predicate, without importing renderer schemas into domain/application code.

## Use cases and ports

| Operation                                                    | Caller                                                                     | Authority, effects, failure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `importEditorialScroll(source)`                              | Operator command `dist/operator.js content import-editorial --file <path>` | Allow-listed worlds only (`dev`, `stage`, `ci`, `local`; the command refuses elsewhere before touching the database). One transaction serialised per asset (advisory lock): compile the source at the current revision and compare the integrity hash (equal → refresh derived reading facts if needed (`facts_refreshed`), otherwise `unchanged`); otherwise compile at the next revision number and store the revision, its provenance and the asset's new current revision together (`created` / `revised`). Compilation is scroll-model's **admission** path (staged draft checks, honesty rules, copy check, code-set measures, integrity hash) followed by `admitDocument` on exactly the stored bytes. Refusals (`source_invalid`, `compile_refused` with `stage` and issue codes and paths, `asset_is_not_a_scroll`, `asset_withdrawn`) write nothing and never echo source text. |
| `FindOpenableAsset` (token `FIND_OPENABLE_ASSET`)            | experience                                                                 | The asset's kind, current revision, status and the document hash, inside the caller's personal transaction, no lock                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ReadScrollPlayFacts` (token `READ_SCROLL_PLAY_FACTS`) | play | The calls of one stored `scroll-document.v2` revision (stop id, kind, number of options, the right option) and the landmark its Final call awards (key and name, or none), read from the immutable document (not cached; a person locks at most four calls a Scroll). `undefined` for a revision that does not exist, is not v2, that the review gate holds or rejected (D-138), or whose asset is withdrawn (D-418). Only play uses it, to judge a locked pick on the server (D-181) and to award the landmark (D-188) |
| `ReadScrollReadingFacts` (token `READ_SCROLL_READING_FACTS`) | experience, evidence                                                       | The block weights and types, the owner of each nested block and the reading estimate of one stored Scroll revision, derived at admission from the document's code-set measures and validated on read. Old facts versions are derived from the immutable admitted document on read until re-import persists the current view; unsupported stored documents raise `READING_FACTS_REQUIRES_REFRESH` rather than masquerading as a lineage mismatch                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `RenderScroll` (token `RENDER_SCROLL`)                       | experience                                                                 | Reads the stored consumer document (never provenance), parses it on the client path, and **negotiates** it for the capabilities the client declared (D-012): unsupported blocks become readable fallbacks, essential ones are reported. Parsed documents are cached (immutable, 32 entries)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `FindAssetForAction` (token `FIND_ASSET_FOR_ACTION`)         | experience actions                                                         | Does the asset exist, is it admitted, at which revision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `admitRecipeCoverage(ports, tx, recipe, ref)`                | The production publication hook only                                       | Inside the production transaction: lock the revision's coverage, read the stored document and provenance, derive the bindings from the recipe (`scroll-recipe-coverage.v1`) and append the next head, or return `not_admitted` with a code. Idempotent for an identical decision. No model call, no network, no personal root                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `Catalogue` (token `CATALOGUE`; `makeCatalogue(db)`) | geography, scenes, supply, rooms, composer, experience | `current()` and `release(n)`: one `CatalogueSnapshot` (the topic catalogue, D-419). Reads shared tables on the pool; never blocks on a refresh |
| `RecipeBook` (`recipeBookOf(db)`)                            | production, supply's chooser, the review gate, `readmit-coverage`, the support-check replay (recipe family per asset) | `get(key)`, `servingBrief(brief)` and `all()` over the library plan and `content.recipes` (D-412). Read-only on the shared table; takes a database handle or the caller's transaction; no lock |
| `makeProposeRecipes(deps)(request, signal)`                  | Operator command `content propose-recipes --topic <planet> [--facet <facet>] [--dry-run]` | One `content.recipe-brief` request and at most one repair on the production harness; code checks every draft and stores the accepted ones as `checked` recipes with the run closed, in one production transaction. Run id from planet, facet, UTC day and role version: a redelivery pays nothing. Refuses unknown planets and facets and planets with no page held before any request |
| `ChooseScrollRecipe` (token `CHOOSE_SCROLL_RECIPE`)          | supply (Create and the Planner's demand) | Which recipe (plan or stored) a catalogue brief commissions, from the recipe book and each recipe's standing, given which kinds the day's caps leave open and the unit a Planner opportunity aimed at. No lock, no write |
| `readmitRecipeCoverage(ports, recipes, {dryRun})`            | Operator command `dist/operator.js content readmit-coverage [--dry-run]`   | Lists every stored revision of generated Scrolls, finds each recipe by asset ID, and runs `admitRecipeCoverage` in its own short admission transaction; then every Reel revision whose provenance names a recipe, through `admitReelCoverage`. Idempotent. With `--dry-run` nothing is written. Returns counts; shared content only, refused outside the operator worlds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

`adapters/cutroom/wire-v1/` is the byte-for-byte vendored Cutroom wire schema (CF-61): not built,
linted or formatted; verified by the `integrity` CI job.

## The starter Scroll (D-005)

`starter/why-the-sky-is-blue.editorial-scroll.json` is one original, authored explainer in
`scroll-document.v1` producer form (an `editorial-scroll.v1` source: publication facts, the authored
`scroll-draft.v1`, no claims because it states no digits). It is labelled `authored_editorial` (the
production record is set by code from the file's `reference`, so an authored piece can never claim to
be model-written) and is never presented as generated. Seven sections, text-family blocks only
(subheading, paragraph, list, quote, callout, disclosure), about four minutes. The build emits the JSON
next to the compiled code: in a release tree it is at
`node_modules/@knowscroll/backend/dist/modules/content/starter/why-the-sky-is-blue.editorial-scroll.json`.
`content/` at the repository root is frozen v1 data and is never read.

Jobs: none. Lock order: an advisory lock on the asset ID, then the asset row; admission holds no personal
root and never takes one. Erasure: none (shared content; stated above).

`reading_facts.v2` is a refreshable derived view, separate from immutable document/provenance bytes. Re-importing an unchanged source repairs it under the asset admission lock without creating a revision.

## Approved Cutroom reuse and Reel media

Status: implemented, CI-tested against real PostgreSQL. Related: S2.4, #233.

The worker operator `content import-cutroom-reel --run <uuid> --script <name>` imports only the
three D-005 approved runs (greenhouse, seasons-v5, tides-v4). Their original script/approval snapshots
and coordinator-read media digest/size pins are kept under `approved/`; frozen root `content/` is never
read or edited. `legacy-cutroom-<script>` is the shared explanation identity of Reel and future Scroll
siblings. GET-only loopback reads use the actual pinned upstream parsers, compiled to JS at build.
This importer spends nothing; new Reels are ordered through the Reel commands below.

Import validates terminal/run/request identities, every chosen/used engine check and shot/degradation
coverage. Cutroom places up to three pictures; other shots can be text-to-video and need no chosen
picture. Wire v1's `used` flag attests inclusion in the completed render; it exposes neither take mode
nor a take-to-picture relation. Result stills must still join chosen pictures by picture and shot ID,
and each chosen picture's shot must have a used take or degradation. Import then opens a contained
regular engine artifact, stream-stages, hashes, ffprobes H264/AAC
portrait 24fps 48kHz stereo/20–60s/faststart, installs bytes, and commits an immutable revision with
internal provenance in one short admission transaction. No network, media copy or probe is inside that
transaction. Nonfixture imports must match the frozen approved SHA-256 and size; a repeated run is
unchanged. Engine witness evidence is labelled **engine-attested, not independent**. Absolute paths
are neither documents nor diagnostics; captions are burned into the real approved MP4s.

Migration `0014_media_reels` adds shared `media_objects` (logical key/backend/checksum/size/MIME/revision/
probe) and `reel_imports` (run → immutable revision/media). Shared data is retained across personal reset.
`--fixture` is accepted only in `ci`/`local`, and a DB trigger additionally confines fixture rows to
`ks_it_*`/`knowscroll_fixture_*` disposable databases. Fixture titles/documents are explicitly labelled.

The API reads media only through a caller-owned exposure at its live privacy epoch and an admitted
asset. The consumer `reel-document.v1` contains logical media keys, title/summary/duration/dimensions and
truth/fixture/caption labels; internal production/checks/approvals never appear in it. Media grants are
separate ephemeral access credentials, never content provenance or consumption evidence.

## Generated Scroll production

Production runs as `content.produce-scroll` worker jobs (the answer to a person's question as `content.produce-answer`, D-267), sent by Quartermaster and by the operator's
`content produce-library`. The operator's `content produce-scroll --topic <recipe key> [--take n] [--dry-run] [--resume]` runs one recipe
of the library plan (the keys are the record keys in `domain/library/`; an unknown key is refused
before any database or provider work). It runs one content-owned writer call through the explicit
nonpersonal harness (0013), never a personal universe: research and evidence passages by code, one
writer call that cites them, deterministic compilation, and at most one repair, so **two model
requests per recipe** (six for a v2 library recipe, which adds the answer check, D-198); uncertain attempts are never resent. Publication closes the writer run and
stores the immutable admitted revision in the same production-root transaction. Research and model
waits happen outside it. The same version reruns idempotently; explicit resume continues the frozen
job after a crash. The operator's `content writer-spike-v2` runs the v2 writer (`scroll-authoring.v2`) on library recipes and reports; it admits and publishes nothing
(S-0, D-120 to D-122). A recipe the plan marks `scrollV2` is produced by the same job as a v2 Scroll
(D-129, implemented). The plan marks the four Seasons recipes (D-137), the thirty-five recipes of four systems (D-199) and the fifteen kit recipes of Earth & sky and Space (D-217), and a v2 library Scroll is stored **held** until an operator releases it (D-138, "The review gate" below). `content regenerate --only <keys>` makes another take of one whose Scroll is served (D-197), three takes to a production version. See [production/README.md](production/README.md) and the
[operator runbook](../../../../../docs/v2/operations/scroll-production.md). Fixture CI and real
provider/browser evidence are separate requirements; no authored starter is labelled generated.

## Recipes in Postgres and proposing new ones (#674, D-412)

The library plan (`domain/library/`) is still the code-owned source of the planets, facets and the first recipes. A recipe can also
live in `content.recipes`, and the system can propose new ones for planets and facets that already exist. Nothing here makes a topic.

- **`RecipeBook`** (`application/recipe-book.ts`, adapter `adapters/stored-recipes.ts`): `get(key)`, `servingBrief({topicId, facetId})` and
  `all()`. Code recipes first in plan order, then stored ones; `servingBrief` never returns a retired recipe, `get` does (its Scroll still
  belongs to its planet). Production's subject, publication attribution and coverage, the recipes' standing, the chooser, the review gate's recipe
  name, `readmit-coverage` and the what-if page fallback ask the book. A code recipe behaves exactly as before.
- **A stored recipe's key** starts with `gen-`, a slug of the title and eight hash characters; its asset id is `stableUuid` of the key and its
  explanation unit is `<key>-v1` (`domain/library/generated.ts`). The prefix is how code that holds only a key (a job payload, a run row, the
  request bound) knows it is a stored v2 recipe: `productionVersionOf` and `requestBoundOf` need no lookup, and `parseProductionRecipe` accepts the
  shape (`subjectOf` then asks the database, and refuses a retired or missing row). Every stored recipe is a plain, explanation-first Scroll with
  no misconception (D-397).
- **Proposing** (`production/propose-recipes.ts`, role `production/recipe-brief.ts`): the operator's `content propose-recipes --topic <planet>
  [--facet <facet>] [--retry <1-2>] [--dry-run]` builds the frozen context (the planet, its facets and how many recipes each has, the title and one
  line of every recipe it has, and the pages code already holds for it, read from the research its recipes' jobs froze), freezes it in
  `content.recipe_proposals`, asks the role once (and repairs once), and checks each draft with `checkRecipeDraft`
  (`domain/library/recipe-draft.ts`). A draft is accepted only if its shape matches the library rules, neither its title nor its brief carries an
  address (`://`, `www.`, a dotted host) or markup (angle brackets, backticks, Markdown links), its facet is the planet's (and the one asked for),
  every page is a candidate that passes the research URL rule, the pages' passage pool is 6 to 63, it is not a near-duplicate of a recipe of the
  planet (the same words, or the same facet on the same pages in other words), and its derived identity is free. Refusals are codes.
  **The checks are made again where the recipes are stored**: one production transaction takes the planet's advisory lock
  (`lockPlanetRecipes`), reads the recipes that exist now, judges every draft against them, stores what passes, settles the proposal and closes the
  harness run. Two runs or operators that propose the same angle at once cannot both store it; a kept answer is judged against today's library, not the
  one it was sent against. The run id comes from planet, facet, UTC day, retry number and role version, and the first delivery's frozen context is what
  every later one sends, so a redelivery never pays twice and never meets `request_mismatch`. A run that ended without recipes reports `closed_failed`
  with `nextRetry`: ask again the same day with `--retry` (at most twice). An attempt of unknown outcome, a refusal of the harness and a scope that
  refused leave the run open and are never resent. A planet with no page held, or an unknown planet, facet or retry, costs nothing.
  `content recipes [--status]` lists the stored recipes without any body text.
- **Choosing**: `chooseScrollRecipe` may choose a stored recipe (any non-retired one whose standing is open) for Create and for the Planner's demand,
  after the plan's own recipes. A code recipe the plan marks v2 is still skipped (D-138). `ChooseRecipeOptions.allow` carries what each cap leaves
  open, and `plannedUnit` the explanation unit a Planner opportunity aimed at: it only puts that recipe's facet first, and is kept nowhere. Supply
  counts growth (`KS_SUPPLY_GROWTH_DAILY_CAP`, default 10) apart from a person's and the Planner's Create caps.
- **Held**: a stored recipe's Scroll goes through the review gate below like any v2 library Scroll, so nobody is served it before `content release`.
  The recipe's status moves with its job: `checked` to `queued` when the first job row is created, `queued` to `produced` in the transaction that stores
  the Scroll (`production/store.ts`). A recipe whose three takes were rejected is `stopped` and never chosen again.
- **Flow**: `content propose-recipes`, then `content produce-library --only <key>`, then `content review-list` and `review-show`, then `content release`.
  See the [runbook](../../../../../docs/v2/operations/scroll-production.md).

Status: implemented, with integration tests on real PostgreSQL and a labelled fixture model (`tests/integration/modules/content-recipes.test.ts`). Not runtime-verified on dev: no real provider call has been made for it.

### Shared reads for the gap loop (#674, D-414)

Supply's gap loop finds where the library is thin and commissions production for stored recipes with no person, so Content serves it the reads it needs over
the process's database handle, on shared tables only, never a personal scope (`adapters/gap-reads.ts`, bound by `sharedLibraryProviders`):

- **`ReadReleasedCoverage`** (`readReleasedCoverage`): the released Scrolls by planet and facet, as distinct explanations (a Reel and its Scroll twin count once).
  Released is an asset `admitted` whose current revision has admitted coverage in `content.region_bindings`, the lookup the coverage head's trigger keeps in step
  with admission, correction and retraction: a Scroll held for the operator's read is not an admitted asset, and a withdrawn one is no longer. A planet with
  nothing released is absent from the list.
- **`ReadGapRecipes`**: the recipes that would serve a planet (and facet), code and stored, with each one's production standing and the take a send should
  name. A retired recipe is never listed. The loop uses it to see whether the hole is already being filled, whether a stored recipe waits to be produced and
  whether a proposal is due.
- **`ReadRecipeStates`**: the standing of named recipes, for a commissioned gap to see whether its Scroll was released.
- **`ChooseSharedScrollRecipe`**: Create's chooser (`chooseScrollRecipeIn`) over a handle, the same rule whoever asks; `readScrollProductionIn` likewise.
- **`propose-recipes` may be sent a UTC day** (`ProposeRecipesRequest.day`), which replaces today's date in the request's identity: the gap loop pins the day
  of an attempt, so a redelivery after midnight is the same request and is answered by the ledger. Absent, it is today, as before.

Status: implemented, CI-verified on real PostgreSQL (`tests/integration/modules/supply-gaps.test.ts`); not runtime-verified on dev.

## The review gate for library v2 Scrolls (D-138)

Status: **implemented**, runtime-verified on real PostgreSQL with labelled fixtures, not yet on dev.

No state existed between "admitted" and "served": an asset's `status` was `admitted` or `withdrawn`, and every
read follows its **current revision** (`assets.revision`). The gate uses that pointer, so it adds almost no
machinery.

- **Hold.** Production of a v2 library recipe (`ProductionSubject.scrollV2`, however the job was sent) stores the
  revision, its provenance, its topic and its coverage as usual, but does not advance the current revision. A new
  asset is created with status `held`. A `content.revision_reviews` row says `held`. The production job is
  `published` and records the code `held_for_review`. v1 recipes and made-to-order Scrolls publish as before.
- **Invisible.** Pointer reads (discovery, navigation, series and related moves, region candidates, the
  Universe, opening a Scroll, `production-status`) never see a revision newer than the pointer or an asset that
  is `held`. Reads that take an exact asset and revision from their caller (exact encounters, the stored
  document for rendering, shareable and saved metadata, topics and attribution, the source pages a what-if may
  draw on, the check that a report names a revision a person could have met, and the coverage mapping that
  formation reads) also refuse a revision whose review state is not `released` (`adapters/review-gate-sql.ts`).
  The coverage write path (publication and `readmit-coverage`) still reaches held revisions.
- **Answer check (D-198).** `review-list` and `review-show` carry what the answer check said about the calls (`passed`, `repaired`, `unchecked`, or `not run` for a revision made before it); `reviewTextOf` prints it under the header.
- **Support check (D-415).** The library support check's verdict is **hidden by default**: `review-list --show-check` carries `supportCheck` (the verdict by the policy in force, the state and the counts, `null` while it has not run; no sentence) and `review-show --show-check` prints its verdict, the sentences that passed as stating no fact, the sentences to read first and a "Not covered:" line, so the decisions it is measured against stay the operator's own. The check, its queue, its sweep and the replay that measures it against these decisions are in the [production README](production/README.md); it releases nothing and only a revision with a row here can be checked.
- **Standing.** `readLibraryStatus` reports `held` (with `heldRevision`), not `published`, and for a v2 recipe its `regeneration` state, `takesLeft` and `check`. `produce-library`
  skips it, a second take is refused while the first is held, and Quartermaster's `chooseScrollRecipe` never
  picks a v2 recipe, because no person's ask could be answered by a Scroll that waits for a read. A group that
  named a recipe before the plan made it v2 reads as stopped (`readScrollProduction`), so a join never sends its
  job again. Once every recipe is v2, Create commissions nothing; S-6 (waves) and S-7 (ask orders) own what fills
  the library and answers a question (D-138).
- **Decide.** `adapters/review-gate.ts` (`makeReviewGate`): `list`, `show` (the Scroll as plain text, with
  the cited passages on request), `release` (the revision becomes the asset's current revision and a `held`
  asset becomes `admitted`; never backwards; idempotent) and `reject` (final; the take is spent and the next
  take writes the next revision). The rules are pure in `domain/review.ts`. Each decision is one short
  transaction under the asset's admission lock. Operator commands: `content review-list`, `review-show`,
  `release`, `reject` (`apps/worker/src/review-operator.ts`, the runbook). Each decision also writes one
  `content.review_decided` event-log line (recipe key, outcome, revision, a refusal's code; no text).
- **Lock order.** Production root, job row, asset advisory lock, asset row, review row. Release and reject take
  the asset lock, then the asset row, then the review row, and no personal root.
- **Erasure.** None: shared content. `decided_by` is the operator's shell user, never a person of the product.
- **Not guarded** (they take coordinates only from rows made for a served revision): snippet anchors, Keep position
  targets (also checked against the current revision), reading facts of an exposure, and series admission
  (which reads the current revisions).

## The release policy for held library Scrolls (#674, D-418)

Status: **implemented and off** in every world, runtime-verified on real PostgreSQL with labelled fixtures, not on dev.

While the library support check is measured against the operator's own decisions (D-415), a person reads every generated Scroll. This is the
mechanism that, once the owner turns it on, lets a worker release a later Scroll of a topic a person approved, and no other. It adds nothing to
the gate's states: a policy release is the gate's own `release`, with `decided_by = policy:<name>`.

- **Rules** (`domain/release-policy.ts`, pure). `decideAutoRelease` returns a release or the first failing rule as a code: a replacement of a
  served Scroll (`replaces_served`), no single primary topic, a sensitive Scroll, a topic nobody approved, an unreadable document, no active
  coverage mapping, an answer check that did not pass, and a missing (`no_support_check`), stale-version (`stale_support_check`), unchecked or flagged
  support check. `assessRisk` makes the class: the catalogue's systems, the words and every recorded raise each propose a class and the highest wins
  (`raiseRisk`), so nothing lowers it. `domain/release-sensitive-data.ts` is the one data file of the owner's sensitive categories (systems, whole-word
  keywords, recent years, and the keys of a document that are not its words), versioned as `release-sensitivity.v1`. The words are `proseOf(document)`: every
  string of the document's own fields except identity, versions, measures and the integrity hash, so no text is dropped by how it begins.
- **The decision is made in the release transaction.** `adapters/release-policy.ts` (`makeReleasePolicy`: `sweep`, `releaseOne`, `approveTopic`, `revokeTopic`,
  `withdraw`, `proposeRaise`, `status`) passes the review gate a `ReleaseGuard`. Under the asset's lock the guard takes the policy lock, locks the
  topic's approval `for share`, reads the revision's facts again (asset status, topic and approval, coverage head, the support check of this checker version,
  answer check, document, raises) and runs `decideAutoRelease` on them, then counts the day's releases against the cap. The sweep's own read only finds
  candidates; nothing it read is passed on, so a topic revoked, a coverage retracted, a check replaced or a raise recorded after it looked still refuses the release.
  `adapters/release-policy-store.ts` is the SQL.
- **The sweep pages.** It reads the held revisions that pass the checks that need no body (a new asset, an approved topic, a mapping, a stored passed verdict of
  this checker version), least recently looked at first (never looked at before any), 100 to a page and at most ten pages a pass, and records what each
  stayed held for in `content.release_policy_looks`. A revision looked at in this pass is not returned again, and one whose hold is permanent under the rules in force
  (sensitive, unreadable, no answer check that passed, no single topic, a flagged verdict) is skipped, so a crowd of revisions that stay held never stands in front of a new
  one and is not read again until the rules change. The cap is counted from `content.revision_reviews` under the advisory lock `content.release-policy`.
- **Job.** `content.sweep-release-policy` (`production/release-policy-events.ts`), every ten minutes, no model and no network. The worker's
  `release-policy-jobs.ts` consumes it on every worker; with `KS_CONTENT_AUTO_RELEASE_ENABLED` off (the default everywhere) it finishes having read nothing.
  `KS_CONTENT_AUTO_RELEASE_DAILY_CAP` (default 5, at most 500) bounds the releases of a UTC day.
- **Commands.** `content policy approve-topic | revoke-topic | withdraw | status` (`apps/worker/src/policy-operator.ts`, the runbook). Each change writes
  one `content.release_policy_changed` line; each release one `content.release_policy_released` line (topic and revision); a pass one
  `content.release_policy_swept` line. Counts and codes only.
- **Withdrawal** is the existing one (`content.assets.status = 'withdrawn'`) with the topic's approval revoked and who, when and what became of the approval recorded (`content.release_withdrawals`) in the same transaction. A withdrawn asset is not admitted, so every exact read that names a revision (an exact encounter, the stored document, the play facts that judge a locked call, the Ask and Quick answer facts, the source pages of a what-if) refuses it.
- **Measurement.** The support-check replay counts `cli:` decisions only; a `policy:` decision is never an answer key (`libraryCheckStore.decided`).
- **Lock order.** Asset advisory lock, asset row, review row, then `content.release-policy`; the approval row is locked `for share` in the release
  transaction, so a revocation waits for it. No personal root.
- **Erasure.** None: shared content. `approved_by`, `revoked_by` and `proposed_by` are an operator's shell user or a model's role, never a person of the product.
- **Not built:** a producer of raises (nothing writes `content.release_risk_raises` yet; `proposeRaise` is its port), and any switch-on: that is the owner's decision.

## Reading facts v3 and v2 delivery (D-128, D-129, D-130)

Status: **implemented**; runtime-verified on real PostgreSQL with labelled fixtures, not yet on dev.

- **Reading facts v3** (`adapters/reading-facts-v2.ts`, stored as `reading_facts` with `v: 3`): one unit
  per stop and call, each with a rule for when it counts. Only read stops weigh (the weight the
  document's own measures give them); a call weighs 0, so playing never stands in for reading and not
  playing never blocks it. A read stop counts after 40 % of the time its words take at 230 words a minute
  (never under the policy's half second). A call is seen when reported `locked` or `revealed`, never by
  being on screen and never by the option picked, and is stored as engagement only; its ten seconds stay
  in the reading estimate. The recap is not a unit. v1 facts (`v: 2`) and Reels are unchanged;
  `ReadingFactsSchema` validates either on read.
- **Provenance** (`scroll-provenance.v2`, `asset_provenance`): the claims a Scroll cites, their sources,
  the production record and, for every stop, aside and the recap, the claims it cites. No new table.
- **Delivery.** `renderScroll` parses a stored revision on the client path by its schema and serves a
  v2 document whole to a client that declares `scroll-document.v2` (`cannot_render` otherwise).
  Discovery (`readDiscoveryCandidates`) offers a client that cannot render a v2 current revision the
  latest earlier v1 revision of the asset, or nothing. Exact reads, offers and links are never swapped.
  Direct open of a v2 asset by an old client ends in the document read's `cannot_render`.
  `renderableFormats`, region candidates and the Planner's capabilities accept either schema.
  Keep position targets use a v2 Scroll's stop ids.
- **Series total** (`readSeriesTotal`): the exposure context's `series.total` is the count of
  `series_units` of the series revision (D-130).
- **Snippet anchors for v2 (D-292).** A v2 Scroll has stops, not blocks. `snippet-anchors.ts` validates a snippet of one as a *moment*: exactly one whole read stop (`momentOf`, `anchorIsMoment` in scroll-model), in the v1 `scroll_passage` shape with the stop's id as the block, the whole text as the range and the hash of the words. A call stop, part of a stop, a changed hash and a block anchor are `invalid`. The quote is read from the exact revision and stored with the message. After a correction a moment is `changed` (no anchor map for stops). *Implemented; runtime-verified locally on real PostgreSQL, not yet on dev.*

## Discovery candidates and continuity

Status: implemented, CI-tested against real PostgreSQL. Related: #234.

Implemented backend capabilities, without navigation/API consumers: `ReadDiscoveryCandidates`,
`ReadExactEncounter`, `ReadContinuations`, `ResolveContinuityLink`, `ReadEncounterTopics` and
`ReadSavedMetadata`. They run in the caller's already authorized personal transaction and read
shared admission only; they create no personal activity. Existing Scroll/media ports are preserved.
The present access model is shared admitted assets; no private-content access policy is invented.

| Table (`0016`)                | Purpose, query, indexes                                                                                                                                                                                                            | Growth, retention, erasure                                                                                                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `content.discovery_revisions` | Admission-derived summary/facets, attribution version, indexed text and (0109) the stable random key `serve_rand`; keyed exact asset/revision. GIN text/facet indexes, the `serve_rand` index plus language/current-status/kind and explanation indexes on existing tables support bounded retrieval. | One bounded metadata row/revision; summary<=2000 characters, <=16 facets. Shared retained projection, no personal erasure.                                                           |
| `content.encounter_topics`    | Real primary/supporting/incidental attribution. Revision FK and topic/revision index; <=16 unique topics, positive weights sum<=1 enforced by SQL and domain validation.                                                           | At most 16 rows/revision. Shared retained facts; no personal erasure.                                                                                                                 |
| `content.series_units`        | Explicit versioned series/part -> immutable revision, primary series+revision+part and unique member constraint; asset/revision index supports exact metadata. No inferred total.                                                  | <=99 units/series revision; bounded admission batch<=100 units. Retained shared authority; no personal erasure.                                                                      |
| `content.continuity_links`    | Versioned explicit previous/next series step or related move, exact source/target revisions, strength and private authority reference. Unique active source+direction index; UUID lookup.                                          | <=3 active links/source revision. Replacements require a new ID and increasing link revision; older immutable facts remain inactive. Retained shared authority; no personal erasure. |

Revision insertion projects consumer-derived summary/text without altering document/provenance
bytes. Existing real revisions are backfilled. Topic authority `admitted-brief-taxonomy.v0` maps
only the actual approved seasons-v5/tides-v4/greenhouse concepts to `earth.seasons`, `earth.tides`,
`earth.greenhouse-effect`, one primary weight 1. It requires completed `reel_imports` facts matching
the frozen approved **run ID, script, media digest and size**, exact revision and import provenance.
The import-completion trigger runs after its import row exists in the same admission transaction;
a failed import leaves no projection. Synthetic imports and arbitrary editorial explanation-ID
lookalikes stay unknown. New generated Scroll attribution uses the private producer completion hook (`0015` + `0016`):
it requires actual same-scope writer closure/accounting and the exact published job, admitted
revision and matching model provenance. Fixture/foreign/incomplete authority stays unknown. The
same hook then admits the recipe's facet coverage (see Scroll coverage above).
Historical reconciliation remains deferred until a separate completed-run attestation port exists. No title-derived
concepts, invented semantic variety or personal-activity-derived topics exist. Part and related edges exist only
where the library plan declares them (see "Library series and related moves").

Discovery retrieves an indexed union of topic matches (max 40), text matches (max 30) and a rotating sample of the
general eligible inventory (max 100), deduplicates to<=100 current admitted candidates before scoring and
applies declared languages/formats plus exact Scroll capability negotiation/Reel document support.
It has no history traversal, embeddings or provider wait. Unknown-attribution inventory remains
eligible for unconstrained discovery.

Status: implemented, CI-tested against real PostgreSQL. Related: #674, D-408. No lane is ordered by asset id.

- **Order within a lane.** Each revision of the projection has a stable random key, `content.discovery_revisions.serve_rand`
  in [0, 1) (migration 0109, default `random()`, so every older and newer writer fills it; index
  `discovery_serve_rand_idx`). A lane reads its revisions in that order from a cursor. The cursor is a point of the key range
  derived from the `rotation` of the query (a decision's seed): it varies per decision, is the same for the same seed and is the
  beginning when there is no seed. The general lane is two index range scans (from the cursor to the end, and from the start
  up to the cursor), so a library of any size is read a slice at a time and the same lowest 100 assets are never every
  person's sample.
- **Topic lane.** Only primary and supporting attributions count, primary first, then the random order; a mention that is only
  incidental never takes a slot or ranks as the topic. The lane reads the revisions of the named topics (at most 16, the bound
  of `topicIds`) and is bounded by what those topics hold.
- **Unseen first (policy v2).** A query may carry `unseenFirst: { metUnitIds }` and `alwaysUnits`. `metUnitIds` is data: the
  explanation units the caller's owner of the person's history says the person has met (Experience: an activated exposure of the
  unit, in either format), a bounded array (at most `UNSEEN_FIRST_MAX_UNITS` = 1000 non-empty ids of at most 160 characters,
  otherwise `UNSEEN_FIRST_INVALID`). Content binds it as one array parameter and orders its own rows with
  `r.explanation_unit_id <> all($n::text[])`; it reads no personal table and runs no text a caller wrote. Every lane is read
  twice, with the list and without, and the unseen rows of every lane (those whose unit is not in the list) come before any other
  row (topic lane first, then text, then general), with the rest filling the cap, so nothing is left out and the last resort keeps
  its material. `alwaysUnits` (at most 4, the source's own) come before all of them, so the source's format twin is found. Each
  lane's index scan stops at its limit, so the list is compared only with the rows read; `<> all` measured faster than an
  `unnest` anti-join. Past the bound a heavier reader's oldest met units are not in the list and so sort as unseen here; the
  Composer's own `encountered` exclusion still filters the final pick. Without `unseenFirst` the read is exactly the plain one. A
  region read (`readRegionEncounterCandidates`) takes the same `unseenFirst` and only orders the place's bindings (unseen first,
  then by asset id): a region is a place the person chose, its read is the place's own bindings (up to 100, `hasMore` beyond), and
  an `expected` encounter is read whatever the list says.
- **Text lane.** Only when the query carries `text`, which only a person's own words supply. Retrieval never searches a source's
  title and summary. The match is a plain-text AND, as before.
- **No replay impact.** A stored decision freezes its candidates, so the order and sample retrieval reads change what future
  snapshots hold and never how a stored decision replays.
- **Composer's use.** `readVerticalCandidates` passes the decision seed as `rotation` and always reads some candidates of the
  format the person is not in (`OTHER_FORMAT_RESERVE`), so policy v2 can give format stickiness way to an unseen Scroll. The exact read negotiates the specified stored revision and
checks current admission; it never substitutes the asset's current revision. Snapshot watermarks
hash immutable bytes plus bounded attribution/sibling/series facts. Current eligibility must be
rechecked by future activation; a read does not reserve publication or grant activation authority.

Existing format siblings use real explanation identity and current admitted revision, distinct
from explicit series/related links. Sibling references and continuity facts alone are not
rendering/activation authority: the consumer must exact-read the target with capabilities. A
continuity read returns at most 3 active exact links and omits withdrawn endpoints. Expected link,
source, target and optional link revision must all still match on resolution.

`admitContinuity` is an operator/admission capability requiring the existing `AdmissionTx`; no
consumer input invokes it. A single shared metadata advisory lock serializes bounded batches,
with no personal root acquisition or external wait. It validates real supplied authority refs,
exact admitted revisions, unique units/slots and declared adjacent parts within the same series
revision. A series revision is a complete immutable unit manifest: replay cannot extend/reduce it,
and one immutable asset revision cannot acquire conflicting series identities. Historical
versions remain retained; only explicit active links authorize continuation, never ordinal inference. Related edges cannot masquerade as series, format twins cannot masquerade as another
explanation, and contradictory immutable link replay refuses. There are no runtime relationship
fixtures. Missing authorized facts remain unknown/unavailable.

### Library series and related moves

Status: implemented, CI-tested against real PostgreSQL, browser-checked locally (D-059).

`domain/library/continuity.ts` declares, by recipe key, the series of the library (ordered parts on one
planet, each building on the one before) and the related perspectives. `content admit-continuity
[--dry-run]` (`adapters/library-continuity.ts`, planning in `application/plan-library-continuity.ts`) resolves
each key to the Scroll revision admitted now and calls `admitContinuity` under the fixed authority
`library-plan.continuity.v1`. One transaction per series (its manifest and its previous/next links), one for
all related moves. It writes `content.series_units` and `content.continuity_links` only.

- A series with any part unpublished is skipped whole, because a series revision is a complete manifest.
  A related move with an unpublished end is skipped. Both are listed in the result.
- Idempotent: a link the store holds exactly (same target, relation and strength) is left alone, and link
  ids are derived from their content, so a repeated or concurrent run is the same link, not a conflict.
- A changed declaration, or a Scroll republished as a new revision, gets a new series revision (units
  differ) and, in any slot now held by a different link, a replacement with a new id and the next link
  revision. The old rows stay as inactive history; an older revision keeps its own links.
- The API carries no series total, so a client shows "Part 2", never "Part 2 of 3".
- Each source revision has one related slot (the active slot is unique per source and direction), so a
  recipe is the source of at most one related move.

Saved metadata joins<=100 exact references in one batch, preserves original revisions and reports
available/corrected/withdrawn. Only corrected includes a different current revision; withdrawn or
missing content exposes no title or replacement. This is hydration, not a Saved mutation/API.

Migration rollout is additive; existing processes ignore the projection. The three existing-table
indexes use the transactional migrator with 5-second lock/60-second statement timeouts against the
small admitted inventory; larger rollout requires a separately reviewed concurrent-index plan.
No previously registered SQL/hash changes. `0015` must be reconciled before deploying 16+ to dev.
CI fixtures exercise metadata/authority facts, not actual approved media bytes or runtime journeys.

`ReadEncounterAttribution(scope, exactRef)` is a backend-only historical metadata capability for
an already validated owned activated encounter. It returns exact immutable explanation identity,
real topic/facet attribution and metadata watermark/version, including retained withdrawn revisions.
It returns no document, provenance or render authority. Missing metadata remains unknown. New
offers and activations must separately use current `ReadExactEncounter` capability/admission checks;
this historical read never authorises opening withdrawn content.

## Encounter traits and play level (D-192, D-193)

Status: implemented, unit-tested; read on real PostgreSQL by the play-wall integration test. Not yet run on dev.

Every candidate that discovery reads carries `traits`, derived from the stored document of its revision on read
(`domain/traits.ts`). A revision is immutable, so nothing is stored and nothing can drift:

- `playLevel`: `plain` (every v1 Scroll, every Reel, and a v2 Scroll with no stage and no call), `stage` (a stage, or a
  single call) or `game` (at least two calls, one of them the Final call). It is a fact of the document and the same
  for every reader.
- `readingMinutes`, from the document's own measures.
- `misconceptionClaim`: the public text of the common wrong idea the Scroll is built to meet (its Plot twist), for a v2
  Scroll with one.
- `seriesTotal`: the parts of the Scroll's series, counted from `content.series_units` and never declared (D-059).

Composer ranks by `playLevel` (Format per play level, exploration per play level) and describes the rest to Jev
(`jev.2`). None of it says what any reader did: which option anyone picked, whether it was right, sparks and tiers are
play results and stay in `play` (D-063).

`ReadPlayLevel` (token `READ_PLAY_LEVEL`) gives Evidence the level of one exact revision when it counts a reading:
`plain` for a Reel, for a revision that does not exist and for one the review gate holds. Shared content only; no lock.

## Binding a request to the current head of an encounter

Status: implemented, CI-tested against real PostgreSQL. Related: #239.

`LOCK_CURRENT_ENCOUNTERS` is a separate public authority port; existing historical
`ReadExactEncounter` and discovery/open semantics remain unchanged. Inside a caller's already
locked personal scope it locks at most 101 exact references' asset rows SHARE in UUID order,
then checks current head, admission and capabilities. Missing/withdrawn/corrected/unsupported
references provide no encounter. Locks remain to commit, so Supply cannot bind a stale ready
head while withdrawal passes it. Content admission never acquires a personal root.

Migration `0024` adds Content-owned `availability_revision` and `availability_changed_at` to
`assets`, with a trigger increment only for actual status/current-revision changes. The existing
asset revision cannot distinguish withdrawal then re-admission of identical bytes. The positive
integer counter fails closed on overflow; no-op/counter-only edits preserve both fields. The port
returns these public availability facts so readonly Supply status can monotonically invalidate
and restore its exact one-time binding. It writes no personal state/hint; global changes require
fresh resource reads. No new rights class is inferred beyond the existing shared admitted model.

## Keep position targets

Status: implemented, CI-tested against real PostgreSQL. Related: #246.

`LOCK_KEEP_POSITION_TARGET(scope, owner, ref)` is a minimized Content read inside
an already open own `PersonalScopeTx`. The production caller must first acquire
Identity's actual same-transaction `FENCE_OWN_ACCOUNT` and check exact Saved
membership, in that order. `owner` is its fresh `AccountAccess` result: plain
context **does not certify a held lock**, and must never be copied/cached as an
authorization capability. This port checks the account actor and exact owner
account/universe/epoch binding and uses `transactionOf(scope)` to reject closed
transactions. Identity/account-gate enforcement and membership remain the owning
consumer's responsibilities; no new fence, lifecycle or ownership bypass exists.

After validating the existing strict `KeepAssetRefSchema`, Content takes SHARE
on the one asset and separately re-reads current head/status after any wait.
The lock remains held until transaction end. Missing, withdrawn, corrected,
missing revision, unsupported or malformed documents all return `undefined`.
The exact stored Scroll is parsed by canonical stored admission validation,
including integrity/measures/bounds; its asset/revision and stored digest must
match. Only canonical **top-level** block IDs leave the adapter; disclosure
children never become parent anchors. Canonical document limits bound the list.
Reel uses the same exact immutable document/media-key binding as the existing
media-access port and canonical `ReelDocumentSchema`; only that document's actual
validated `durationMs` leaves, never derived reading estimates. Existing codec
limits are inherited from its validator, with no copied universal 60-second policy.
No media existence/probe/byte-read claim follows from this database-only port.

Output is only `{kind:'scroll', topLevelBlockIds}` or `{kind:'reel', durationMs}`.
No document, metadata, provenance, media key/URL, source, topics, exposure,
capabilities or private position are returned. No external I/O, jobs, Evidence,
mutation or rendering grant occurs. This implements no Keep storage/HTTP/client
or selective privacy clearing. Existing Content readers/mutators are unchanged.
`keep-position-target.test.ts` uses synthetic real-PostgreSQL fixtures in Actions
for both SHARE/mutation orderings, post-wait refusal, minimized canonical facts,
bindings, unsupported data and rollback; no live Keep journey is claimed.

`ReadSavedPageMetadata` is the bounded private-library consumer port for at most 100
already-authorized Saved refs. It shares the existing metadata query and returns
actual asset kind even when withdrawn metadata is absent. It neither infers kind
from a title nor opens/authorizes withdrawn content. A missing/invalid actual
kind is an invariant failure; no placeholder kind is fabricated. Legacy
`ReadSavedMetadata` retains its original shape. Experience calls only this public
port, never Content tables directly. No renderer, document admission, peer state,
encounter, activity or provider work results from these list reads.

### Region candidate projection (U04)

`content.region_bindings` is a shared derived lookup owned by Content, maintained atomically by the coverage-head trigger for admission, correction and retraction. The `(topic_id, facet_id, asset_id, asset_revision)` key supports an exact canonical Region query with 100 hydrated candidates and one key-only lookahead; an explicitly displayed asset is looked up directly. Each result independently revalidates current admitted Scroll revision, complete canonical mapping/document/provenance and render capabilities. There is no topic-label, global-pool or model fallback. Generated Scrolls reach this lookup through the recipe coverage admitted at publication.

`contentRegionStores` concretely inventories this shared projection: at most 16 bindings per mapping head, retained with immutable coverage history, no account/universe dependency, preserved by full and selective personal erasure. It is not personal state or admission authority. Up to three actual decision candidates are fenced under current Content asset/head SHARE locks through the personal commit.

## Reels from Cutroom (D-041)

Related: #240.

Status: **implemented**, exercised against a labelled fake Cutroom and a disposable pool in CI.
**Not yet runtime-verified**: no real order has been placed through it. The operator runbook is
`docs/v2/operations/cutroom-and-spend.md`.

A Reel script is a JSON file in `approved/reels/`, approved in Git and shipped with the release. It
names the library recipe whose Scroll is its twin, and every claim rests on that Scroll at one
revision. The worker's `reel` operator commands (`apps/worker/src/reel-operator.ts`) take it from
there:

| Command                                        | What it does                                                                               | Spends money      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------- |
| `reel check`                                   | The product's own script checks and the repetition rule, offline                           | No                |
| `reel order --until plan`                      | A rehearsal: Cutroom plans the Reel and says what it would cost                            | No                |
| `reel order --until video`                     | Needs a finished rehearsal; claims 75 cents in the shared pool, then sends one request     | Up to 75 cents    |
| `reel follow`                                  | Reads Cutroom's runs, records how the request ended, settles the claim, publishes the Reel | No                |
| `reel receive`                                 | Publishes a Reel another world already paid for                                            | No                |
| `reel status`, `reel write-off`, `reel settle` | Read the state, give up an uncertain attempt, close a held claim                           | No                |

How it keeps its promises:

- **Claim before order.** A paid attempt cannot leave `reserved` without a pool claim; the table's own
  check refuses it. The pool counts the whole ceiling until the request is settled at its real cost.
- **The ceiling is always 75.** Cutroom stops a run that reaches its ceiling after it was paid for, so a
  lower ceiling only risks paying for no Reel. `order` refuses any other ceiling, a paid order without a
  finished rehearsal of the same script, and a plan whose estimate plus 20 cents passes 75.
- **The order keeps its script.** `content.reel_orders.script_json` is the exact approved script the order
  was made from, so `follow` never depends on the file that ships later. A new order under the same name
  waits until an earlier one, made from different content, has ended.
- **One send, never a resend.** The exact bytes are stored before sending and a dispatch intent is
  committed first. A POST whose outcome is unknown is only looked up by request id; a run that exists is
  adopted, and nothing is ever sent twice. A retry is a new take, which is a new request id.
- **Settle once, at the real cost.** A request is finished only when its last run has finished and
  Cutroom is not continuing it; the cost is the sum over the chain (an original and at most one
  automatic continuation). A completed Reel is published first and settled after, so an import that
  fails keeps its claim open at the whole ceiling.
- **Receive costs nothing.** The second world rebuilds the request from the same script, checks it byte
  for byte against the pool's record, and publishes the same Reel. It never claims, sends or settles.
- **The twin.** The Reel is admitted with the Scroll's explanation unit and planet, so Explore offers the
  format switch between them. Its coverage is decided in the same transaction (see Reel coverage above) and the
  publication result says whether it was `admitted` or why not. It carries the engine's own record, labelled "engine-attested, not
  independent".

Layers: `domain/reel/` holds the pure rules (script checks, fingerprints, request compiler, chain fold
and record check); `application/reel/` the use cases and their ports; `adapters/reel/` the ledger, pool,
Cutroom HTTP client, media install and publication. Tables: `content.reel_orders`,
`content.reel_attempts`, `content.reel_imports`, `content.media_objects`. There are no jobs and no
notices: every step is an operator command. Lock order: none is held across a call; each ledger move is
one statement, and publication takes the per-asset advisory lock. Erasure: shared public, preserved
(`contentReelStores`, checked against the real schema).

Failure and recovery: every command can be run again. A crash after the claim resumes at the dispatch;
after the intent, the attempt is reconciled by lookup; after the POST, `follow` continues. Anything that
is not ready (Cutroom down, the pool unreachable, the video not readable yet, the Scroll not published
here yet) is reported with a code and changes nothing.

Related: `docs/v2/decisions.md` D-041, `docs/v2/carried-forward-facts.md` CF-60 to CF-66, `ops/pool/README.md`.

## Shareable content for Social (D-042)

Status: implemented, CI-tested against real PostgreSQL. Related: #242.

Social shows a Reel or Scroll as a card in a conversation and on the share landing. It reads the card's public
metadata through two read ports in `public.ts`, never through Content's tables.

| Port | Where it runs | Used for |
| --- | --- | --- |
| `READ_SHAREABLE_CONTENT` (`readShareableContent(scope, refs)`) | inside the caller's personal or shared transaction | cards in a conversation, validating a send |
| `READ_PUBLIC_CONTENT` (`makeReadPublicContent(db)`) | its own short read on the pool, no personal scope | the public link preview and the landing page |

For each requested `(assetId, assetRevision)` the read returns one of:

- `available`: the asset is admitted and that revision is current: title, kind, a short summary, language.
- `corrected`: the asset is admitted and a newer revision is current; it carries the current revision's metadata too,
  so a card can offer the revised version.
- `unavailable`: unknown, withdrawn, an unknown revision, or a revision with no published summary. No reason is given.

It reads only the asset's status and kind, each revision's title and language, and the discovery summary. It never reads the
document, a reading fact or any personal state, and it creates no evidence. One SQL statement serves up to 100 refs.
*Implemented.*

## The library's prose for a room's daily items (v3 R-5, D-176)

Status: implemented, CI-tested against real PostgreSQL. Not runtime-verified on dev.

Rooms drafts a day's question and Spot the flaw from the library's own words. It reads them through two ports in `public.ts`
(`libraryPassageProviders`, built over the pool, no personal scope), never through Content's tables.

| Port | Answers |
| --- | --- |
| `READ_LIBRARY_PASSAGES` (`makeReadLibraryPassages(db)(topic, limit, only?)`) | The current revision of each admitted library Scroll whose **primary** encounter topic falls under a room's topic (a system covers every planet of it), with its title, summary and prose blocks. At most 100, by asset ID. With `only` (an exact asset and revision) it answers for that one Scroll alone, which is how an operator's approval re-checks a question: by its own address, not by finding it among the first hundred |
| `READ_LIBRARY_PASSAGE_TEXT` (`makeReadLibraryPassageText(db)(ref)`) | The text of one block of an exact revision, only while that revision is still the current one anyone may be served; absent when the Scroll was corrected, withdrawn or held |

A block is a paragraph of a v1 document, or one stop's paragraph and line blocks joined by a space for a v2 document (its `blockId`
is the stop's ID). A Scroll held or rejected by the review gate, withdrawn, or made for a thread (D-049) is never returned. Reads
only; no evidence, no personal state. The operator's approval of a ritual item uses the second port to prove a cited passage still
says what it did. *Implemented.*

A room's Launch (v3 R-6, D-179) reads the same Scrolls for their **calls** through a third port, `READ_LIBRARY_CALLS` (`makeReadLibraryCalls(db)(topic, limit, only?)`, in `libraryPassageProviders`): the `call_it` and `final_call` stops of each admitted `scroll-document.v2` under the topic, each with its stop ID, question, options, right option and reason as written. A v1 document and a Scroll with no call are not listed; the same Scrolls are excluded as for the prose. The operator's approval of a deck reads one exact revision with `only`. Reads only. *Implemented.*

A room's Watch together (v3 R-10, D-256) reads the library **Reels** under a topic through a fourth port, `READ_LIBRARY_REELS` (`readLibraryReels(scope, topic, limit, only?)`, in `contentProviders`, inside the caller's transaction): the current revision of each admitted `reel-document.v1` whose primary encounter topic is the topic (the same rule that places a Scroll under one: a system covers its planets), not a fixture, not under review and with a stored length, by title, at most 50. With `only` it checks one Reel. It gives the Reel, its title and its length and nothing else; a Reel is opened only by a person's own device, through the ordinary exposure. Reads only. *Implemented.*

## Thread sequences and snippet anchors (#243, D-046)

Social threads read three things from Content through `public.ts`, never through its tables. None creates evidence.

| Port | Where it runs | Used for |
| --- | --- | --- |
| `READ_CONTENT_SEQUENCE` (`readContentSequence(scope, root)`) | inside the caller's shared transaction | the episodes of a thread: the declared series (`series_units`, latest series revision) that contains the root revision, by part, else the root alone; each unit says `ready`, `corrected` or `unavailable` |
| `VALIDATE_SNIPPET_ANCHOR` (`validateSnippetAnchor(scope, target, anchor)`) | inside the caller's shared transaction | send: the target is the current admitted revision; a Reel range is at least a second and inside the duration; a passage has a stable block, a valid text range and the quote hash; a block has its id, type and version and a settings snapshot that scroll-model accepts, with personal values only if confirmed |
| `RESOLVE_SNIPPET_ANCHOR` (`resolveSnippetAnchor(scope, stored)`) | inside the caller's shared transaction | open: the same anchor while the revision is current; a Scroll anchor re-pointed through `deriveAnchorMap` and `repointLocator` (`mapped`, with settings reset when the block changed); `changed` for a corrected Reel or a passage that is gone; `unavailable` when withdrawn |

Validation returns the quote, the block label and the settings in words, which Social stores with the message. Resolution
reads the document only to find the block; it returns the quote, label and description for the revision it points at.
Reel ranges have no time mapping between revisions, so a corrected Reel is never played from an old range.
The pure rules (`domain/snippets.ts`) are `reelRangeHolds` and the snippet grammar. *Implemented; runtime-verified locally
with a real Reel and two Scrolls, not on dev.*

## Made-to-order Scrolls for a thread's branches (#244, D-049)

A What if or Another perspective in a thread is produced as a Scroll that belongs to that thread and to no one's map.
Content owns the order, the production and the access rule; the `scenarios` module decides the branch and Supply the cap.

| Store | Role |
| --- | --- |
| `content.made_to_order_scrolls` | One row per order: recipe `order-<32 hex of the branch id>`, the asset it will become, mode (`what_if`, `perspective` or `question`), the code-built brief, one to three research pages, the kicker and the framing (the Hypothetical label with its premises, the lens, or factual for an answer). A branch's order holds no person and no words of a member; a `question` order (S-7, D-218) holds the person's own question in its brief until supply's erasure sets it empty. |

| Port (`public.ts`) | Where it runs | Used for |
| --- | --- | --- |
| `RECORD_MADE_TO_ORDER_SCROLL` | inside the caller's personal transaction | record an order (idempotent per order ID); returns its recipe and asset |
| `READ_MADE_TO_ORDER_PRODUCTION` | on the pool | the standing of one order: not started, running, published (asset revision and title), retryable (next take) or stopped |
| `READ_MADE_TO_ORDER_PRODUCTION_IN` | inside the caller's personal transaction | the same standing, for a use case that already holds a transaction (a person's ask waiting on its order): no second connection |
| `READ_SCROLL_QUICK_ANSWER_FACTS` | inside the caller's transaction | for a Quick answer (D-253): the title and the words of the read stops from the start of the exact v2 revision up to and including the stop the words were selected in, plus that stop's plainer words; never a later stop and never a call; absent for an anchor that is not a read stop, a held or rejected revision, a revision of a withdrawn asset (D-418), or a v1 document |
| `READ_SCROLL_ASK_FACTS` | inside the caller's transaction | for "Ask from here": the title, the words of one stop and the questions the Scroll suggests, from the exact immutable v2 revision; absent for a stop that is not there, a held or rejected revision, a revision of a withdrawn asset (D-418), or a v1 document |
| `READ_SCROLL_SOURCE_PAGES` | inside the caller's transaction | up to three research pages chosen by code for a branch: the provenance sources of the root Scroll, else the same explanation's other Scroll, else the library recipe's pages |
| `READ_SCROLL_EVIDENCE` | inside the caller's transaction | up to 24 claims (passages of public sources) that the root Scroll's provenance records, else the same explanation's other Scroll's: what a what-if's short answer may cite (D-212). Stored text only, under the same review gate as the source pages; nothing is fetched |
| `CHECK_ASSET_AUDIENCE` | Experience and Social, wherever an ID reaches or quotes a Scroll: open, document read, save, like, hide, navigation, the saved list and page, snippets, the data export | given `ReadOn` (the caller's open transaction, or the pool for the lock-free document read) and the IDs, answers the subset the caller may reach; an ordered Scroll is in it only if an ordering module's audience says so: `READ_ORDER_AUDIENCE` (the scenarios module: members of the branch's thread, now) or `READ_ASK_ORDER_AUDIENCE` (the supply module: the person whose own, not cancelled, request made it). Each answers only for the orders it made, and the answers are joined. Any other asset always is |

An ordered Scroll is published with **no topic attribution and no coverage**: it adds no planet, region or lane, is
left out of every discovery candidate read and out of the shareable card read (it reads as unavailable there).
`Open` and `Read document` refuse it (`asset_not_found`, `exposure_not_found`) for anyone outside its thread.
Production is the same `content.produce-scroll` job, takes and stop rules as a library recipe; see
`production/README.md`. *Implemented. Not runtime-verified on dev.*

