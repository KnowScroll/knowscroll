# Geography (Cartographer)

Geography owns the places in a person's universe: systems, their organising stars, planets, regions
and routes. It decides when reading is enough to form one, records every change as an immutable
delta, and offers the unlabelled dust cues that come before a system. Scene projection, rendering,
navigation and sharing belong to other modules. Decisions: D-033, D-038, D-052, D-104, D-105, D-409, D-416. Tracker: #237, #467, #674.

A `runtime-verified` mark that names a day and a run folder (`journeys-v3`, `dev-check-N`, `fidelity-v3`, `room-journey`, `mod-steps`) was seen on dev on that day. The folders are on the coordinator's machine, not in the repository; `docs/v2/design/fidelity-v3.md` records what the screens looked like.

Status words used below: **implemented** (in source, covered by `checks`), **runtime-verified**
(seen working on a running API and worker), **planned**.

## How reading becomes places

| Stage           | What the person has done                                                           | What they get                                                                                                            | Status                                                                |
| --------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Dust            | One qualified encounter under a topic of a system that is not established yet      | An unlabelled cue from the `emerging` read                                                                               | implemented, runtime-verified locally and on dev (2 Nov, fidelity-v3) |
| System and star | Two distinct qualified explanation units under one system                          | The system and its organising star                                                                                       | implemented, runtime-verified locally and on dev (2 Nov, fidelity-v3) |
| Planet          | Three distinct units under one planet that cover two of its facets                 | The planet                                                                                                               | implemented, runtime-verified locally and on dev (2 Nov, fidelity-v3) |
| Region          | A supported facet of a formed planet                                               | The region                                                                                                               | implemented, runtime-verified locally and on dev (2 Nov, fidelity-v3) |
| Route           | Support at both ends, two formed planets of one system                             | A route, only if the model proposes it                                                                                   | implemented                                                           |
| Quiet           | The latest support is more than 30 days old, whether or not the person reads again | The place goes quiet; it is never removed. A Cartographer run or the quiet sweep sets it (see Quiet without new reading) | implemented                                                           |

