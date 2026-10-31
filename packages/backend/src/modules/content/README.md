# modules/content

## Library plan and concept catalogue

The library plan is code-owned data in [`domain/library/`](domain/library/README.md): the topic
**systems**, the **planets** (topics) in each, the **facets** (kinds of angle) each planet can be
explained from, and the explanation **recipes** the generator runs. `content-concepts.v1` is
derived from it, so a system, planet or facet exists exactly where the plan declares it, with a
parent and a one-line meaning. Prefixes, titles, discovery tags and personal or model labels never
establish membership. The catalogue and each facet meaning have deterministic SHA-256 identities.
_Implemented._

A coverage mapping records the catalogue digest it was decided against, but reads do not compare it:
the plan grows, and every edit changes the digest. Each binding pins its own facet meaning instead.
When a read finds a binding whose facet has vanished or changed meaning, it leaves that binding out of
the returned mapping (the facet is unmapped), and never throws. Target identity and locators must
still fit the immutable document, and a mismatch there is corrupt data and throws. Geography ignores
supports whose meaning changed in the same way. _Implemented._

After a plan edit, the operator runs `dist/operator.js content readmit-coverage [--dry-run]`. It
decides coverage again for every published generated Scroll revision through `admitRecipeCoverage`,
one short transaction each: an unchanged decision appends nothing, a changed one appends a corrected
head, and history is kept. It prints counts (`considered`, `appended`, `unchanged`, `skipped`). It
uses shared content only (no provider, personal root or network) and is refused outside the operator
worlds. _Implemented; not yet run against dev._

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
changes qualification policy, and no Reel time mapping exists.

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
| `content.revision_reviews`                              | `0072_content_review_gate`                       | The review gate (D-138): one row for each v2 library revision that was stored held, its state `held` / `released` / `rejected`, and for a decision who (`cli:<operator>`), when and (rejection) why                                                                            | None: shared content       |
| `content.coverage_revisions` / `content.coverage_heads` | `0022_content_coverage`                          | One immutable facet-to-block mapping per correction or retraction, and one monotonic head per asset revision. `content.region_bindings` (`0037`) is the derived lookup by planet and facet                                                                                        | None: shared content       |
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
| `ReadScrollPlayFacts` (token `READ_SCROLL_PLAY_FACTS`) | play | The calls of one stored `scroll-document.v2` revision (stop id, kind, number of options, the right option) and the landmark its Final call awards (key and name, or none), read from the immutable document (not cached; a person locks at most four calls a Scroll). `undefined` for a revision that does not exist, is not v2, or that the review gate holds or rejected (D-138). Only play uses it, to judge a locked pick on the server (D-181) and to award the landmark (D-188) |
| `ReadScrollReadingFacts` (token `READ_SCROLL_READING_FACTS`) | experience, evidence                                                       | The block weights and types, the owner of each nested block and the reading estimate of one stored Scroll revision, derived at admission from the document's code-set measures and validated on read. Old facts versions are derived from the immutable admitted document on read until re-import persists the current view; unsupported stored documents raise `READING_FACTS_REQUIRES_REFRESH` rather than masquerading as a lineage mismatch                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `RenderScroll` (token `RENDER_SCROLL`)                       | experience                                                                 | Reads the stored consumer document (never provenance), parses it on the client path, and **negotiates** it for the capabilities the client declared (D-012): unsupported blocks become readable fallbacks, essential ones are reported. Parsed documents are cached (immutable, 32 entries)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `FindAssetForAction` (token `FIND_ASSET_FOR_ACTION`)         | experience actions                                                         | Does the asset exist, is it admitted, at which revision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `admitRecipeCoverage(ports, tx, recipe, ref)`                | The production publication hook only                                       | Inside the production transaction: lock the revision's coverage, read the stored document and provenance, derive the bindings from the recipe (`scroll-recipe-coverage.v1`) and append the next head, or return `not_admitted` with a code. Idempotent for an identical decision. No model call, no network, no personal root                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `readmitRecipeCoverage(ports, recipes, {dryRun})`            | Operator command `dist/operator.js content readmit-coverage [--dry-run]`   | Lists every stored revision of generated Scrolls, finds each recipe by asset ID, and runs `admitRecipeCoverage` in its own short admission transaction. Idempotent. With `--dry-run` nothing is written. Returns counts; shared content only, refused outside the operator worlds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

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

