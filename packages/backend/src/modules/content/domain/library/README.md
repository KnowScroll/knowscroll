# Library plan

Code-owned data that says what KnowScroll holds Scrolls for. It lives in `domain/` because the
concept catalogue (`../concepts.ts`, `content-concepts.v1`) is derived from it and domain code may
import only domain code. It has no behaviour, no storage and no model call.

| Term               | Meaning                                                                                                                                                                                                                                     | Blueprint                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| **System**         | A broad domain, such as Machine learning. Parent of its planets.                                                                                                                                                                            | Topic system, organising star |
| **Planet** (topic) | An explored subtopic, such as Attention. Forms from at least three distinct qualified explanation units over at least two facets.                                                                                                           | §12                           |
| **Facet**          | A kind of angle on a planet (mechanism, example, limits...) written as a topic-specific id with a one-line meaning.                                                                                                                         | Region                        |
| **Recipe**         | One explanation unit the generator writes as a Scroll: a stable key, explanation unit, asset UUID, planet, facet (and optionally a supporting facet), a brief, one to three research pages, and whether it is interactive and of what kind. | §11                           |

## Files

- `plan.ts`: the shapes (`LibrarySystem`, `LibraryRecipe`, `INTERACTIVE_KINDS`, `STAGE_KIT_IDS`, `ScrollV2Plan`).
  A `LibrarySystem` also names its `sceneFamily` (the silhouette) and its `haze` (one of teal, cobalt,
  coral, amber, pink, violet; a different one for each system). Scenes gives both to a system once and never
  changes them, so edit them for new systems only (D-102).
- `earth.ts`, `space.ts`, `machine-learning.ts`, `human-body.ts`, `computing.ts`, `history.ts`: one
  system each, with its planets, facets and recipes. The record key of a recipe is the operator key
  (`content produce-scroll --topic <key>`).
- `continuity.ts`: which recipes form a series (ordered, 2 to 4 parts, one planet) and which are
  related perspectives, by recipe key. `content admit-continuity` admits them (D-059). `continuity.test.ts`
  checks them.
- `serving.ts`: pure rules over the plan: which recipes serve a catalogue brief, a recipe's standing from
  its takes, which take a send should name, and what a library run queues.
- `index.ts`: assembles the systems and the `RECIPES` record. `../../production/topics.ts` is a thin
  index over it.
- `library.test.ts`: the plan's acceptance rules (50 to 60 recipes, at least 22 interactive over all
  six kinds, at least three recipes and two facets per planet, a recipe for every facet, unique identities,
  allowlisted pages). `serving.test.ts` covers the serving rules.

## Recipes produced as v2 Scrolls

A recipe with `scrollV2` is written as a `scroll-document.v2` Scroll and held for an operator's read before anyone is
served it (D-129, D-138). Today the four Seasons recipes carry it (D-137): `seasons`, `seasons-hemispheres` and
`seasons-limits` with a picture (their `stageKit`), `seasons-elsewhere` without. Only `seasons` has a misconception, the
distance myth with its reviewed source; the other three have none because their pages do not document one. So do the
thirty-five recipes of Human body, Computing, Machine learning and History (D-199) and the fifteen kit
recipes of Earth & sky and Space (D-217): every one has
calls, no myth (no page of the recipe states a common wrong belief) and a landmark, and is a `plain` Scroll unless a kit draws
it: the six heart and nerve recipes (D-201) and the thirteen Earth & sky and Space recipes a kit draws (D-217) are `stage` Scrolls. `exoplanet-kinds` is the one recipe not marked. A series is marked whole or not at all,
so `admit-continuity` can admit it whole. Marking a recipe is a person's decision, one recipe at a time or one wave at a time,
with its own decision entry; `library.test.ts` pins the list. A v2 recipe is also the only kind `content regenerate` can
make again (D-197), and the answer check runs on its calls (D-198).

## Landmarks and the Final call control

