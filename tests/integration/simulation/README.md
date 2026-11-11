# Algorithm simulation lab

Synthetic readers ("personas") use the real backend against a disposable PostgreSQL, the worker's jobs are drained as the
worker would run them, and every run is judged against product invariants and measured. It exists so that problems in
recommendation, planet formation and new-content demand are caught before a live reader meets them, and it is the gate
that every later slice of [#674](https://github.com/KnowScroll/knowscroll/issues/674) must pass.

Status: implemented, runs in hosted CI (`simulation` job in `checks.yml`) on every pull request.

## Run it

| Command from the root | What it does |
| --- | --- |
| `pnpm --filter @knowscroll/integration-tests test:simulation` | Small mode, the one CI runs: the lab (`--project simulation`, three files in parallel, each with its own world), then the gate (`--project simulation-gate`) that judges the run as a whole. Needs `KS_TEST_DATABASE_URL` for a disposable PostgreSQL 16 (see the [suite README](../README.md)). |
| `KS_SIM_SIZE=large pnpm --filter @knowscroll/integration-tests test:simulation` | Large mode, for a manual or nightly run on one machine: about 170 Scrolls and longer sessions. |
| `KS_SIM_SEED=7 KS_COMPOSER_POLICY=v1 … test:simulation` | Another seed, or another Composer policy for a comparison. The lab follows the policy dev runs (`v2`, set by `KS_COMPOSER_POLICY`, the variable the API and the worker read), so a change of dev's policy is a change of the default in `config.ts`. `KS_COMPOSER_POLICY=v3` is the test-only mode of policy v3 (#674, D-420): CI runs the lab a second time under it, with its own report (`simulation-report-policy-v3`), and the same invariants and gate; dev keeps `v2` until the coordinator switches after reading `composer replay-policy`. |

Small mode takes about 25 to 30 seconds on a laptop and should stay under 90 seconds on a hosted runner. The reports are
written to `tests/integration/simulation/output/` (or `KS_SIM_OUTPUT`): `report.json` has every number below per
persona, `summary.md` is the short version (also added to the job summary on GitHub Actions), and `report-<group>.json`
is one file's share. CI uploads the directory as the `simulation-report` artifact, also when the run fails.

## How a run works

```text
library.ts   fixture library, admitted through the real import and coverage paths
world.ts     the real use cases a person touches and the worker's consumers, composed from the
             API's and the worker's provider lists over one disposable database
driver.ts    a persona lives one session: move, offers, activate, read, report, drain
drain.ts     runs the worker's consumers until every queue is idle
queues.ts    the queues it drains, and why it leaves the others
invariants.ts, known-failures.ts   judge the run
metrics.ts, report.ts              measure it and write the reports
gate/        judges the lab as a whole: known failures still reproduced, every queue classified
```

1. **A library.** For each of the catalogue's planets (the 17 topics of the code catalogue) the lab admits several
   explanation units across the planet's facets, through the editorial import (the starter Scroll under a fixture
   identity) and the real coverage admission, attributes them to the planet, and gives the first two units of each planet, and some of
   the others, a Reel twin that shares the unit, with coverage decided by the code that decides a Reel's at publication. Ids and titles are fixtures: `ci-sim-<planet>-<n>` and `[CI sim] …` (the editorial grammar has no dots
   and refuses digits in a title). Nothing was written by a model.
