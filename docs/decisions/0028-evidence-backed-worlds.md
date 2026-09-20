# ADR-0028 — Evidence-backed semantic worlds: a world is a shared source, a system is what one reader has actually reached

Date: 2026-09-21. Status: contract migration 0017 landed; the consumer described as future work
below (`packages/db/src/worlds.ts`, `GET /v1/worlds`, the `POST /v1/exposures` projection hook) is
now implemented under #113 — see the updated Consequences section. Not yet reviewed/accepted by
the coordinator. Under #6 (part of #10) / #113.
Builds on [ADR-0004](0004-ledger-events-derived.md) (canonical history, derived state, exposure
lineage) and the asset shape [ADR-0025](0025-eligible-reels-in-inventory.md) generalised. Cites
[docs/product/definition.md](../product/definition.md) §3 (laws 1, 4, 5, 6) and §4 (the cosmic
grammar's World/Planet object) and §19 (canonical vocabulary: "World: a domain instance inside
[the] universe").

## Context

The product's cosmic grammar promises a universe that grows worlds the person did not author —
law 1 forbids configuring or arranging them, and law 6 requires every visible change to map to a
typed semantic change with lineage, never decoration. Nothing in the codebase yet defines what a
world *is* in this database. Inventing one now with no real geography to derive it from would
mean asserting worlds by hand, which is exactly law 1's violation and exactly what law 4 (behavior
is evidence, never proof) and this repository's own rule against fabricated world evolution rule
out.

Real evidence already exists, though. Migration 0001 gives every `asset` row a `source_title` and
`source_url` (`asset.source_title`/`asset.source_url`, both `NOT NULL`, and non-empty for every
Scroll by the kind-shape constraint added in migration 0015). The current editorial library's
seeded Scrolls fall across exactly two distinct sources: NASA's orbits/Kepler page and NASA's
stars page (`content/editorial-scrolls.json`; the owner's fuller library is reported at fourteen
Scrolls across the same two sources in `docs/CHECKPOINT.md`). Migration 0002 gives every
`exposure` row a `universe_id`, so "has this reader's universe actually been shown this asset" is
already a recorded fact, joined one step from the causing `ledger` event via `exposure.event_id`.

That is enough to derive a world honestly: **a world is the set of assets that share one recorded
source.** No topic model, no embedding, no LLM judgment call — a fact already sitting in the
`asset` table, grouped. And **a system is the set of worlds one universe's reader has actually
encountered** — read directly off that universe's own `exposure` rows, not asserted. Both are
falsifiable: recompute them from the same two tables and get the same answer, or the derivation is
wrong.

This ADR is a contract, not an implementation. It defines the shape and the invariants the
database itself enforces. No selection policy, no feed field, no mobile/web consumer, and no
second derivation method are built here.

## Decision

### 1. A world is derived, keyed by its evidence, and can only ever be recomputed, not asserted

`world_derivation_method` names a versioned computation the way `publication_policy`
(ADR-0024) names a versioned gate set: a short method key plus a description of exactly what it
computes and from which rows. This migration seeds exactly one: `shared_source_v1` — a world is
the set of `asset` rows carrying one identical `(source_title, source_url)` pair.

`world` carries the method it came from, the `(source_title, source_url)` pair that *is* its
evidence key, and a `scroll_count`. `UNIQUE (derivation_method, source_url)` means re-running the
derivation for the same evidence finds the existing world by that key instead of duplicating it —
this is what "deterministic and re-runnable" means concretely: the natural key, not a fresh
`gen_random_uuid()` per run, is the thing that makes recomputation idempotent.

`world_member(world_id, asset_id)` is the traceable link: a world names the exact asset rows that
justify it, not a count asserted in isolation. A `BEFORE INSERT` guard refuses a member whose
asset's own `(source_title, source_url)` does not match its world's — membership can never claim a
link the evidence itself does not show. `scroll_count` is guarded the same way: a `BEFORE
INSERT OR UPDATE` trigger recomputes the live count of Scroll-kind `world_member` rows and refuses
any other value, so "the count of Scrolls behind it" is a number the database itself verifies, not
one an application merely asserts. A world's identity (method, source) is immutable; a changed
source is a different world under this method, found or created fresh by the unique key, never an
edit in place.

**The database refuses a world that names no evidence.** A deferred constraint trigger checks, at
the end of the transaction, that every `world` row has at least one `world_member` row. It is
deferred because the ordinary way to create a world inserts the world row and its members in the
same transaction — `world_member`'s foreign key requires the world to exist first — so the check
has to wait for the transaction to finish assembling both. The same trigger fires again if a
member is later deleted, so a recompute cannot quietly strand an evidence-less world behind.

### 2. A system groups the worlds one universe's reader has actually encountered

`world_system(id, universe_id, derivation_method)` is the per-universe counterpart: `UNIQUE
(universe_id, derivation_method)` gives the same idempotent-recompute property one level up.
`world_system_member(system_id, world_id, seen_count)` is where "how many the reader has actually
seen" lives, and it is guarded, not asserted: a `BEFORE INSERT OR UPDATE` trigger recomputes
`seen_count` as the count of that world's Scroll-kind assets with an `exposure` row for that
system's own `universe_id`, and refuses any other value. `exposure.event_id` is a `ledger` row, so
this is one join away from the causing event — the same lineage ADR-0004 already requires, read
rather than restated.

`seen_count >= 1` is a column `CHECK`, which is the literal database expression of "a system is
the worlds a reader has actually encountered": a world with zero exposures in this universe is not
a member with a zero shown on it, it is simply absent. The same deferred-constraint pattern as
worlds applies one level up: **the database refuses a system that groups no world.**