A recipe with `scrollV2` may also carry `landmark: {key, name}` and `finalCall: {kind: 'tilt'}` (D-187, D-188). Both are
plan data that code sets into the document; the writer never writes them (it is only told what a bound Final call is
for). The four Seasons recipes name a landmark (`The Leaning Axis`, `The Turning Halves`, `The Near January`, `The
Sideways Giant`: the first is the design's, the other three are authored and want a person's confirmation) and only
`seasons` hands the reader the tilt. The thirty-five wave recipes and the fifteen kit recipes name one each (D-199, D-217: short, plain and never a claim of mastery; authored, and a person
should confirm them). Every other recipe awards no landmark until it is marked, and that is safe: play
awards nothing for a revision whose document has none. Keys are unique and fit the document's id shape, and
`library.test.ts` pins which recipes name one. Changing either field changes what the next revision carries; stored
revisions keep what they were published with.

## Rules for editing the plan

- A recipe's `assetId` and `explanationUnitId` never change once a Scroll exists. Only the original
  three recipes share an explanation identity with a Reel.
- Every planet needs at least three recipes covering at least two facets. Each recipe is a distinct
  explanation, not a rephrase of a sibling.
- A brief is two to four sentences: the angle, what to explain and what to avoid. It asks only for
  what its research pages say, because the writer may assert only what the supplied passages support.
  It names no block type; `interactive` and `interactiveKind` carry that. Medical and similar topics
  say they are physiology or history, not advice.
- `supportingFacetId` is for a second angle the brief explicitly asks the closing section to cover.
- `blocks` and `guide` (on `scrollV2`, D-207) name the play blocks a Scroll has (`sort`, `fork`, `scale`, `chart`; each once, two at most) and the character that speaks its guide lines (`ray`). A person chooses them per recipe, only where the recipe's pages state what a block shows (an order, a series of figures), and no recipe names one until the spike `blocks-v20` has been read. `library.test.ts` keeps the lists in step with `scroll-model`.
- `stageKit` names the drawing kit that draws the recipe's subject, and only then. A recipe with a kit gets a pinned picture when the v2 writer produces it; every other recipe is a plain Scroll with calls and no picture (D-125). Nine kits exist (D-125, D-194, D-201, D-204): `earth-sky.v1` draws the three Seasons recipes, `tides.v1` draws `tides` and `tides-spring-neap`, `greenhouse.v1` `greenhouse`, `greenhouse-radiation` and `greenhouse-balance`, `star.v1` `stars-fusion` and `stars-lifecycle`, `transit.v1` `exoplanet-transit`, `circulation.v1` `cardiac-cycle`, `blood-pressure` and `oxygen-transport`, `nerve.v1` `action-potential`, `synapse-signalling` and `reflex-arc`, `starlight.v1` `stars-colour-brightness` and `exoplanet-habitable-zone`, and `black-hole.v1` the three black-hole recipes. Each entry carries a note saying why the kit draws its subject. Every other recipe stays plain until a kit draws it: coasts, the audit of the blanket analogy (`greenhouse-limits`), kinds of planet (`exoplanet-kinds`) and other worlds (`seasons-elsewhere`), and the three immune recipes. Naming a kit is not marking the recipe `scrollV2`, but every recipe that has a kit is marked now (D-199, D-201, D-217). Adding a kit to a recipe is a person's decision, and `library.test.ts` pins the list. A brief stays free of the picture, because the v1 writer reads it too.
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
- Adding or renaming a facet, planet or system changes the catalogue digest. See "Library plan and
  concept catalogue" in `../../README.md`. Stored coverage stays readable; run `content readmit-coverage`
  afterwards to decide it again for the published Scrolls.

## Checking the pages

`scripts/check-library-sources.mjs` fetches every page through the product's fetcher and builds each
recipe's evidence passages, printing counts only. It needs `pnpm build` and network access.

Status: the plan is _implemented_. Every research page was last checked on 24 Oct 2026 (see the PR
that added the plan for the summary); pages change, so re-run the script before a generation batch.