The thresholds are the experimental policy `geography-passive.v1` (`domain/policy.ts`). A unit is a
canonical `explanationUnitId`. Variants, a Reel and its Scroll twin, witnesses and replays are the
same unit. No Like, quiz, return visit, inventory tag, share, generation, other person or
provisional input counts. Unrelated topics never form one planet. A Reel is trusted facet support
like a Scroll (#674 slice 5.1, D-421), for the facets whose required segments the person watched, so a reader who has
only watched Reels forms a system and a planet. A Reel and its Scroll twin are one unit and count once.

## One journey

1. Evidence qualifies an encounter and Personal Context projects it. In the same transaction Personal Context marks the
   topic dirty when a trusted support key of it gains or loses a reference (`personal_context.coverage_dirty_topics`), and the
   material-change hook (`GEOGRAPHY_MATERIAL_CHANGE`) records a new desired revision and makes sure one run exists for the
   person. Further changes coalesce into that run. A new run's wake waits until `geography.state.next_run_not_before`, which
   every settled run sets 30 seconds ahead (`domain/pacing.ts`, D-052). Reading that keeps arriving is therefore one pending
   run, not one run per encounter. An explicit request is not paced: it marks every topic that has support dirty, starts a run
   at once when none is pending and otherwise joins the pending one.
2. The worker (`geography.cartograph`) claims the run and, in a short transaction, freezes a context of **what changed**: the
   newest dirty topics (at most 16, `EVALUATION.topicsPerRun`), the newest few support keys of each facet of each
   (`READ_COVERAGE_INPUTS`), their exact trusted supports (`READ_TRUSTED_COVERAGE`, which checks Evidence and Content under the
   person's root), the stored places of those topics found by key, and the identities the rules may form. Nothing else is read:
   not the catalogue, not the rest of the person's history. A reader whose dirty set is empty gets a context with nothing in it;
   a reader with no coverage reference at all settles the run as `no_support_yet` before any coverage is read. The context is
   frozen when the run starts, so a run that waited sees everything that arrived while it waited. More dirty topics than one
   run takes stay dirty, and the settled run starts the next one, paced (see What a frozen context holds).
3. Formation is the rules' decision (D-038), so a model has something to choose only when a place is
   due. With none due, a reading-triggered run asks no model: it applies any activity change by the
   rules, or settles `insufficient/no_changes`, with no ledger run. An explicit request
   (`REQUEST_CARTOGRAPHY`) asks the model even then. That is a latent operator path: nothing in the
   product calls it yet, and the mark is read from the person's latest desired source when the run is
   claimed, so reading that arrives before the run starts overwrites it. Only a run's first claim can
   skip the model.
   Otherwise the role `geography.cartographer` asks the model for a `cartographer-proposal.v1`. The
   context lists the places the rules entitle as ready `due` operations. Code applies all of them
   whatever the model returns, so the model returns only what it adds: another canonical label for a
   due place, a route, a label revision. An empty answer is the normal reply. The answer is judged
   with the due operations merged in, so a route to a planet that is only due is valid. No model call happens
   inside a database transaction.
4. Code picks what to apply (`planFor` in `application/run.ts`) and records it in the run's
   `outcome`:
   - `applied`: a valid proposal that already covers what the rules require;
   - `applied_with_rules`: a valid proposal plus every place or activity change the rules require
     that it left out (`reconcileWithRules`). An empty answer, the normal reply, lands here;
   - `applied_by_rules`: the rules alone (`requiredChanges`, canonical catalogue labels), when the
     model gave nothing usable (invalid output after one repair, provider failure, quota, budget,
     the role's failure brake), or when its proposal conflicts with the rules (two operations on one
     place) or cannot share a delta with them (more than 32 operations);
   - nothing for an `unknown` attempt. It may still be reconciled, so the run stays `unknown` until
     an operator resumes it.
5. One revision-checked transaction rechecks the owner, epoch, geography revision and the whole
   current authority, applies all operations, writes the delta, advances the personal revision,
   enqueues `geography.publish-delta` and calls `GeographyApplied` so Scenes can project. Any
   failure rolls everything back, including the ledger closure. Reading that arrived while the
   model worked does not void a proposal: it applies when every operation still holds on today's
   authority, and the later reading gets its own paced run. Withdrawn or retracted support, or a
   correction that changes a binding, makes it `stale/source_changed`, and only then is a valid
   answer cancelled. A new coverage head that changes only the catalogue digest is not a correction
   (D-406).
6. An answer that is unusable with nothing due settles the run. The next qualified encounter
   starts another one, which waits its interval. Only an `unknown` attempt holds a run.

The harness can also refuse before it admits a run (`provider_unavailable`, `role_invalid`,
`run_invalid`, `run_mismatch`, `context_invalid`, `context_insufficient`, `request_too_large`). No ledger run or attempt exists then,
so there is nothing to close. When accounting proves nothing is retained, the rules are applied under
the claim's own authority (same checks, same transaction); with nothing due the run is released with
the refusal as its outcome. A refusal that does come from a ledger run which is already closed is
settled the same way, without a second close. If the ledger run was closed under the run (the idle
sweep), nothing can be applied under it; the run settles by the rules the same way, once accounting
shows no live attempt.

## What a frozen context holds

Formation is a pure, deterministic function of the pinned catalogue, the exact trusted supports of the topics being evaluated
and the stored places (`application/context.ts`, #674, D-416). It costs what changed, never what the catalogue or a person's
history holds, so it works for a person with thousands of topics and years of reading:

- **Evaluated topics** (`evaluated.topics`): the newest dirty topics, at most `EVALUATION.topicsPerRun` (16). For each, the
  newest `EVALUATION.keysPerFacet` (3) support keys of each facet are probed (`last_activated_at` orders them), so a heavy
  re-reader's cost is the topics read and the library's units under them, never how much they have read. The newest key of a
  facet decides a region and a place's last support, and a planet needs three units over two facets, so a facet with more keys
  already holds enough: bounding by facet changes no place the rules form and no activity they set while the keys read are
  trusted (`domain/formation.test.ts`, a property over random readings).
- **Neighbours** (`evaluated.neighbours`): when a place of a touched system could be created now (the system is not formed, or a
  planet is due beside a formed system), or the system's stored last support is newer than anything read under it (support was
  just lowered), the run also reads up to 8 other supported topics of that system, the most recently supported first, one key of
  each facet. They are read, not evaluated: a neighbour that was dirty stays dirty. A formed system with nothing due beside it
  reads none, so the steady state of a heavy reader is the touched topics alone.
- **Facts** (`facts`): the catalogue entries of the topics with support or a stored place and their systems (`facts.catalogue`, with every
  facet of each topic, from one release of the topic catalogue, D-419; a node's formation thresholds `systemUnits`, `planetUnits`,
  `planetFacets` are in the slice only where they are not the defaults 2, 3 and 2, and `formationEligible` reads them), the supports,
  the candidates (a slot with a derived id and its labels) for each system, star, planet and the regions that are supported or
  established, the stored places loaded by semantic key (a topic's system, star, planet and the regions of its facets), and the
  routes already joining those planets. A system's and a star's stored last support is carried in `carriedSupportAt`, so reading
  one topic never makes the system look older than reading of another under it.
- **The pinned release** (`catalogueRelease`): the catalogue release the context was frozen against. The re-check at apply reads that
  release (`Catalogue.release(n)`), not a newer one, so a topic or a wording released in between never changes a decision already made;
  a context frozen before releases existed reads the current release, which for the seeded catalogue is the same. A support whose
  recorded meaning is no longer the current wording, and was not declared the same meaning, supports nothing (`acceptsMeaning`). A topic
  the release retired leaves the slice and forms nothing new.
- **Proof**: each support's witnesses (their digests name the certificates, which stay in Personal Context), a few hundred
  bytes a support. An operation cites at most 20 supports (`PROOF_REFS`): the newest of each facet, then of each distinct unit,
  then the newest of the rest, so 32 operations fit the 64 KiB a stored proposal holds and a place's row the 100 references it
  allows. A place with 20 supports or fewer cites all of them.
- **Identities**: a stored place keeps its id. A new place's id is an HMAC of the universe's place secret (created at the first
  run, in `geography.state.place_secret`, erased with the state by Clear and erasure) and its semantic key, formatted as a UUID;
  a new route's id is an HMAC of the sorted pair of the two planets' keys. Every evaluation of the same facts derives the same
  ids, so there is no table of allocated slots or pairs, and an id names nothing without the secret (`domain/ids.ts`).

The apply re-reads exactly the topics (and neighbours) the context froze (`evaluationOf`) under today's authority, so its facts
are the same facts and a proposal applies when every operation still holds (D-052). Evidence that arrived during the run has
a higher dirty revision than the run's read, so it stays dirty and gets its own paced run. A context bigger than 500,000 bytes
takes fewer of the dirty topics (halving until it fits), and one topic that alone does not fit is refused as
`context_too_large`. A context frozen before incremental evaluation (no `evaluated`) is read as the topics of its supports and
planets, and is finished as before.

## Run outcomes

A run that ends without a place says why in `geography.runs.outcome` (and `ops.geography_runs`). Most
are `insufficient`; none needs an engineer except the limits.

| Outcome | Meaning |
|---|---|
| `no_changes` | Nothing is due; reading alone does not ask a model |
| `no_support_yet` | The person has no coverage references yet. Healthy. No coverage was read and no context built |
| `no_trusted_support` | The topics read have references but none is current trusted support (content withdrawn, a map corrected), and neither is any of the reader's 8 other most recent topics (a sample of one key of each facet, `evaluated.otherTrusted`; the sample never enters the facts). The evaluation is complete: places keep their activity, nothing is applied unless an activity change is due. When the sample does find trusted support the run records `no_changes`, so one withdrawn Scroll among a reader's newest topics is not a fault of the watchdog's `geography_insufficient_repeat` |
| `coverage_limit` | The trusted read cannot hold even one probe's proof |
| `coverage_authority_changed` | Content or Evidence moved while the proof was read; the next reading tries again |
| `structure_limit` | More than 1000 places, or routes and aliases, in one universe (counted, not loaded) |
| `context_too_large` | One topic's context alone would pass 500,000 bytes (a run takes fewer dirty topics until it fits) |
| `applied_by_rules_context_limit` | The context does not fit one model request, so no model was asked, and the rules applied what was due |
| `context_limit` | The same cause with nothing due: no model was asked and nothing was applied |
| `context_unreadable` | The stored frozen context is missing or for another scope |
| `disabled`, `provider_unavailable`, `request_too_large`, ... | Role switched off, or a refusal before admission (see One journey) |

Runs written before #674 may say `coverage_unavailable`, which covered the six causes above, or `discovery_limit`, which no run records now.

## Quiet without new reading

A person who stops reading would never start a Cartographer run, so a run alone could never show a place going quiet. The quiet
sweep (D-104, D-105, D-416) closes that gap by rules alone, place by place. Status: **implemented** (CI integration on real
PostgreSQL); **planned** for runtime verification on dev.

1. Each `geography.objects` row stores `last_support_at` (the newest support activation under the place when its topic was last
   evaluated; a system's and a star's is the newest of what was read and what was stored, or, when their support was just
   lowered, what the other topics under them hold) and `quiet_check_at` (when the place next needs a look: its last support
   plus 30 days while it is active, now while its stored activity differs from what its support implies, null for a quiet place
   or one with no support). Every apply, every settle and every run that evaluates a topic rewrites them (`placeSchedules`). They
   are scheduling state, never evidence, and never leave the server.
2. `geography.sweep-quiet` (pg-boss cron every 15 minutes, worker) makes one indexed query (`geography_object_quiet_due`) for
   the oldest 500 places whose `quiet_check_at` has passed, across universes, and takes up to 100 such pages a pass (50,000 places a
   pass, 4,800,000 a day; see `QUIET_SWEEP`). The places of a universe that no run holds, whose
   account is active, that is not being cleared and whose recording is on go to `geography.settle-quiet` jobs that name them (at
   most 32 a job), in the same transaction, and their `quiet_check_at` moves 30 minutes ahead (a lease). The places of any other
   universe wait: those of a universe a run holds 5 minutes (the run settles within minutes, so the next pass tries them), those of a
   universe that is paused, being cleared or suspended a day. Every row a page looks at leaves the head of the index, so a page reads
   at most 500 rows however many universes are refused. It reads no support. A place a settle could not read (its topic has no
   support, or its support could not be read) backs off an hour, doubling up to a day, and is let go after the sixth look (its next
   look is cleared until reading stores its schedule again, `quiet_attempts`); a place with no support is no longer looked at daily
   for ever. **Capacity.** A migration-day backlog in which every place that is not quiet is due once drains within a day up to
   4,800,000 places, which is about 96 non-quiet places for each of the 50,000 universes the operator's cost tests use; a development
   database (tens of universes, at most 1000 places each) drains in its first pass or two. A page is one indexed query and at most 16
   settle jobs (about 150 ms), so a full pass takes about 15 s against the queue's 120 s, and the 1,563 settles it hands over are
   drained by the workers between passes.
3. `geography.settle-quiet` enters the personal scope as a system actor and rechecks the account, epoch and the recording
   generation the sweep saw. It reads the **topics of the named places only** (a planet's or a region's planet's topic; a system's
   or a star's most recently supported topics) through the same evaluation a run uses, and applies only `activityChanges`
   (`domain/quiet.ts`), the same pure rule the Cartographer's `requiredChanges` uses, through the same `applyProposal`. One
   immutable delta with no run, the revision stamps (only `activityRevision` moves), a scene-projection job and a publish job
   commit together. With nothing due it stores the corrected times and moves no revision. A place whose topic could not be read
   waits a day. No model call, no ledger run, no network wait. A settle never clears a dirty topic: a creation that is due belongs
   to the run that owns it.
4. It stands aside, and changes no place, delta or revision, when recording is paused, when `KS_CARTOGRAPHER_ENABLED` is off, or
   when a Cartographer run holds the universe (a delta under a run's frozen context would void its answer). The only thing it
   writes then is the places' own `quiet_check_at`. With the role off, the sweep does nothing at all. Places settle within a day
   after the obstacle ends. Paused time counts toward the 30 days: the server keeps no record of reading while recording is paused
   (D-083). More than 32 changes settle over several passes. A job queued before places were scheduled one by one (`v: 1`) names
   no place and is ignored.

Inactivity changes activity, never existence: ids, labels and origin transitions are untouched. A new encounter after quiet starts
a Cartographer run as before, and that run sets the places it supports active again. A place whose support is all gone keeps its
activity and its last support time stays what it was. "Everything is where you left it" stays on the device. Before this slice the
sweep's schedule was `geography.state.next_quiet_at`; the column and its index stay, unread and unwritten, for a release that
still reads them.

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
not established, at most `EMERGING_LIMITS.dust` (16), the first by system ID, so a reader who is gathering
toward more systems sees the same cues on every read and never an error. A cue has no label, topic or count. Its ID is derived from the universe, epoch and
system, so it is stable between reads and names nothing. The read never enqueues anything. A
selective Clear removes the evidence and so the cue. Map visits and suggestions never create one.

## Place concepts (D-214)

`ReadOwnPlaceConcepts` (`POST /v1/universe/places/concepts/read`, contract `universe-place-concepts.v1`) lists the
catalogue topic of each established factual planet of the caller's universe, with the geography revisions it was read
against. It exists so the Universe can set a landmark, which `play` keeps against a Scroll's topic, on that topic's
planet (D-084, D-089). A topic is a public catalogue id, so the answer adds nothing personal beyond which planets exist,
which the snapshot already says. It is a read of the same stored places (no write, no cartography request, no model); it
holds nothing from play and `play` never imports this module (D-180). _Implemented; runtime-verified on dev (2 Nov, fidelity-v3: the waiting landmark names its planet and stands on it once formed) and locally
(`tests/integration/modules/play.test.ts`)._

## A system's topic (#697, D-403)

`ReadOwnSystemTopic` (`READ_OWN_SYSTEM_TOPIC`) names the catalogue topic of one of the caller's own established factual
systems, read by id under the existing personal root, so Experience can list that system's Reels and Scrolls before it has
a planet. A foreign, unknown, hypothetical or non-system id answers `not_on_map` alike. A stored row that no longer matches
the catalogue or the map answers `temporarily_unavailable`, never a guessed topic. It writes nothing. _Implemented; unit
tests in `application/system-topic.test.ts`._

## Public entry points and dependencies

`public.ts` exports the use cases and queues. Other modules reach Geography only through it.

| Entry point                                       | Purpose                                                                                                                                                                                                   |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GEOGRAPHY_MATERIAL_CHANGE`                       | Evidence/Personal Context hook: records a desired revision and the run                                                                                                                                    |
| `REQUEST_CARTOGRAPHY`                             | Backend-only explicit request or resume of the same business run                                                                                                                                          |
| `RUN_CARTOGRAPHER`, `PUBLISH_GEOGRAPHY_DELTA`     | Worker consumers                                                                                                                                                                                          |
| `READ_OWN_GEOGRAPHY`, `READ_OWN_DELTAS`           | Snapshot and catch-up reads                                                                                                                                                                               |
| `READ_OWN_EMERGING`                               | Dust cues                                                                                                                                                                                                 |
| `READ_GEOGRAPHY_SCENE_INPUT`, `GEOGRAPHY_APPLIED` | Scenes' input and the same-transaction hook; Social reads the same input to draw the list a friend may visit (D-047), and Rooms to place a room's station beside a system of the caller's own map (D-051) |
| `READ_OWN_REGION_CONSTRAINT`                      | Exact region authority for region encounters (U04)                                                                                                                                                        |
| `SWEEP_QUIET`, `SETTLE_QUIET`                     | Worker consumers of the quiet sweep and its per-universe settle (D-104)                                                                                                                                   |

Dependencies point inward: `adapters/` (Postgres, Nest wiring) use `application/` (run, apply,
context, reads), which uses `domain/` (policy, formation, emerging). Geography reads Personal
Context, Content's concept catalogue and Identity through their `public.ts`.

## Configuration

`KS_CARTOGRAPHER_ENABLED=1` on the worker switches the role on (default 0). It is the only switch,
and it also governs the quiet sweep: with it off, nothing is handed over and no settle changes a place.
Spend is bounded by the shared reasoning budgets and by the role's failure brake: five failed runs
per UTC day stop its model calls, and the rules still form places. Runs are paced 30 seconds apart
(`RUN_INTERVAL_MS` in `domain/pacing.ts`). The role is a background role (D-058): it also stops at
its share of the global and the person's daily budgets (`KS_REASONING_BACKGROUND_SHARE_PERCENT`, default 50),
so a person who only reads keeps the rest of their allowance for what they ask for, and the rules still
form places. The worker also needs `KS_REASONING_PROVIDER=minimax` and `MINIMAX_API_KEY`. With the switch off, a claimed run is
released as `insufficient/disabled` without a model call and the person's cartography is not
stranded: reading after the switch is on starts a new run. A run that older code parked as
`blocked` with outcome `disabled` or `provider_unavailable` restarts on the next material change.

## Tables, jobs, notices

| Store | Purpose |
|---|---|
| `geography.state` | One row per universe and epoch: revisions (`revision`, `structureRevision`, `activityRevision`), desired and material revision, active run, published checkpoint, `next_run_not_before` (the pacing time), `place_secret` (the HMAC key of derived place and route ids, D-416). `next_quiet_at` is no longer used |
| `geography.runs` | The business run: header, frozen private context (at most 512 KiB), proposal, outcome |
| `geography.objects` | Places with stable semantic key and UUID, support references (at most 20 cited), retained structure, `last_support_at` and `quiet_check_at` (per-place quiet time, D-416) |
| `geography.relations` | Routes and retained aliases, withdrawn rows stay |
| `geography.deltas` | Immutable applied changes with their input hash and the run that made them (none for a quiet settle) |

Jobs: `geography.cartograph` (20 minute expiry, three retries with 30 s backoff, concurrency 1) and
`geography.publish-delta` (3 minute expiry, three retries with 10 s backoff). Both keep 7 days queued
and 2 days settled, with a dead letter. `geography.sweep-quiet` (cron every 15 minutes, no payload) and
`geography.settle-quiet` (5 minute expiry, three retries with 30 s backoff, one universe and its
recording generation per job, dead letter) belong to the quiet sweep. Payloads hold IDs only. pg-boss is the only outbox. The
publish job sends the disposable scope notice for a delta that is already committed; durable reads
recover anything the notice missed.

## Lock order

Personal root, then the owned Geography, Personal Context and Evidence rows, then sorted Content
asset and head SHARE locks, then the harness closure. Geography never takes another person's root.
The quiet settle takes the same order. The sweep takes no personal root: it locks only the place rows
it hands over, skipping any another transaction holds.

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
- A run claimed before a deploy that changed the model-facing context (D-052 added the `due` items)
  no longer hashes the way it was recorded and could never send. The next claim retires it
  (`stale/context_changed`) when accounting shows no live attempt, and starts a successor. A run with
  an attempt in flight is left to the ledger's recovery.

## Limits and degradation

- **One run reads what changed.** At most 16 dirty topics, 3 keys of each facet, and up to 8 neighbours of a system with one key of
  each facet (`domain/evaluation.ts`, one place for every number). A run's context is typically tens of kilobytes; a first run over
  a reader whose every topic is dirty (the operator reconciliation, an explicit request) takes the topics in paced batches. On a
  disposable database a reader with 2,184 support keys over 240 topics (872 places) formed in 30 paced runs, the largest frozen
  context 302,487 bytes (the neighbour reads of four unformed systems in one batch), and one new reading in a formed topic read
  that topic's 9 keys and froze 17,418 bytes (D-416). Past 500,000 bytes a run takes fewer topics. A facet whose newest keys are
  withdrawn costs one more page of 3 keys per page it needs, at most 16 pages.
- **Trusted read.** Probes are read in batches of 100; a batch that reaches the trusted read's own bound (candidate rows, assets,
  128 KiB of output) is split and read as two. The read returns one witness per support key, the newest valid one, so one
  re-read Scroll can never exceed the read's output (Personal Context README). If all eight candidate exposures of a key are
  invalid it has no witness that read.
- **Withdrawn keys.** The newest 3 keys of a facet are probed, and a facet that then holds fewer than 3 trusted keys while its
  last page was full is read a page further (`READ_COVERAGE_INPUTS` `page` and `onlyFacets`), until it holds 3 or has no key left,
  up to `EVALUATION.maxKeyPages` (16) pages. A withdrawn newest key therefore never hides an older trusted one, and what a run
  evaluates equals what the whole catalogue holds (PR #723). Only a facet with more than 48 untrusted keys, all newer than its trusted
  ones, keeps an older trusted key unread until it is the newest. The same paging serves the neighbours (one key a page).
- **Topics that cannot be settled.** A topic whose keys were probed with nothing trusted (`evaluated.untrusted`), and the topics of a
  refused apply or a refused claim (`coverage_authority_changed`, `coverage_limit`, `context_too_large`, `source_changed`,
  `revision_changed`, `limit`), are not cleared: the dirty row waits out a backoff (a minute, doubling to an hour; new evidence
  ends it), and the continuation run (`continueCartography`) is woken when the earliest backoff ends, while any dirty row remains.
  A topic that stays untrusted is let go after `EVALUATION.untrustedAttempts` (8) tries, about two hours; a coverage readmission
  (`content readmit-coverage` marks the topics holding the units whose head it appended, `geography reconcile-coverage --unit`) brings
  it back. A refusal that is terminal (the scope is gone, the delta key was reused) leaves the rows alone.
- **A formed system or star with no stored last support** (formed before places stored one, or with no support at all) has nothing to
  carry, so a run that touches a topic under it also reads the topics beside it, as when support is lowered; a partial reading never
  judges it older than what is beside it. A carried last support is never a support to cite: with nothing read under a place it keeps
  its activity, so a quiet settle never proposes a change with no support behind it (PR #723).
- **A system's last support** is exact when reading changes a topic (the new reading is the newest) and when support is lowered
  (the topics beside it are read). It can be older than the truth only when more than 8 other topics of the system hold the newer
  support and none is among the most recent 8.
- **Routes** join planets evaluated or read in the same run: a route to a planet formed earlier is offered when the new planet is
  due (its neighbours are read), not afterwards. A system with more than 8 supported neighbours offers the 8 most recent.
- **Structure.** More than 1000 places or 1000 routes and aliases in one universe settle as `structure_limit` (the Scene map is
  bounded the same, so this stays until the map reads by chunk). They are counted by index, not loaded.
- **Model packaging.** A model request holds at most 64 context items. That limit is checked only when
  a model is called; a run that applies the rules alone is never stopped by it. When a context does not
  fit one request the model is skipped and the rules apply what is due (`applied_by_rules_context_limit`,
  told apart from an ordinary `applied_by_rules`); a run with nothing due ends `context_limit`.
- **One delta.** A run applies at most 32 operations. Anything still due keeps the evaluated topics dirty and the next run, paced,
  applies it.
- **Model and cost.** A run makes a model call only when the rules entitle a place, or on an explicit
  request, so calls follow formation events and not encounters. A call costs about 10,000
  tokens and the first answer validates (the repair is the exception). Runs are paced 30 seconds
  apart. The shared reasoning budgets (60 requests and 600,000 tokens per person per UTC day) and the
  failure brake bound spend; a refused call applies the rules and closes its ledger run.

## Operator: the reconciliation

`geography reconcile-coverage [--universe <uuid>] [--unit <explanationUnitId>]... [--dry-run]` (worker operator command, `apps/worker/src/geography-operator.ts`)
is the one-time pass for readers who read before dirty tracking existed: it marks every topic that has a support key dirty, for
one universe or for all, at the universe's current revision. It reads no support, calls no model and starts no run; the next runs
of those readers take the topics newest first, 16 at a time, paced. Running it twice marks nothing new. It prints counts only.
Status: **implemented**, covered by `incremental-formation.test.ts`.

## Dry run (#674, D-411)

`geography dry-run --universe <uuid>` (worker operator command, `application/dry-run.ts`) says what a Cartographer run would do
for one universe now, without doing it. It enters the personal scope the way a read does (the root lock), in a READ ONLY
transaction that always rolls back, freezes the context the run freezes (`prepareGeography`: the same dirty topics, trusted read
and facts, plus the topics of the places a quiet settle would look at by the clock) and applies the same pure rules
(`dueCreations`, `activityChanges`, `modelContextItems`). A universe with no place secret yet gets an unsaved one. No model is
called, no job is sent and no row changes. Its output is counts and codes only (`domain/dry-run.ts`, `shapeGeographyDryRun`).

`wouldRecord` is the status and outcome the run's row would hold, in **the codes a real run records**, not a second vocabulary: the
refusals above (`no_support_yet`, `no_trusted_support`, `coverage_limit`, `coverage_authority_changed`,
`structure_limit`, `context_too_large`), `disabled`, `no_changes`, `applied_by_rules` (activity alone) and
`applied_by_rules_context_limit` (places are due but the context does not fit one model request, so the rules apply them with no
call). Its `outcome` is `null` when a model call decides it (`applied`, `applied_with_rules` or `applied_by_rules`). `action` says what
would happen: `calls_model`, `applies_rules`, `stops`, `recording_paused`, `not_runnable` or `would_fail` (a `GEOGRAPHY_*` fault).
The rest are counts: places and routes, the topics evaluated, the keys probed, the witnesses the frozen context holds, the distinct supports, what is due by kind and how many one delta applies, the activity changes and the context's bytes. Never
a label, topic, unit or reference. Status: **implemented**; covered by `tests/integration/modules/geography-dry-run.test.ts`, which also
runs it through the worker's own wiring.

`geography.state`, runs, objects, deltas, personal revision and jobs are identical before and after; the report of a reader with
one unit equals what the run then records (`insufficient/no_changes`), a reader with nothing read equals `insufficient/no_support_yet`,
and a reader with places due names the same places the run forms.

## Erasure

Full erasure deletes deltas, relations, objects, state (and with it the place secret) and runs across all epochs, and the payloads of
the three universe-bearing queues (`cartograph`, `publish-delta`, `settle-quiet`) in every state. Scenes erases first. A selective Clear removes the same stores. Personal
Context erases the dirty set with its other tables. The dust read has no store of its own.

## Scenes boundary

`ReadGeographySceneInput` returns canonical meaning IDs, public objects, routes, aliases and the
current personal-root watermark, without supports, evidence, context or scores. `GeographyApplied`
runs in the apply transaction: it enqueues one `scenes.project` job and records the U05 delivery
facts of the creations just committed, so the Universe client can show each formation once. A
creation delta without its delivery fact fails the whole transaction at commit.

## Verification

`checks` runs the pure rules and properties (`domain/*.test.ts`, `application/role.test.ts`) and
PostgreSQL integration suites:
`geography.test.ts` (authority, atomicity, replay, paging, erasure), `cartographer-formation.test.ts`
(dust, system, planet, unrelated topics, inactivity, Clear with row counts and the place secret and dirty set removed, model
failure, the failure brake, a role switched off, parked runs, refusals before admission, a conflicting proposal and a reader with
more than 100 covered pairs formed a bounded run at a time), `cartographer-churn.test.ts` (a burst of reading is one pending
run, a valid answer applies while more reading arrives, no model call without a place due, budget
refusal and a closed ledger run end the run) and
`recording-geography.test.ts` (original generation and wake ownership) and `quiet-sweep.test.ts`
(31 days without reading make every place quiet with the same ids, labels and origins; nothing handed
over when nothing is due; at most 32 places a settle; a new encounter wakes only what it supports; a run, a pause, the role switch
and an earlier epoch stand the settle aside; the settle waits for the root; queued settles are erased;
no ledger run is added). `domain/quiet.test.ts` covers the rule, the schedule and the carried last support. D-416 adds, in
`application/context.test.ts` (a context holds only the topics evaluated and their systems, neighbours read only when a system could
be created or its support was lowered, derived ids stable, secret and distinct per universe, each refusal named apart, fewer topics
when a context is too large), `application/incremental.test.ts` (**the differential test**: on random histories of reading and
withdrawn support, the real prepare and apply over the dirty set, a batch at a time, form exactly the places the whole catalogue forms,
with the same activity once time has passed; 3,000 runs passed before commit), `domain/formation.test.ts` (reading the newest keys of
each facet changes no place and no activity; a proof of at most 20 references stays accepted) and, on PostgreSQL,
`incremental-formation.test.ts` (reading during a run stays dirty and gets its own run; an explicit request and the reconciliation
mark topics; ids derive from the secret and the key; a reader with 2,184 support keys over 240 topics forms exactly what the rules
entitle in bounded runs, keeps a half-built planet unformed and forms it from its own next reading, and goes quiet 31 days on past a
hundred supports) and `personal-coverage.test.ts` (the dirty set's rules). Earlier #674 suites remain: `role.test.ts` (the packaging
limit throws only when asked), `emerging.test.ts` (dust stays within the cap), a reader with more than 1000 raw references on one key
still forms, and a context too large for one model request still forms by the rules with no model call.
`domain/dry-run.test.ts` and `geography-dry-run.test.ts` cover the dry run. Sources, maps and model
answers in tests are labelled CI fixtures. A local drive with a real sign-in, the release API and
worker, three Scrolls from the production path and a real MiniMax call showed dust, then a system
and star, then a planet (D-038). A timed local session (pg-boss consumers started as the worker
starts them, real MiniMax, six Scrolls read 8 seconds apart) made three runs and one model call,
which validated on the first answer; no ledger run was cancelled and the planet, system, star and
two regions formed (D-052).

## Related

Blueprint §8, §12, §13, §16. Decisions: D-409, D-416. Contracts: `packages/contracts/src/geography.ts`. Library plan:
`modules/content/domain/library/`. Scenes: `modules/scenes/README.md`.
