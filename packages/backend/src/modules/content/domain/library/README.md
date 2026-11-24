# Library plan

Code-owned data that says what KnowScroll holds Scrolls for. It is the **authoring source** of the topic catalogue (D-419):
`content catalogue sync` imports its systems, planets and facets as the next release of the catalogue in Postgres (`../catalogue/`,
`content-concepts.v1`), and the first release is exactly this plan. What the code reads of topics, facets, labels, looks and thresholds is the
catalogue port, not this file; the recipes below are still read from here (and from `content.recipes`) through the `RecipeBook`.
It lives in `domain/` because the catalogue's import and its seed are pure functions of it. It has no behaviour, no storage and no model call.

| Term               | Meaning                                                                                                                                                                                                                                     | Blueprint                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| **System**         | A broad domain, such as Machine learning. Parent of its planets.                                                                                                                                                                            | Topic system, organising star |
| **Planet** (topic) | An explored subtopic, such as Attention. Forms from at least three distinct qualified explanation units over at least two facets.                                                                                                           | §12                           |
| **Facet**          | A kind of angle on a planet (mechanism, example, limits...) written as a topic-specific id with a one-line meaning.                                                                                                                         | Region                        |
| **Recipe**         | One explanation unit the generator writes as a Scroll: a stable key, explanation unit, asset UUID, planet, facet (and optionally a supporting facet), a brief, one to three research pages, and whether it is interactive and of what kind. | §11                           |

## Files

- `plan.ts`: the shapes (`LibrarySystem`, `LibraryRecipe`, `INTERACTIVE_KINDS`, `STAGE_KIT_IDS`, `ScrollV2Plan`, `ScrollV3Plan`).
  A `LibrarySystem` may also name its `sceneFamily` (the silhouette) and its `haze` (one of teal, cobalt,
  coral, amber, pink, violet; a different one for each of the first six systems). Scenes gives both to a system once and never
  changes them, so edit them for new systems only (D-102); a new system that names none gets them assigned from its id, and may repeat
  one (D-419). A system, planet or facet may also carry `sameMeaningAs`: the earlier wordings that its new wording only rephrases, which
  keeps the certificates decided against them valid (see "Rules for editing the plan").
- `earth.ts`, `space.ts`, `machine-learning.ts`, `human-body.ts`, `computing.ts`, `history.ts`: one
  system each, with its planets, facets and recipes. The record key of a recipe is the operator key
  (`content produce-scroll --topic <key>`).
- `continuity.ts`: which recipes form a series (ordered, 2 to 4 parts, one planet) and which are
  related perspectives, by recipe key. `content admit-continuity` admits them (D-059). `continuity.test.ts`
  checks them.
- `serving.ts`: pure rules over the plan and over stored recipes: which recipes serve a catalogue brief (`servingOrder` over any list, `recipesServing` for the plan alone), a recipe's standing from
  its takes, which take a send should name, and what a library run queues.
- `generated.ts` and `recipe-draft.ts` (D-412): recipes stored in the database. `generated.ts` holds the reserved `gen-` key prefix, the key,
  explanation-unit and plan every stored recipe has, the `BookRecipe` shape the `RecipeBook` hands out and the statuses. A stored recipe is a
  **document v3** recipe (#781, owner decision 4 on #771): its plan is the proposal's own `shape` and section intents and nothing else
  (`StoredScrollV3Schema`, the rule migration 0124 checks, `generatedScrollV3PlanOf`, which adds `misconception: none`); it names no pictures, so the
  writer picks the kinds from the closed set by what its passages hold, and the statement picture is always available. `GENERATED_SCROLL_V3_MARKER`
  is the key-only stand-in the code that holds just a key reads (its shape and sections are placeholders). `recipe-draft.ts` holds the
  strict shape of a model's proposal (title, facet, brief, `shape`, two or three `sections` of 4 to 120 characters, pages) and `checkRecipeDraft`, which
  decides it (shape, facet, candidate pages and the passage pool, near-duplicates, identity). The words a brief or a section may not name are `quiz`,
  `quizzes` and `interactive`: document v3 has no place for them; a diagram, chart or picture may be named now. A code recipe key, unit or asset never
  starts with the prefix (`generated.test.ts`).
- `index.ts`: assembles the systems and the `RECIPES` record. `../../production/topics.ts` is a thin
  index over it.
- `library.test.ts`: the plan's acceptance rules (50 to 60 recipes, at least 22 interactive over all
  six kinds, at least three recipes and two facets per planet, a recipe for every facet, unique identities,
  allowlisted pages). `serving.test.ts` covers the serving rules.

