# Geography (Cartographer)

Geography owns the places in a person's universe: systems, their organising stars, planets, regions
and routes. It decides when reading is enough to form one, records every change as an immutable
delta, and offers the unlabelled dust cues that come before a system. Scene projection, rendering,
navigation and sharing belong to other modules. Decisions: D-033, D-038. Tracker: #237.

Status words used below: **implemented** (in source, covered by `checks`), **runtime-verified**
(seen working on a running API and worker), **planned**.

## How reading becomes places

| Stage | What the person has done | What they get | Status |
|---|---|---|---|
| Dust | One qualified encounter under a topic of a system that is not established yet | An unlabelled cue from the `emerging` read | implemented, runtime-verified locally |
| System and star | Two distinct qualified explanation units under one system | The system and its organising star | implemented, runtime-verified locally |
| Planet | Three distinct units under one planet that cover two of its facets | The planet | implemented, runtime-verified locally |
| Region | A supported facet of a formed planet | The region | implemented, runtime-verified locally |
| Route | Support at both ends, two formed planets of one system | A route, only if the model proposes it | implemented |
| Quiet | The latest support is more than 30 days old | The place goes quiet; it is never removed | implemented |

The thresholds are the experimental policy `geography-passive.v1` (`domain/policy.ts`). A unit is a
canonical `explanationUnitId`. Variants, a Reel and its Scroll twin, witnesses and replays are the
same unit. No Like, quiz, return visit, inventory tag, share, generation, other person or
provisional input counts. Unrelated topics never form one planet. Only Scroll coverage is trusted
facet support today, so a Reel-only reader gets dust but no system until Reel coverage exists.

## One journey

1. Evidence qualifies an encounter and Personal Context projects it. In the same transaction the
   material-change hook (`GEOGRAPHY_MATERIAL_CHANGE`) records a new desired revision and makes sure
   one run exists for the person. Further changes coalesce into that run.
2. The worker (`geography.cartograph`) claims the run and, in a short transaction, freezes a
   context: the canonical candidates, their stable IDs and labels, and the person's current
   positive support. Support comes from Personal Context's trusted coverage, which itself checks
   Evidence and Content under the person's root. A reader whose support is more than one context
   holds gets the support the rules need (see Limits and degradation).
3. The role `geography.cartographer` asks the model for a `cartographer-proposal.v1`. No model call
   happens inside a database transaction.
4. Code picks what to apply (`planFor` in `application/run.ts`) and records it in the run's
   `outcome`:
   - `applied`: a valid proposal that already covers what the rules require;
   - `applied_with_rules`: a valid proposal plus every place or activity change the rules require
     that it left out (`reconcileWithRules`);
   - `applied_by_rules`: the rules alone (`requiredChanges`, canonical catalogue labels), when the
     model gave nothing usable (invalid output after one repair, provider failure, quota, budget,
     the role's failure brake), or when its proposal conflicts with the rules (two operations on one
     place) or cannot share a delta with them (more than 32 operations);
   - nothing for an `unknown` attempt. It may still be reconciled, so the run stays `unknown` until
     an operator resumes it.
5. One revision-checked transaction rechecks the owner, epoch, desired revision and the whole
   current authority, applies all operations, writes the delta, advances the personal revision,
   enqueues `geography.publish-delta` and calls `GeographyApplied` so Scenes can project. Any
   failure rolls everything back, including the ledger closure.
6. An answer that is unusable with nothing due settles the run. The next qualified encounter
   starts another one. Only an `unknown` attempt holds a run.

The harness can also refuse before it admits a run (`provider_unavailable`, `role_invalid`,
`run_invalid`, `run_mismatch`, `context_invalid`, `context_insufficient`, `request_too_large`). No ledger run or attempt exists then,
so there is nothing to close. When accounting proves nothing is retained, the rules are applied under
the claim's own authority (same checks, same transaction); with nothing due the run is released with
the refusal as its outcome. A refusal that does come from a ledger run which is already closed is
settled the same way, without a second close.

