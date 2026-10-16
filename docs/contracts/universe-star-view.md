# Universe star view — how a client draws the reader's places as stars

Status: **accepted for the web build** with [ADR-0049](../decisions/0049-stars-are-topics-worlds-form-from-their-material.md)
(2026-10-16). Implemented for the web Universe in `apps/web/src/cosmos/starView.ts`; Android still
draws places as planets and should adopt this before both clients ship together. This is a
presentation contract over the existing `GET /v1/atlas` response (`packages/contracts/src/atlas.ts`,
web form `webAtlasResponseSchema`). It adds no endpoint, no field and no persisted state.

## Input

One Atlas response: `places` (live only: `planet`, `region`, `sighting`), `relations` between live
places, `chronicle` (latest ≤ 20 deltas). Nothing else is read: not attention decay, not time away,
not watch time, not exposure counts.

## Objects

| Object | Derived from | Rule |
|---|---|---|
| **Star** | a place with `kind = 'planet'` and `parentPlaceId = null` | one per such place |
| **Root of a place** | follow `parentPlaceId` to a top-level `planet` | a place whose chain breaks (unknown parent, cycle) belongs to no star |
| **Facet world** | a live `region` whose root is the star | `depth` = parent hops (1 or 2); relation text names the parent |
| **Question world** | each room in `rooms[]` of the star or of a facet world | id `room:<roomId>`; carries the reader's question, state and inhabitant positions |
| **Possibility** | a live `sighting` whose root is the star | kind of possibility from `basis.kind` (table below) |
| **Connection** | a relation with at least one end in the star's system | a claim and a bridge for the same `(from, to, kind)` are **one** connection; the claim is preferred as its support |
| **Constellation** | relations whose ends belong to two different stars | one line per star pair; `tension` if any of them is `contradicts` |

Possibility phrases: `contradicts` → "a reading in tension with X"; `analogous_in` → "another way
of seeing X"; `applies_to` → "where X is used"; `explains` → "explains part of X";
`prerequisite_for` → "comes before X"; `compares_mechanism` → "a comparison with X".

## Condition (exactly one per star)

Evaluated in this order; the first that holds is the drawn condition.

1. `luminous` — the star's own `foundation` is not null (ADR-0037).
2. `tense` — a `contradicts` relation touches the star's system, or one of its question worlds is
   `arguing`.
3. `stirring` — it has at least one world (facet or question) or one connection.
4. `quiet` — none of the above.

A star never changes condition because of time or absence. `attention.state` (including
`dormant`) is not an input. A reason list is built from the same facts, in this order: luminous
(what it holds up), each tension, each facet world, each question world, each non-tension
connection, the count of possibilities, and for `quiet` the line "Quiet: nothing inside it has unfolded yet. It holds its possibilities as
they are." No copy mentions time away, idle days or what the reader missed.

Captions under a star name are words about real things ("1 world · 2 questions · 3
possibilities"), never levels, percentages or progress.

## Transformations (what a client may animate once)

| Chronicle `kind` | Transformation | Star |
|---|---|---|
| `place_formed`, top-level place | `star_ignited` | that place |
| `place_formed`, region | `world_formed` | its root |
| `foundation_recognised` | `luminous` | its root |
| `sighting_appeared` | `possibility` | its root |
| any other kind | `quiet_change` (no celebration) | its root, if live |
| a room (from `rooms[].openedAt`) | `question_world` | the root of the room's place |

Each has a stable id (`deltaId`, or `room:<roomId>`). A client may remember locally which ids it
already drew; that memory is display state, never evidence, and is not sent anywhere. Entries
whose place is no longer live are kept as text in the chronicle and are not drawn on a star.

## Ordering and layout

Stars are ordered for layout only: luminous, tense, stirring, quiet; then more worlds; then
earlier `formedAt`; then `placeId`. The first takes the centre. The order is never shown as a rank.

## Reading from a star or world

`GET /v1/feed?place=<placeId>` scopes composition to the place and its live regions (see
[bootstrap HTTP: Feed scope](bootstrap-http.md)). A question world reads from the place its room is
on. The decision records the scope; exposure, Keep and "why" are unchanged.

## Verification

`apps/web/test/unit/starView.test.ts` pins each rule above, including "a dormant-attention star
with no worlds is quiet, and one with worlds is not dimmed".