## Recipes produced as v2 Scrolls

No recipe is produced as a v2 Scroll any more. A recipe with `scrollV2` would be written as a `scroll-document.v2` Scroll and held for an
operator's read before anyone is served it (D-129, D-138), and the v2 production path, the v2 writer and the answer check on its calls
(D-198) still exist. But the plan holds no `scrollV2` since #790: the 22 recipes a drawing kit drew became document v3 recipes in
#787, and the other 33 (the 32 plain v2 recipes and the v1 recipe `exoplanet-kinds`) in #790. The v2 plan each of them had (the fourteen whose kit was deleted in #799, #802 and #809 kept none), and the kit
of the 8 whose kit still exists, is kept in `production/spike-v2/former-v2-plans.ts` (`FORMER_V2_PLANS`) for the v2 writer spike and the tests of the v2 path,
until the v2 code is deleted (Phase 6); an integration test makes a recipe v2 again for its own process with `markFormerV2Recipe`
(`tests/integration/support/scroll-v2.ts`). `library.test.ts` pins that no recipe carries `scrollV2` and none carries both plans.
`content regenerate` makes a take again for a recipe the plan marks v2 or document v3 (D-197).

## Recipes produced as document v3 Scrolls

A recipe with `scrollV3` is written as a `scroll-document.v3` Scroll and held for an operator's read (#771, #783). Since #787 the
22 recipes that had a drawing kit carry it, and since #790 every other recipe does too, so **every recipe of the library is planned as
a document v3 Scroll** and none is planned as v1 or v2. None carries a `stageKit` or a `scrollV2` (a library test pins both). A document v3
has no kit: its pictures come from the closed set of six kinds (`statement`, `flow`, `cycle`, `grid`, `chart`, `plan`).

| Kit they had     | Recipes                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `earth-sky.v1`   | `seasons`, `seasons-hemispheres`, `seasons-limits`                                         |
| `starlight.v1`   | `stars-colour-brightness`, `exoplanet-habitable-zone`                                      |
| `black-hole.v1`  | `black-hole-formation`, `black-hole-horizon`, `black-hole-evidence`                        |

The other 33 (#790) are `seasons-elsewhere`, `tides-coasts` and `greenhouse-limits` (Earth & sky); `exoplanet-kinds` (Space); the three
immune-system recipes (Human body); the nine recipes of Computing; the twelve of Machine learning; and the five of History.
`docs/v2/operations/scroll-production.md` lists them by batch.

**Marking a recipe changes nothing a reader is served.** The recipe's current v1 or v2 revision keeps serving until a v3 revision
is produced, read and released; the release policy releases a v3 that replaces a served v1 or v2 when every check passes. Until
then the recipe's standing is `not_started` (its served Scroll is not a document v3), so `produce-library` offers its first take at
the v3 production version. Only an operator's `content produce-library` run makes the v3 revision: supply never commissions a
recipe the plan marks v2 or v3. The kit code stays until each kit is deleted, one kit at a time, after the owner has read that kit's
rewrites; `production/spike-v2/former-v2-plans.ts` keeps the kit and v2 plan each of these recipes had, for the v2 spike and the v2
writer's tests only.

### How a v3 plan is written

- `shape` is `argument`, `mechanism` or `story`. `sections` are two or three short lines, one intent for each section, in reading
  order. `pictures` are one to three, each a kind and what it is there to show; leave them out and the writer chooses by what its
  passages hold. `misconception` is copied from the recipe's v2 plan when it had one (only `seasons` has a myth, with its reviewed source; every
  other former v2 plan said `none`), else `none`: `exoplanet-kinds` never had a v2 plan, and its brief states no common wrong belief. A v3 plan has no landmark, no Final call control and no stage plan: those are v2's.
