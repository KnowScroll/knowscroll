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

- `plan.ts`: the shapes (`LibrarySystem`, `LibraryRecipe`, `INTERACTIVE_KINDS`, `STAGE_KIT_IDS`).
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
- `stageKit` names the drawing kit that draws the recipe's subject, and only then. A recipe with a kit gets a pinned picture when the v2 writer produces it; every other recipe is a plain Scroll with calls and no picture (D-125). Today the Earth & sky kit (`earth-sky.v1`) draws the four Seasons recipes and nothing else: tides, stars, exoplanets and the greenhouse recipes stay plain until a kit exists for them. Adding a kit to a recipe is a person's decision, and `library.test.ts` pins the list. A recipe about another world may use the Earth kit only as a comparison (`seasons-elsewhere`); the v2 writer prompt says so, and the brief stays free of the picture because the v1 writer reads it too.
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
