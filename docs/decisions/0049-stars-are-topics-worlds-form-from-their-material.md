# ADR-0049 — Stars are topics; worlds form from their material

Date: 2026-10-16. Status: **proposed** under the owner's cosmic-origin direction (2026-10-16, [#220](https://github.com/KnowScroll/knowscroll/issues/220)), for
owner review. The presentation rules in §3–§5 are implemented in the web Universe on branch
`claude/220-cosmic-origin` and read only existing state; nothing in §6 is implemented. Amends the
cosmic grammar in [definition §4](../product/definition.md#4-the-cosmic-grammar) and the renderer
wording in [ADR-0037](0037-foundation-stars.md) §3; leaves [ADR-0036](0036-reader-places-cartographer.md)'s
data, deltas and thresholds unchanged.

## Context

The owner's new direction tells the product's story as the formation of the physical universe:
emptiness, expansion, gathering clouds, first stars, a star's transformation, released material,
new stars and planetary worlds. In the personal universe a **star is a topic** with personal
relevance. A **quiet star** holds possibilities that have not unfolded. Encounters, questions and
connections give it internal structure and tension. A meaningful transformation can release
material that gathers into **new worlds**: perspectives, questions and other ways of understanding
the topic. Different perspectives coexist; none is the final model.

That differs from the current semantics in four ways:

| | Current (definition §4, ADR-0036/0037) | Owner direction |
|---|---|---|
| Star | a foundational concept that illuminates many regions; in data, the `load_bearing` property of a place, "no separate star object" | a topic with personal relevance and developing ideas |
| Planet / World | a substantial domain; in data, a top-level `atlas_place` of kind `planet` | a distinct world of exploration inside a topic: a perspective, a related question, another way of understanding it |
| Supernova | a rare transformation that reorganises understanding | a transformation that releases material; not every star explodes, and an explosion never instantly produces finished worlds |
| Dormant | an attention-account state (`attention-v1`): an anchored-shaped history whose mass faded after 30 idle days; target 07 lets it archive a place | a quiet topic holding possibilities — never a consequence of absence |

Keeping the old words while drawing the new picture would silently retain an incompatible
metaphor (law 6: the visual language is the product's model language). So the mapping is decided
here, explicitly, before any surface uses it.

## Decision

### 1. Vocabulary (presentation and product documents)

- **Star** — a topic the reader's own acts made personally relevant. In data: a live top-level
  place (`atlas_place.kind = 'planet'`). The storage name stays `planet`; no migration, no API
  rename. Product copy, the web Universe and future clients call it a star.
- **World** (planet in the drawing) — a distinct place of exploration that formed inside a star's
  system. Today two kinds exist in data:
  - **facet world** — a live `region` whose parent is the star (ADR-0036): a narrower part of the
    topic the reader's acts anchored. Its relationship to the star is the substrate hierarchy
    ("part of Gravity").
  - **question world** — a live Idea Room on the star or on one of its facets (ADR-0045): a
    question the reader carried on two days, with inhabitants holding sourced positions. Several
    positions are shown together; none is marked as the answer.
  A third kind, the **perspective world**, is proposed in §6 and not implemented.
- **Possibility** (latent material) — a live `sighting` at the edge of the star or its worlds: a
  concept one typed relation away that the reader has not met. The relation kind says what kind of
  possibility it is (`contradicts` → a reading in tension; `analogous_in` → another way of seeing;
  `applies_to` → where it is used; `explains`/`prerequisite_for` → what lies underneath;
  `compares_mechanism` → a comparison).
- **Luminous star** — a star that holds other places up: ADR-0037's foundation, unchanged in data
  and evidence. The founding meaning of "Star" (an explanatory foundation) survives as this
  property, drawn as light that reaches the places it holds up. It is never earned by attention.
- **Constellation line** — a typed relation between two live places, with its claim or bridge.
- **Kept light** — a saved Trace. A Trace is a mark of passage, not a world; it is no longer drawn
  as a planet.

### 2. A star's condition is derived, explainable and never a score

Every star shows one condition, computed deterministically from the Atlas response
(`apps/web/src/cosmos/starView.ts`, [contract](../contracts/universe-star-view.md)). Each
condition lists the recorded facts that produced it; the Universe shows those facts as the star's
"why it looks like this", next to the Atlas chronicle lines that touch it.

| Condition | Derived when | Drawn as |
|---|---|---|
| `quiet` | no facet world, no question world, no tension | a calm star with its possibilities as faint motes in its halo |
| `stirring` | at least one facet or question world, or a constellation line | visible surface structure, one cell per world |
| `tense` | a `contradicts` relation touches the star or one of its worlds, or one of its rooms is `arguing` | an asymmetric corona: two readings pull against each other |
| `luminous` | the star carries a foundation (ADR-0037) | a released shell of material and light reaching the places it holds up |

`luminous` takes precedence for the drawing; `tense` remains listed as a reason. Counts appear only
as words about real things ("2 worlds · 3 possibilities"), never as a level, percentage, streak or
progress bar.

### 3. Quiet is not dormant

A star is **never dimmed, shrunk, archived or moved because the reader was away**. `attention-v1`'s
`dormant` state stays a routing hint for the Composer and Cartographer and is not rendered. Copy
never mentions time away, idle days or what the reader "missed". Leaving is allowed (law 16).
Target design 07's `dormant → archived` transition is not adopted for any visible surface by this
ADR; if archiving is ever accepted it needs its own decision and must be framed as rest that one
voluntary act reverses, not decay.

### 4. Transformations come only from recorded, typed deltas

A transformation is drawn once per recorded change and only for these kinds (the renderer stores
which delta ids this browser has already played; that is a per-viewer display memory, not
evidence):

| Recorded change | Drawn as | Copy comes from |
|---|---|---|
| `place_formed` for a `region` (including a promoted sighting) | a possibility condenses into a facet world in the star's disk | the Atlas chronicle line |
| `place_formed` for a top-level place | a new star ignites in the reader's sky | the Atlas chronicle line |
| a room `openedAt` newer than this browser's last view | a question world forms | the room's question, in the reader's words |
| `foundation_recognised` | the star releases a shell of material; its light reaches the places it holds up | the chronicle line ("Gravity holds up Orbit, Star formation and Tides.") |
| `sighting_appeared` | a new possibility mote brightens at the star's edge | the chronicle line |
| `foundation_withdrawn`, `place_rejected`, `place_released`, `sighting_retired` | the drawing changes quietly, without a celebration | the chronicle line |

A browser's first sight of a universe's sky draws none of these: it cannot know which are recent,
so it records them all as already drawn and shows the newest line as a quiet caption.

Nothing is triggered by watch time, a view count, an exposure count, a streak or a date. The
underlying deltas already exclude those: anchoring needs ≥3 episodes on ≥2 days with ≥2 voluntary
acts from ≥2 source families (`attention-v1`), and a foundation needs three sourced connections
across two other places (ADR-0037). Viewing alone cannot make or transform a star, and no drawing
claims the reader's belief changed.

### 5. The origin opening establishes possibility, not ownership

The cinematic opening tells the physical story. Its last frame is the reader's actual Universe. A
new reader's universe is shown as it is: unformed — a gathering cloud, with the first real
discovery in reach — and no star is drawn that the Atlas does not contain. Returning readers (this
browser completed or skipped the opening, or the universe already has kept Traces or places) go
directly to their Universe; the opening can be replayed from there.

### 6. Proposed, not implemented: perspective worlds

The owner's "transformation releases material that becomes different perspectives" needs a typed
change the Cartographer does not yet make. Proposal for a later Cartographer version, shown only in
the isolated preview (`/origin-preview.html`, labelled as a preview):

- `world_released` (causal class `personal_exploration` or `substrate_neighbourhood`) creates a
  **perspective world** under a star when **all** hold: the star is `stirring` or `luminous`; the
  reader voluntarily acted on an encounter whose claim `contradicts` or `qualifies` a claim they
  kept on that star (an Ask, objection or branch — not a view); and a sourced alternative
  (`contradicts`, `analogous_in` or `compares_mechanism`) exists for it in the substrate.
- The new world names the alternative, the claim it bears on and the acts that opened it. It sits
  beside the original reading; it never replaces it or marks either as correct.
- Persistence and rate limits follow target 07 §3 step 7 (one major change per subtree per day).

Acceptance would need its own migration, contract and journey. Until then no surface may imply a
perspective world exists.

## Alternatives and why

- **Keep "Star = foundation" and draw topics as planets (status quo).** Contradicts the owner's
  story: the opening would show stars giving birth to worlds and the product would show topics as
  planets with no star to come from. Rejected; the foundation meaning survives as the luminous
  property.
- **Rename the stored kind `planet` → `star`.** Cosmetic churn across migrations, contracts,
  Android and exports for no change in meaning. Rejected; presentation names are decided here.
- **Make `dormant` attention the quiet star.** It would turn absence into a visible state, exactly
  the pressure law 16 forbids. Rejected.
- **Play a transformation when a reader keeps N Scrolls on a topic.** Equates attention with
  understanding. Rejected; only typed deltas transform.

## Consequences

- Definition §4's table and §19 vocabulary carry a dated amendment pointing here; ADR-0037 §3's
  "renderer may express it as brightness or pull lines" becomes the luminous drawing.
- The web Universe reads `GET /v1/atlas` alongside `GET /v1/universe` (read-only, under the same
  privacy-epoch checks as the Atlas screen). An Atlas failure leaves the Universe usable and says
  the stars are unavailable.
- Android still draws places as planets; it should adopt the same derivation from the contract
  before the two clients ship together (law 14: one product).
- Saved Traces move from planet bodies to kept lights; Keep stays the list.

### Feed scope (implemented on this branch)

[Definition §8.2](../product/definition.md#82-world) promises "world-specific Cable and Scroll
streams"; this is the server half.

- `GET /v1/feed?place=<placeId>` asks from a star (live `planet`) or a facet world (live `region`)
  of the caller's own universe. Its candidates are the encounters that belong to that place or to a
  live region beneath it, at any depth, by `placeMembership` (`packages/db/src/atlas/membership.ts`),
  the one rule the Atlas's `scrolls` counts also use: the live sighting an encounter's primary
  concept is, else the nearest live planet or region on that concept's ancestor chain. A star's
  candidates are therefore exactly its own and its worlds' counted Scrolls. A Scroll about one of
  its possibilities belongs to that sighting and is not offered from the star; a separate star
  deeper in the substrate keeps its own. A Reel belongs where its Scroll does (ADR-0043) and is a
  candidate only when `kinds` asks for Reels.
- The same Composer decides over that list, so decision, exposure, Keep, why and corrections are
  unchanged. A place with nothing left answers `items: []`; nothing from elsewhere fills it.
- Recorded: `decision.scope_place_id` (migration 0045, numbered after the 0042–0044 that dev and
  stage already carry). The schema accepts only a live planet or region of the decision's own
  universe at insert, keeps the reference for the decision's life (deferred foreign key) and refuses
  a changed scope. It is private history with its decision: Clear, Reset and account deletion erase
  it, export carries it.
- A scoped decision observes exhaustion (ADR-0046 §1) only for the place asked from and the regions
  beneath it; it never records that another place was seen in full.
- Refusals: a malformed, empty or repeated `place` is 400; a sighting, a place set aside, another
  universe's place or an unknown id is 404.
- Not implemented: a question world (Idea Room) has no scope of its own (a client asking from one
  passes the place its room is on); a sighting cannot be asked from; the scope is not a ranking
  term and the why sheet does not mention it; Android does not call it yet. The web reader calls it
  from a star, a world or a question world's place ("Read from …"); a 404 (the place was set aside
  meanwhile) ends that reading trip on the Universe with a note instead of retrying.

## Sources / verification

`packages/contracts/src/atlas.ts` (web Atlas response), `packages/core/src/semantic/attention.ts`
(`attention-v1` thresholds), `packages/contracts/src/rooms.ts` (room summary), ADR-0036, ADR-0037,
ADR-0045, `docs/architecture/target/07-UNIVERSE-EVOLUTION.md`. Unit tests for the derivation:
`apps/web/test/unit/starView.test.ts`.