- **Check every picture against the passages the writer is offered, not against the whole page.** The tool
  `$KS_DEV_ROOT/tmp/step5/tools/offered-passages.mjs <recipe-key>... [--url <page>] [--find "<text>"]` prints them for a recipe from the cached
  pages, with the real `extractResearch` and `evidencePassages` of the built backend (build the worker and API first), and `--find` says which
  passage holds a sentence or a figure. A page gives the writer the paragraphs,
  list items and headings of 60 characters or more among its first 8,000 characters (`extractResearch`), cut into passages (`evidencePassages`).
  Figures in a table, an infobox or a figure caption are never passages, and a long page's later sections are not there. A figure
  the writer cannot cite is refused by the compile, so a picture that needs one is a failed take. Say what the picture shows in words the
  passages hold. Text inside a `<math>` element is not a passage either, so a formula or a notation such as O(n) is not offered.
- A chart carries only figures a passage states, in one unit, written the way the passage writes them (a figure written as "152.10×10^6 km"
  cannot be a bare value). A brief that asks for made-up or "illustrative" numbers is rewritten so a picture uses only stated figures, or a
  kind with no numbers (a flow, a cycle, a grid, a list statement). A chart's unit is made of words a passage uses, so a percentage is the
  unit `%` (the word "cent" is no passage's word). A statement picture never asks for a quotation: these pages quote no person,
  and a source's name never appears in a Scroll. A purpose never says "the page" or names a source.

## Landmarks and the Final call control

A `scrollV2` plan could also carry `landmark: {key, name}` and `finalCall: {kind: 'tilt'}` (D-187, D-188). Both were plan data that code
set into the document; the writer never wrote them. Every former v2 recipe named a landmark (D-199, D-217: short, plain and never a claim of
mastery), and `seasons`, the only one with the tilt, became a document v3 recipe in #787. A document v3 plan has neither field, and the
plan holds no v2 plan since #790, so **no recipe awards a landmark or hands the reader the tilt** until a landmark is designed for document
v3; the revisions already published keep theirs, and play awards nothing for a revision whose document has none. The landmarks live on in
`production/spike-v2/former-v2-plans.ts` with the rest of each former v2 plan.

## Rules for editing the plan

- A recipe's `assetId` and `explanationUnitId` never change once a Scroll exists. Only the original
  three recipes share an explanation identity with a Reel.
- Every planet needs at least three recipes covering at least two facets. Each recipe is a distinct
  explanation, not a rephrase of a sibling.
- A brief is two to four sentences: the angle, what to explain and what to avoid. It asks only for
  what its research pages say, because the writer may assert only what the supplied passages support. When a brief and its
  pages disagree, make them agree in this order: narrow the brief to what the pages state; only where the brief's central point has no
  support in any of its pages, add one public page of the kind the library already uses that states it (the passages are checked, see "How a v3 plan is
  written"); never invent a claim, and never ask for made-up or "illustrative" numbers (see `black-hole-formation`: the page says a star of
  about eight Suns or more ends in a supernova and one of about 20 or more leaves a black hole, so the brief says that and not "more than eight Suns leaves a black hole").
  It names no block type; `interactive` and `interactiveKind` carry that. Medical and similar topics
  say they are physiology or history, not advice.
- `supportingFacetId` is for a second angle the brief explicitly asks the closing section to cover.
- `blocks` and `guide` (on `scrollV2`, D-207; no recipe carries a `scrollV2` since #790) name the play blocks a Scroll has (`sort`, `fork`, `scale`, `chart`; each once, two at most) and the character that speaks its guide lines (`ray`). A person chooses them per recipe, only where the recipe's pages state what a block shows (an order, a series of figures), and no recipe names one until the spike `blocks-v20` has been read. `library.test.ts` keeps the lists in step with `scroll-model`.
- `stageKit` names the drawing kit that draws the recipe's subject, and only then, for a recipe produced as a v2 `stage` Scroll. No recipe
  names one since #787: the 22 recipes that did (`earth-sky.v1` the three Seasons recipes, `starlight.v1` two and `black-hole.v1` three, and fourteen whose kits `tides.v1`, `star.v1` and `transit.v1` (#799), `greenhouse.v1` and `circulation.v1` (#802) and `nerve.v1` (#809) are deleted)
  are document v3 recipes, which have no kit. The three kits that remain exist in `scroll-model` and are deleted one at a time, after the owner reads that kit's rewrites (the table above says which
  recipes each drew). Every other recipe stays plain: coasts, the audit of the blanket analogy (`greenhouse-limits`), kinds of planet
  (`exoplanet-kinds`), other worlds (`seasons-elsewhere`) and the three immune recipes. Adding a kit to a recipe is a person's decision, and
  `library.test.ts` pins that none has one. A brief stays free of the picture, because the v1 writer reads it too.
- Research pages must be allowlisted (`infrastructure/research/public-pages.ts`) and fetchable. The
  writer is offered the passages of all a recipe's pages together, at most 64 (it needs at least
  4), so name one long page or two short ones. Run `node scripts/check-library-sources.mjs` after
  changing a page.