## What the model may propose, and what code checks

The model may use eight typed operations: `create_system`, `establish_star`, `form_planet`,
`add_region`, `connect_route`, `revise_label`, `set_activity`, `withdraw_relation`. It copies
candidate keys, IDs, labels and support references from the context. It cannot submit a patch,
merge, split or create an alias, and it cannot invent meaning.

Code owns formation. `proposalIssue` simulates the whole ordered proposal before any write and
checks canonical membership, distinct support, parent and hierarchy, truth status (factual only),
identity uniqueness and duplicate effects. Apply repeats the check on freshly read authority.
Withdrawn content, a corrected map or a retracted encounter makes an in-flight proposal stale
even without a new observation. A proposal of at most 32 operations and 60 KiB is accepted.

Labels are neutral: the model chooses between the canonical label and the catalogue meaning, never
a mastery or belief claim. A place that went quiet keeps its ID, label and origin.

## Dust cues

`ReadOwnEmerging` (`POST /v1/universe/emerging/read`, contract `universe-emerging.v1`) lists one
opaque cue for each catalogue system that Personal Context holds a qualified unit for and that is
not established. A cue has no label, topic or count. Its ID is derived from the universe, epoch and
system, so it is stable between reads and names nothing. The read never enqueues anything. A
selective Clear removes the evidence and so the cue. Map visits and suggestions never create one.

## Public entry points and dependencies

`public.ts` exports the use cases and queues. Other modules reach Geography only through it.

| Entry point | Purpose |
|---|---|
| `GEOGRAPHY_MATERIAL_CHANGE` | Evidence/Personal Context hook: records a desired revision and the run |
| `REQUEST_CARTOGRAPHY` | Backend-only explicit request or resume of the same business run |
| `RUN_CARTOGRAPHER`, `PUBLISH_GEOGRAPHY_DELTA` | Worker consumers |
| `READ_OWN_GEOGRAPHY`, `READ_OWN_DELTAS` | Snapshot and catch-up reads |
| `READ_OWN_EMERGING` | Dust cues |
| `READ_GEOGRAPHY_SCENE_INPUT`, `GEOGRAPHY_APPLIED` | Scenes' input and the same-transaction hook; Social reads the same input to draw the list a friend may visit (D-047) |
| `READ_OWN_REGION_CONSTRAINT` | Exact region authority for region encounters (U04) |

Dependencies point inward: `adapters/` (Postgres, Nest wiring) use `application/` (run, apply,
context, reads), which uses `domain/` (policy, formation, emerging). Geography reads Personal
Context, Content's concept catalogue and Identity through their `public.ts`.

## Configuration

`KS_CARTOGRAPHER_ENABLED=1` on the worker switches the role on (default 0). It is the only switch.
Spend is bounded by the shared reasoning budgets and by the role's failure brake: five failed runs
per UTC day stop its model calls, and the rules still form places. The worker also needs
`KS_REASONING_PROVIDER=minimax` and `MINIMAX_API_KEY`. With the switch off, a claimed run is
released as `insufficient/disabled` without a model call and the person's cartography is not
stranded: reading after the switch is on starts a new run. A run that older code parked as
`blocked` with outcome `disabled` or `provider_unavailable` restarts on the next material change.

## Tables, jobs, notices

| Store | Purpose |
|---|---|
| `geography.state` | One row per universe and epoch: revisions (`revision`, `structureRevision`, `activityRevision`), desired and material revision, active run, published checkpoint |
| `geography.runs` | The business run: header, frozen private context (at most 512 KiB), proposal, outcome |
| `geography.objects` | Places with stable semantic key and UUID, support references, retained structure |
| `geography.relations` | Routes and retained aliases, withdrawn rows stay |
| `geography.deltas` | Immutable applied changes with their input hash and run |

Jobs: `geography.cartograph` (20 minute expiry, three retries with 30 s backoff, concurrency 1) and
`geography.publish-delta` (3 minute expiry, three retries with 10 s backoff). Both keep 7 days queued
and 2 days settled, with a dead letter. Payloads hold IDs only. pg-boss is the only outbox. The
publish job sends the disposable scope notice for a delta that is already committed; durable reads
recover anything the notice missed.