### 3. What this does not do

No feed field, no selection or ranking signal, no UI, no mobile or web consumer, no second
derivation method, and no amendment to the product definition's cosmic grammar table (§4) — this
introduces a database-level grouping an interface may *present* as a system/solar system; formally
naming it in product vocabulary, if it is adopted past this contract, is separate future work. No
Reel is a world member under `shared_source_v1` today: a Reel asset's `source_title`/`source_url`
are not required to be populated by the kind-shape constraint, so in practice only Scrolls carry
this evidence; a future Reel that does carry real source lineage would become eligible for
membership without any migration change, because the guard checks the asset row's actual values,
not its kind.

## Alternatives and why

- *Compute worlds on the fly with an application-side GROUP BY, no tables at all:* keeps the
  derivation honest but gives the database nothing to enforce, so "the count of Scrolls behind it"
  and "how many the reader has seen" become whatever a query happens to compute correctly today —
  no refusal of a wrong value, no place to record which method produced which row, and no way for
  a later derivation to layer in without every caller changing its query. Rejected.
- *An LLM-assigned topic/cluster per asset:* the obvious "smarter" alternative, and exactly what
  law 1 and law 4 forbid doing silently — a model's opinion about topical relatedness is not
  recorded evidence, and asserting it as a world exceeds the current evidence entirely. Left for a
  later, explicitly-named `world_derivation_method` that this schema already has room for.
- *Store `scroll_count`/`seen_count` as plain columns with no guard, trusting the writer:* matches
  the letter of "record the count" but not "so the interface can say something true" — a wrong
  count would sit undetected. Rejected in favor of triggers that recompute and refuse.
- *One `world` row per universe (universe-scoped worlds):* the evidence a world is built from —
  `asset.source_title`/`source_url` — is not universe-scoped; duplicating the same source-derived
  world once per universe would multiply identical catalog rows for no reason. Scoping only the
  reader-specific half (`world_system`) to `universe_id` keeps the shared catalog shared, matching
  how `generated_reel` and its lineage are already universe-independent (ADR-0023).
- *Cascade-delete an evidence-less world instead of refusing it:* silently deleting a world when
  its last member is removed would hide a data-loss bug behind a name disappearing; refusing the
  transaction surfaces it instead.

## Consequences

With the current editorial library, one recompute against `shared_source_v1` produces exactly two
worlds — NASA orbits/Kepler and NASA stars — matching the owner's expectation of "two planets."
Once a single universe's reader has been exposed to at least one Scroll from each, that universe's
`world_system` gains both as members, matching "one solar system." No existing table, trigger, or
index changes; `asset`, `exposure`, and `ledger` are read-only inputs to this contract.

**Update (#113): the consumer this section originally deferred now exists.**
`packages/db/src/worlds.ts` implements `deriveWorlds` (recomputes the shared `world` catalog from
`asset` alone) and `deriveWorldSystemForUniverse` (recomputes one universe's `world_system` from
its own `exposure` rows); both are idempotent by the same evidence-key lookup this ADR describes,
proven by `tests/worlds.test.ts` calling each twice and asserting no new rows and identical output.
`POST /v1/exposures` (`apps/api/src/app.ts`) calls both, in the same transaction and under the same
universe lock `authenticateAndLock` already holds, immediately after recording the new exposure —
this is the "projection that keeps them current as a reader encounters more" from #113's brief, not
a separate async job. `GET /v1/worlds` (documented in `docs/contracts/bootstrap-http.md`) is a pure
read of the already-projected state, never a recompute-on-read. Verified against the real seeded
editorial library and real disposable PostgreSQL: a universe with no exposures derives no system
(never an empty one); one exposed source derives one world; two derive two worlds in one system;
re-running the derivation directly (outside any HTTP call) inserts no additional rows; the database
itself refuses (at commit) a world or system named with no evidence, a world_member deletion that
would strand its world, and a world_member whose asset does not actually carry its world's source;
every count returned by the API is checked against an independent direct-SQL count over
`asset`/`exposure` in the same test. Full suite (`pnpm test`, 669/669) and `pnpm typecheck` pass
with this consumer wired in.

**What remains unproved:** no mobile or web UI reads `GET /v1/worlds` yet — this ADR update ships
the derivation, the projection and the API only, exactly as #113 scoped it, not a rendered universe
view. `packages/db/src/privacy.ts`'s `clearScrollHistory` deletes a universe's `exposure` rows but
does not touch `world_system`/`world_system_member`; after a history clear, that universe's
existing system rows go stale (they keep reporting worlds/seen-counts derived from now-erased
exposures) until something re-runs `deriveWorldSystemForUniverse` for it, which nothing currently
does automatically. This is a real gap at the intersection of ADR-0028 and ADR-0010, deliberately
left alone here rather than modified unilaterally, since privacy-lifecycle scope and retry contract
belong to whichever lane owns ADR-0010 (tracked as #4 elsewhere in this delivery). No coordinator
review of this consumer has happened yet.

## Sources / verification

`packages/db/migrations/0017_evidence_backed_worlds.sql`. Evidence for "two sources today":
`content/editorial-scrolls.json` (three seeded Scrolls, two distinct `sourceUrl` values) and
`docs/CHECKPOINT.md`'s report of fourteen owner-side Scrolls across the same two NASA sources.
`pnpm typecheck` and `pnpm test` run against a disposable `knowscroll_test_*` database; results
recorded in the delivering commit/PR, not fabricated here.