Production runs as `content.produce-scroll` worker jobs, sent by Quartermaster and by the operator's
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
- **Planned.** Snippet anchors for v2 passages (`snippet-anchors.ts` is v1 only), the reader (S-1c).

## Discovery candidates and continuity

Status: implemented, CI-tested against real PostgreSQL. Related: #234.

Implemented backend capabilities, without navigation/API consumers: `ReadDiscoveryCandidates`,
`ReadExactEncounter`, `ReadContinuations`, `ResolveContinuityLink`, `ReadEncounterTopics` and
`ReadSavedMetadata`. They run in the caller's already authorized personal transaction and read
shared admission only; they create no personal activity. Existing Scroll/media ports are preserved.
The present access model is shared admitted assets; no private-content access policy is invented.

| Table (`0016`)                | Purpose, query, indexes                                                                                                                                                                                                            | Growth, retention, erasure                                                                                                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `content.discovery_revisions` | Admission-derived summary/facets, attribution version and indexed text; keyed exact asset/revision. GIN text/facet indexes plus language/current-status/kind and explanation indexes on existing tables support bounded retrieval. | One bounded metadata row/revision; summary<=2000 characters, <=16 facets. Shared retained projection, no personal erasure.                                                           |
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

Discovery retrieves an indexed union of topic matches (max 40), text matches (max 30) and general
eligible inventory (max 100), deduplicates to<=100 current admitted candidates before scoring and
applies declared languages/formats plus exact Scroll capability negotiation/Reel document support.
It has no history traversal, embeddings or provider wait. Unknown-attribution inventory remains
eligible for unconstrained discovery. The exact read negotiates the specified stored revision and
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
  format switch between them. It carries the engine's own record, labelled "engine-attested, not
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
| `content.made_to_order_scrolls` | One row per order: recipe `order-<32 hex of the branch id>`, the asset it will become, mode (`what_if` or `perspective`), the code-built brief, one to three research pages, the kicker and the framing (the Hypothetical label with its premises, or the lens). No person and no words of a member. |

| Port (`public.ts`) | Where it runs | Used for |
| --- | --- | --- |
| `RECORD_MADE_TO_ORDER_SCROLL` | inside the caller's personal transaction | record an order (idempotent per order ID); returns its recipe and asset |
| `READ_MADE_TO_ORDER_PRODUCTION` | on the pool | the standing of one order: not started, running, published (asset revision and title), retryable (next take) or stopped |
| `READ_SCROLL_SOURCE_PAGES` | inside the caller's transaction | up to three research pages chosen by code for a branch: the provenance sources of the root Scroll, else the same explanation's other Scroll, else the library recipe's pages |
| `READ_SCROLL_EVIDENCE` | inside the caller's transaction | up to 24 claims (passages of public sources) that the root Scroll's provenance records, else the same explanation's other Scroll's: what a what-if's short answer may cite (D-212). Stored text only, under the same review gate as the source pages; nothing is fetched |
| `CHECK_ASSET_AUDIENCE` | Experience and Social, wherever an ID reaches or quotes a Scroll: open, document read, save, like, hide, navigation, the saved list and page, snippets, the data export | given `ReadOn` (the caller's open transaction, or the pool for the lock-free document read) and the IDs, answers the subset the caller may reach; an ordered Scroll is in it only if `READ_ORDER_AUDIENCE` (provided by the scenarios module: members of the branch's thread, now) says so; any other asset always is |

An ordered Scroll is published with **no topic attribution and no coverage**: it adds no planet, region or lane, is
left out of every discovery candidate read and out of the shareable card read (it reads as unavailable there).
`Open` and `Read document` refuse it (`asset_not_found`, `exposure_not_found`) for anyone outside its thread.
Production is the same `content.produce-scroll` job, takes and stop rules as a library recipe; see
`production/README.md`. *Implemented. Not runtime-verified on dev.*