- Every system has a `sceneFamily` and a planet may override it (`terraced.v1`, `ridged.v1` or
  `archipelago.v1`). The Scene projection draws from it, and a drawn object never changes family, so
  set it once when the system or planet is added. Earth's assignments are fixed by a test.
- A series order must come from the briefs: declare it only where one recipe builds on the one before
  it, and say why in a comment. A recipe is in at most one series, and is the source of at most one
  related move (the model holds one related slot per source revision). Related moves point to a
  different facet of the same planet, or to a planet the brief itself leans on; never to a series
  neighbour. Series ids and part order never change for Scrolls already admitted: a changed
  declaration becomes a new series revision.
- Adding a facet, planet or system, or editing a meaning, takes effect when `content catalogue sync` imports the plan as a new release
  (no deploy of the code that reads it; see "Library plan and concept catalogue" in `../../README.md`). Stored coverage stays readable
  across a release, because a binding pins its own facet's meaning and a release only changes the digest. Editing a meaning is a
  semantic change unless you declare it a rewording: put the old text in `sameMeaningAs` of the same node (`catalogue sync` checks it
  is the wording being replaced) and certificates decided against the old wording stay valid; leave it out and they are dropped from reads
  until `content readmit-coverage` decides them again (for the published Scrolls and for the Reels made from an approved script). A facet is added after the existing ones and never reordered: its place in the list is
  the site its region is drawn on. A node is never deleted from the plan to retire it: `sync` reports what the plan no longer names and
  retires nothing.

## Checking the pages

`scripts/check-library-sources.mjs` fetches every page through the product's fetcher and builds each
recipe's evidence passages, printing counts only. It needs `pnpm build` and network access.

Status: the plan is _implemented_. Every research page was last checked on 24 Oct 2026 (see the PR
that added the plan for the summary); pages change, so re-run the script before a generation batch.

## Follow a plan edit through its callers

`content catalogue sync` imports identities, labels and meanings from this plan as a release of the catalogue. Production chooses the
recipe; Scenes uses the node's visual family from the release; coverage admission pins exact facet meanings of the current release.
`content catalogue sync --dry-run` previews the import and `content readmit-coverage --dry-run` previews coverage decisions for published
Scroll and Reel revisions. It calls no provider but still needs an authorized disposable/operator database.
Changing a brief is not permission to rewrite an already admitted revision or paid request ID.

Run `pnpm --filter @knowscroll/backend exec vitest run src/modules/content/domain/library`
from the root. The recipe, continuity and serving fixtures check identities and relationships.
Use the [source checker](../../../../../../../scripts/README.md) when changing research pages;
its network results are different evidence from these authored fixtures.