2. **A world.** `simulationWorld` builds the Experience navigation and activation, Evidence intake, Personal Context,
   Region encounters, and the consumers the worker registers on a reader's activity path (the evidence projections, the
   Composer's buffer, the Planner, the Cartographer, the delta publication, Scenes and the visit refresh the worker runs
   after it) from the same provider factories the API and the worker compose. No algorithm module is mocked. What is a
   stand-in is listed under [Stand-ins](#stand-ins).
3. **Personas** (`personas.ts`) decide what a person does next: which move, which offer, how to read it. A seeded random
   source (`rng.ts`) draws their choices and every identifier the lab invents. Reading timings come from each
   document's own reading facts (a Scroll's estimated reading time and block weights, a Reel's duration), and the
   recorder's claims are shaped like the app's: a Reel's events are made by the app's own `createReelRecorder` from
   jittered player ticks (`support/reel-playback.ts`), with the gaps, offsets and clipping the intake really sees.
4. **A session** (`driver.ts`) is, per encounter: navigate (Somewhere new, Next, a region, a link), pick an offer, activate
   it, let the worker prepare the buffer, read it and report observations, then drain the queues until idle. After the
   last encounter the lab drains up to six more times.
5. **Judgement.** The invariants read what the run recorded and what the database holds. Anything an invariant forbids
   is a `Violation` with a stable `code`; each is either explained by a known failure or fails the run.

### The personas

| Persona | What it does | What it exercises |
| --- | --- | --- |
| `cold-start-explorer` | No history; reads, half-reads and skims at random | The first offers, the mix |
| `focused-deep-reader` | Reads one topic in full and skims the rest | Evidence concentrating, formation |
| `broad-skimmer` | Taps Somewhere new, skims one open per topic until it has met every topic | Breadth: many topics touched, none qualified |
| `reel-watcher` | Starts on a Reel and stays in Reels; watches most of them through, some to 85-95% | Format stickiness, Reel evidence, and that only a Reel watched to its end proves a facet |
| `link-reader-reels` | Follows two shared links to Reels of one system and watches both to the end | A Reel-only reader forming a system (D-421: this was a known failure until Reels had coverage) |
| `link-reader-reels-nearly` | Follows the same two links and leaves each at 85-95% | Qualified Reels that prove nothing: the closing segment is unmet, so no coverage reference, no trusted support and no system (its outcome is asserted, not only judged) |
| `link-reader-scrolls` | Follows links to three Scrolls of one planet over two facets | A planet forming (exact) |
| `link-reader-exoplanets` | Reads every Scroll of `space.exoplanets`, then returns to two | Planner demand for a finished topic; regression for the planned-demand duplicate (#712) |
| `topic-switcher` | Reads one topic until a place exists, then opens a region on purpose | Region encounters |
| `binge-reader` | Reads everything new, skips what it has met, until nothing unseen is left, then some more (own five-planet library) | The end of the library, last-resort repeats |
| `idle-tab` | Reads one stop, then leaves a tab open on the next for one to three hours | Inactivity never qualifies |
| `pause-resume` | Pauses recording for four encounters, then resumes | History and evidence across a pause |
| `focused-deep-reader` + `side-by-side-neighbour` | Take turns in one world; the neighbour likes and saves | Isolation between people |

### Invariants

Each is a named check with a message that says what happened. Violations carry a stable `code` and a `detail` with the
cause the lab read from the stored decision or job.

| Id | Statement |
| --- | --- |
| I1 | A system-chosen offer (every slot of an answer: the one shown first and the buffered ones) never repeats an explanation the person has already met, in either format, while an unseen eligible one exists (owner decision on #674: no re-reads except as a last resort). A Region the person opens, a move made inside it, and a link the person follows are their own ask and are not checked. What a person opens while recording is paused is not history, so it is not "met". |
| I2 | When a person qualified enough distinct explanations whose reading proved their facet (two under a system in either format, three over two facets for a planet; a Reel proves its facet only when watched to its end), the system or planet forms within the bounded number of settling drains, no Geography run settles an `insufficient` outcome other than `no_changes`, `disabled` or `no_support_yet` while Personal Context holds trusted supports (a limit, a moved authority or an unreadable context must not happen to a reader who has them), and `no_support_yet` appears only for a person with no coverage references; and no system forms from fewer than two such units. Runs are judged against what the person held when the step began. |
| I3 | No job handler throws while the lab drains, not even one that a retry then recovers; no job anywhere in the database is left unfinished or dead-lettered, whatever its payload names (only the production queues, which the lab never runs, and pg-boss's own bookkeeping are excluded); no Planner or Cartographer run is held queued; every drain settles. |
| I4 | Evidence exists only for exposures the person activated and reported; Personal Context counts qualified units only under topics the person qualified; offers, buffers and demand create no exposure; a pause creates none; another person's step never changes a row of this person's rows in the evidence, Personal Context, Geography, Scenes, Composer, Experience, Planner and Supply tables (a fingerprint of every such table before and after each step, taken only once the neighbour has nothing waiting for a worker); and a reading qualifies exactly when it should (a full read does, a skim, a half-read and an idle tab do not), and a qualified reading holds a coverage reference exactly when it proved its facet (a Reel left at 85-95% qualifies and holds none). |
| I5 | Composer decisions per move, and Geography and Planner runs per activity change (an encounter, a Like or a Save), stay within `config.bounds`. |

I2's thresholds (two units under a system, three Scrolls over two facets for a planet) mirror Geography's formation
policy (`FORMATION` in `invariants.ts`). When slice 2.1 makes them catalogue data, change them there in the same pull
request.

### Known failures

The current dev code breaks some of these. `known-failures.ts` lists them, each keyed by the #674 slice that fixes it,
with the reason it fails and a `matches` that accepts only violations that fail for that reason:

No entry is open today: the last two (planned demand duplicating an open request, slice 1.3; Reel-only evidence forming no
system, slice 5.1) are fixed and deleted.

The lab keeps two promises about them. Every violation of an invariant must be explained by an entry, for a persona it
names (any, if it names none), and for the stated reason, or the run fails ("unexpected violation"), so a new defect, or
a known one failing for another reason, cannot hide behind an entry. And every entry must still be reproduced by the run
as a whole: `gate/known-failures.test.ts` sums the reports of every lab file, so one file that happened to see no
instance cannot fail it, and when a slice fixes the behaviour the entry's test fails with "now fixed" and the same pull
request deletes the entry from `known-failures.ts`. From then on the invariant is a plain gate for the slice and every
later one. That is the equivalent of `it.fails`, with the reason checked. An entry with a `reproducedBy` scenario (the
exoplanets entry: `link-reader-exoplanets`) is judged when that persona ran, so running one file alone is not blamed for the rest.
In CI, and in any local run that wrote every group (`readers`, `formation`, `binge`), the gate instead requires every such
persona to have run and every group to have written a report, so a renamed file or persona cannot make an entry go
unjudged without a word.

I1 has no entry any more: composer policy v2 (#713) offers an explanation the person has met only as a last resort, and the
lab runs under it (and, in its test-only mode, under v3, which keeps the rule). Any I1 violation is therefore a defect in the policy. Its message names the cause the lab read from the
stored decision (`soft_penalty`, `exploration_draw`, `format_sticky`, `retrieval` with the number of candidates the
decision evaluated, or `unknown` when the decision cannot be read as expected), and nothing absorbs it.

No entry, so these are gates: no repeat while something unseen exists (its entry for slice 1.2 was deleted when #713
made policy v2 dev's), planet formation from Scrolls (the exact `link-reader-scrolls`), isolation, pause and resume,
bounded cost, a Planner that survives a reader who has met more than 16 topics (`broad-skimmer`; its entry for
slice 0.1 was deleted when #711 fixed it), and a Planner whose demand for a finished topic leaves no failed or held run
(`link-reader-exoplanets`: the one topic whose recipe Create may still choose; its entry for slice 1.3 was deleted when
#712 stopped an older `ready` row from hiding a waiting one from Supply's lookup). The gate also checks that this persona
still makes the Planner ask Supply for missing content and leaves planned rows, so its pass is not a vacuous one.

### Metrics

Per persona, in `report.json` and `summary.md`: encounters and how many qualified; repeat rate (first offers that were
already met); already-met rate over every offered slot; repeats while unseen (what I1 forbids) and last-resort repeats
(allowed once nothing unseen is left, counted); topic and system diversity; encounters until the first system and the
first planet; empty offers; Composer decisions, Geography runs, Planner runs and their mean decision size; jobs handled
and failed per queue; Planner opportunities and Supply rows by origin and state; and timings (navigation mean and p95,
activation, intake and drain per encounter). Every repeat in the report names its cause.

## What it proves and what it does not

It proves that the real modules, composed as the product composes them, behave according to the invariants for these
readers, on a library of this shape, with a worker that drains cleanly, and it measures how.

It does not prove:

- **Real model quality.** The Planner and the Cartographer are answered by a labelled fixture that builds a valid
  reply from the frozen context (the Cartographer's is an empty proposal, so the rules alone decide what forms). Jev is
  off (the worker config the lab passes sets `jevEnabled: false`). No provider is called and no money is spent.
- **Real people.** Personas are bench patterns of attention, not measured behaviour. A pass says nothing about how people
  read.
- **Content quality or truth.** Every Scroll is the starter document under a fixture identity; every Reel is a valid
  document with no media, whose script is six fixed sentences. A Reel's segment windows are estimated from its words, as
  they are for a published Reel, and a Reel is read by watching it through.
- **Scale.** The 10,000-topic test waits for the catalogue in Postgres (slice 2.1); the topics are still the 17 planets of
  the code catalogue. Large mode (`KS_SIM_SIZE=large`) is as large as is practical on one machine: it passes the
  100-asset retrieval cliff of the discovery lanes, and it is not the design target. Run times and plans here are not
  production latencies.
- **Production.** Create's production job and Supply's resolver need a provider, so a Planner demand that starts them is
  counted (`productionJobsQueued`), not run. Play results and social actions beyond Like and Save are not driven; their
  isolation from evidence is covered by their own module tests.
- **Time.** The lab drains without waiting: it makes delayed and retried jobs due at once (a virtual clock for pg-boss), and
  moves an exposure's stored activation back so a reading's minutes are claimable, as the other integration tests do.
  Pacing (Geography's 30 seconds) is therefore never exercised. After a resume the recorder is on a later generation
  whose session start cannot be moved, so a resumed person can claim only the time that really passed and their
  readings do not qualify.

A passed fixture is evidence for its asserted behaviour, not deployment, real quality or privacy in a live journey.

## Stand-ins

What the lab does not take from the product, so a pass is read for what it covers:

- **The model** behind the reasoning harness: a labelled fixture that never touches a network. Everything around it is
  real: the Planner, Cartographer and buffer consumers are built from the worker's own factories
  (`plannerWorkerProviders`, `cartographerWorkerProviders`, `composerBufferWorkerProviders`), on the recording-aware
  harness with the real owner check of every role.
- **Worker configuration** the lab passes instead of reading an environment: the Planner and the Cartographer are switched
  on (`plannerEnabled`, `cartographerEnabled`), Jev is off, and Create's daily caps are dev's (10 for people, 5 for the Planner).
- **Evidence projections** come from `scrollUseCases`, the composition the other integration tests share, not from the
  worker's provider list. It also binds a legacy prepared-activity read that the worker does not.
- **The library.** Scrolls go through the real editorial import and coverage admission, but their topic attribution is
  inserted by the lab and the semantic review of their coverage is an approval the lab signs. Reel twins are inserted by
  SQL as valid Reel documents with their facts, the provenance of an approved script and no media, because the real Reel
  admission needs Cutroom output and a media file; their coverage is decided by `admitReelCoverage`, the code the Reel
  publication runs. Every document is the starter Scroll under a fixture identity.
- **The queues.** The consumers are listed in `queues.ts`, not derived from the worker's registry (the worker builds it
  inside a Nest provider). `simulationWorld` refuses to start if its consumers differ from that list, and
  `gate/wiring.test.ts` fails if the release declares a queue that is neither drained nor listed with a reason, so a new
  worker queue cannot go undrained by omission. A job that still reaches an undrained queue is reported by I3.
- **Time.** See above: delays are skipped and activation times moved, not waited for.

## Reading a failure

A failing test names the invariant and prints each unexpected violation with its code, the persona, the move or
encounter, and the cause. `report.json` has the full run. To reproduce, set the same `KS_SIM_SEED` (and size): the
personas and every identifier the lab invents are seeded. Exact decisions can still differ between runs, because the
Composer's scores tie up to floating point noise that depends on the clock, so the lab asserts properties that hold on
every run, never exact sequences.

## Adding a persona

1. Add a `PersonaSpec` to `personas.ts`: `encounters`, `reading` and any of `move`, `choose`, `script`, `react`,
   `recording`, `until`. Keep it to decisions a person makes; it must not look at the product's internals.
2. Put it in a test file's plan (`readers.test.ts`, `formation.test.ts`, `binge.test.ts`), or add a file that calls
   `defineLab`. Each file builds its own world and library, and the files run in parallel.
3. Run it. Any violation that no known failure explains fails the run with its message: that is either a defect worth a
   known-failure entry and an issue, or a fixture to fix.

## Flipping a known failure when a slice fixes it

1. Run the lab on the slice's branch. The entry's test fails with "now fixed".
2. Delete the entry from `known-failures.ts`, and its row from the table above, in the same pull request.
3. The invariant is now a gate. If the slice leaves some violations (a different cause), narrow `matches` instead of
   deleting the entry, and say why in `reason`.
4. Record the slice's measure from the report (`repeatRate`, `repeatsWhileUnseen`, `lastResortRepeats`, formation
   timings) in the issue, as the acceptance for #674 asks.

## Adding an invariant

Add its id and statement to `INVARIANTS` in `invariants.ts`, a function that returns `Violation[]` from a
`PersonaResult` (the run plus the `DbSnapshot` of what the database holds), and call it from `evaluate`. `lab.ts` makes a
test for it. If current code breaks it, add a known failure; otherwise it is a gate from the day it lands.
