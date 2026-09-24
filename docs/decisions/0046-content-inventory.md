# ADR-0046 — Inventory v1: demand from real reading, the Quartermaster's decisions, and corrections that reach the reader

Date: 2026-09-24. Status: accepted by the coordinator for [#164](https://github.com/KnowScroll/knowscroll/issues/164)
(parent #134, component epic #8). Builds on ADR-0023/0025 (generated Reel supply and inventory),
ADR-0031 (claims and their support), ADR-0032 (the v3 Composer), ADR-0036 (places), ADR-0039 (the
return), ADR-0040 (correction refresh) and ADR-0041 (model-written Scrolls). Target design:
`docs/architecture/target/23-CONTENT-DEMAND-AND-INVENTORY.md`, at bench values. Cutroom generation
itself stays deferred (#9).

## Context

The v3 Composer falls back honestly when a reader has been shown everything the library holds about
what they are reading (family `fallback`), and a continuation whose target has nothing unseen simply
is not offered. Nothing records that need, so nothing can meet it. ADR-0041 gives KnowScroll a way to
produce new sourced Scrolls: a model writes one from fetched public material and deterministic checks
decide whether it is admitted. The two are not connected, and a correction that withdraws what a new
Scroll rests on does not reach the reader who was waiting for it.

## Decision

1. **Demand is a need with an owner and a cause** (target §2). `content_demand` (universe, epoch,
   concept, modality `scroll`, status `open → waiting → bound | cannot_meet | cancelled`, the
   Quartermaster's decision and reason) is written in the transaction that observed the need:
   - `exhaustion`: a v3 feed decision for a reader with a live planet or region whose anchor subtree
     has no eligible Scroll this reader has not been shown (evidence: decision id, place id, seen/total);
   - `branch_gap`: a continuation the reader opened, or was offered, whose target concept has nothing
     unseen (evidence: bridge id and the origin exposure).
   One open demand per (universe, epoch, concept, modality); a later cause joins it (bounded). Nothing
   is recorded while paused. Demand never carries the reader's words: its public face is a concept code.
2. **The Quartermaster decides, deterministically** (`packages/core/src/inventory/quartermaster.ts`,
   `quartermaster-v1`), when a demand is written, when supply changes (a Scroll admitted or withdrawn, a
   supply request settled) and in the correction catch-up pass (ADR-0040):
   - **reuse**: an eligible Scroll exists in the concept's subtree that this reader has never been
     shown (for example one just written) → a private **binding**; the Composer serves bound Scrolls
     first on that place, family `continue`, reason `v3_demand_bound`, and records the binding in its
     decision evidence;
   - **join**: a shared `supply_request` for the same concept is already open → a **waiter** on it;
   - **fund**: no supply, no open request, an enabled writing route with budget left, and at least
     one unwritten material candidate for the concept → a new shared `supply_request` and a waiter.
     The request carries the concept code, modality, the rights policy (`material-hosts-v1`) and the
     chosen candidate; never anything from the reader's universe (target §2, §7);
   - **cannot_meet**, with a reason: no route, budget spent, no allowlisted material for the concept,
     or the request failed its checks twice. The reason is shown; nothing is fabricated.
   **Adapt** has no v1 path (no Scroll derivation, no Reel generation: #9) and is recorded as such.
   The worker never funds while the reader's universe is paused, and a route with no budget left makes
   every new decision `cannot_meet` (`no_budget`), never a silent wait.
3. **Supply is shared; bindings are private** (target §7). Two operator-installed tables feed it:
   `scroll_writing_route` (like ADR-0038's route: transport `fixture` or `minimax`, model, a request cap
   kept as a route bucket so admission, not goodwill, stops it, enabled) and
   `scroll_material_candidate` (an allowlisted URL and the concept codes it may be written for, the
   same shape as ADR-0041's plan file). A `supply_request` is fulfilled by the worker's writing loop
   calling ADR-0041's fetch/write/check/admit functions (`apps/worker/src/scrolls/write-scroll.ts`)
   with the route's transport and a `beforeSend` gate that takes the route bucket and, for `minimax`,
   runs the quota preflight; it is sent once and never retried. It admits at most one Scroll whose
   primary concept is in the request's subtree; its provenance (material snapshot and hash, request
   hash, writer model, checks version) is ADR-0041's. A refused Scroll settles the request as
   `refused` with the checks' reason codes, and the Quartermaster may fund the next candidate once. Each waiter then gets its own fresh reuse check before its
   binding is written. Cancelling one waiter (pause, Clear, Reset, deletion) never cancels another
   universe's waiter or the shared request.
4. **Continuity capsule.** A `branch_gap` demand records its origin (bridge, origin exposure) on the
   binding, so the bound Scroll opens as the continuation it was needed for and "back" returns to the
   origin (the existing branch return).
5. **Corrections reach inventory and the reader.** When a source correction leaves a bound Scroll with
   an unsupported claim (ADR-0031's `claim_is_supported`), the Scroll stops being eligible, its bindings
   are **withdrawn** (`source_correction`) and their demands reopen for the Quartermaster; an open
   supply request whose material was revoked is cancelled. A withdrawn binding the reader was shown, or
   was waiting for, appears in "While you were away" as a typed item worded by the client ("A Scroll you
   were waiting for was withdrawn: what it was based on changed"). No source is ever named (owner
   decision, 2026-09-24).
6. **Read.** `GET /v1/inventory` returns this reader's demands with their state, decision, reason,
   concept name and, once bound, the Scroll's id and title; `GET /v1/atlas` carries, per place, its
   open or bound demand. Android shows it in the place sheet ("Being written: more about Tides",
   "New for you: <title>", "Nothing more about Tides for now", "Withdrawn: what it was based on
   changed") and bound Scrolls open in the reader. Web parity is #171.
7. **Privacy.** Demands, waiters and bindings are private history: Clear/Reset erase them (cancelling
   waiters, never shared requests), export carries them, deletion removes them. Supply requests and the
   Scrolls they produce are shared library, like the editorial library.

## Amendment (implementation)

Built as decided, with four adaptations the code required. A request whose one send failed or was
lost may still have reached the provider, so its demand is not funded again: `cannot_meet` also has
the reason `request_failed` (a request refused before it was sent, because its page could not be
fetched or had changed, settles `refused` and counts toward the two refusals). A funded request holds
one unit of its route's bucket until it is sent (consumed) or settles unsent (released), kept by the
migration's `supply_request_budget`, so `no_budget` is decided when funding and a join never waits on
a request the route cannot pay for. There is no feed per place: the Composer serves a bound Scroll
first in the reader's feed, the binding records its place, and Android opens it from the place sheet
through that feed. An offered continuation is observed when `GET /v1/assets/:assetId/branches` lists
one whose target the reader was already shown; its origin is their latest exposure to that encounter
in the epoch.

## Not in this version

Adapt, Reel generation and Cutroom (#9), cross-scope cost sharing (one sponsor: the operator route),
experiment cohorts, suitability beyond concept subtree and eligibility, room-caused demand (#163's
rooms make no artifacts yet).

## Consequences

Migration `0040_content_inventory.sql` (`content_demand`, `supply_request`, `demand_waiter`,
`encounter_binding`, `scroll_writing_route`, `scroll_material_candidate`, guards: one open demand per scope and concept, immutable decision history, a
binding only to an eligible Scroll, no writes while paused); pure `quartermaster.ts`; `packages/db/src/inventory/*.ts`;
the Composer's bound-first rule and evidence; the worker's writing loop over `supply_request`; routes and
contract; away items; Android place sheet. An emulator journey: real reading exhausts a place, the demand
is funded, the worker writes and admits a Scroll (fixture transport, then one bounded live request), the
reader sees and opens it, then a source correction withdraws it and the reader sees why.