## Lock order

Personal root, then the owned Geography, Personal Context and Evidence rows, then sorted Content
asset and head SHARE locks, then the harness closure. Geography never takes another person's root.

## Reads

Reads are read-only. They never wake a role, call a model or write. `ReadOwnGeography` pages at
most 100 objects with all their routes and aliases and checks hierarchy and cursors against the
current revision (an old cursor answers `snapshot_expired`). `ReadOwnDeltas` returns at most ten
contiguous deltas, or `snapshot_required` on a gap. An empty snapshot means no established places,
not no reading. `loading` and `lagging` need a real queued or prepared run.

## Failure and recovery

- A claim lasts 1150 seconds. A delayed wake bound to that exact claim recovers a crashed handler.
- Queue delivery, business run and external attempt are separate records. Every paid attempt
  consults the attempt ledger. An unknown outcome is never resent.
- A reset, Clear or suspended account fences late work. Late completion is refused and erased.
- Pause recording revokes in-flight runs: a header-only retirement wake retires revoked metadata,
  never starts a successor on its own, and never adopts a legacy header. Committed deltas stay
  readable while paused.
- A missing provider refuses before any model attempt exists. With nothing retained, the rules are
  applied or the run is released as `insufficient/provider_unavailable`; reading never strands.
  An unknown attempt is the only state that holds a run for an operator.

## Limits and degradation

- **Support in one context.** Trusted coverage is read in batches of 100 probes; a batch that
  reaches the trusted read's own bound (raw references, assets, 128 KiB of output) is split and read
  as two. When the supports do not fit one frozen context (100 supports and about 360 KB with their
  proofs), `compactSupports` keeps the newest support of every facet of every planet, then
  further distinct units up to what a planet needs, then the newest of the rest. Within that budget
  no place the rules would form and no activity they would set changes. Beyond it the oldest and most
  repetitive support goes first, so formation degrades and does not stop.
- **Discovery.** Candidate discovery refuses past 1000 raw coverage references or 256 KiB of keys;
  then the run settles as `coverage_unavailable` and the next reading tries again.
- **One delta.** A run applies at most 32 operations. Anything still due is applied by the next run.
- **Model and cost.** One run and one model call per material change; the shared reasoning budgets
  and the failure brake bound spend.

## Erasure

Full erasure deletes deltas, relations, objects, state and runs across all epochs, and both queues'
payloads in every state. Scenes erases first. A selective Clear removes the same stores. The dust
read has no store of its own.

## Scenes boundary

`ReadGeographySceneInput` returns canonical meaning IDs, public objects, routes, aliases and the
current personal-root watermark, without supports, evidence, context or scores. `GeographyApplied`
runs in the apply transaction: it enqueues one `scenes.project` job and records the U05 delivery
facts of the creations just committed, so the Universe client can show each formation once. A
creation delta without its delivery fact fails the whole transaction at commit.

## Verification

`checks` runs the pure rules and properties (`domain/*.test.ts`) and PostgreSQL integration suites:
`geography.test.ts` (authority, atomicity, replay, paging, erasure), `cartographer-formation.test.ts`
(dust, system, planet, unrelated topics, inactivity, Clear with row counts, model failure, the failure
brake, a role switched off, parked runs, refusals before admission, a conflicting proposal and a reader
with more than 100 covered pairs) and
`recording-geography.test.ts` (original generation and wake ownership). Sources, maps and model
answers in tests are labelled CI fixtures. A local drive with a real sign-in, the release API and
worker, three Scrolls from the production path and a real MiniMax call showed dust, then a system
and star, then a planet (D-038).

## Related

Blueprint §8, §12, §13, §16. Contracts: `packages/contracts/src/geography.ts`. Library plan:
`modules/content/domain/library/`. Scenes: `modules/scenes/README.md`.
