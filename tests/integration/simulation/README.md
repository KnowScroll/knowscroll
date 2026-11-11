# Algorithm simulation lab

Synthetic readers ("personas") use the real backend against a disposable PostgreSQL, the worker's jobs are drained as the
worker would run them, and every run is judged against product invariants and measured. It exists so that problems in
recommendation, planet formation and new-content demand are caught before a live reader meets them, and it is the gate
that every later slice of [#674](https://github.com/KnowScroll/knowscroll/issues/674) must pass.

Status: implemented, runs in hosted CI (`simulation` job in `checks.yml`) on every pull request.

## Run it

| Command from the root | What it does |
| --- | --- |
| `pnpm --filter @knowscroll/integration-tests test:simulation` | Small mode, the one CI runs. Needs `KS_TEST_DATABASE_URL` for a disposable PostgreSQL 16 (see the [suite README](../README.md)). |
| `KS_SIM_SIZE=large pnpm --filter @knowscroll/integration-tests test:simulation` | Large mode, for a manual or nightly run on one machine: about 170 Scrolls and longer sessions. |
| `KS_SIM_SEED=7 KS_SIM_POLICY=v0 … test:simulation` | Another seed, or the other Composer policy (`v1` is the default because dev runs `KS_COMPOSER_POLICY=v1`). |

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
invariants.ts, known-failures.ts   judge the run
metrics.ts, report.ts              measure it and write the reports
```

1. **A library.** For each of the catalogue's planets (the 17 topics of the code catalogue) the lab admits several
   explanation units across the planet's facets, through the editorial import (the starter Scroll under a fixture
   identity) and the real coverage admission, attributes them to the planet, and gives the first two units of each planet, and some of
   the others, a Reel twin that shares the unit. Ids and titles are fixtures: `ci-sim-<planet>-<n>` and `[CI sim] …` (the editorial grammar has no dots
   and refuses digits in a title). Nothing was written by a model.
2. **A world.** `simulationWorld` builds the Experience navigation and activation, Evidence intake, Personal Context,
   Region encounters, and the consumers the worker registers (evidence projections, the Composer's buffer, the Planner,
   the Cartographer, Scenes) from the same provider factories the API and the worker compose. No algorithm module is
   mocked. The stand-ins are the labelled fixture model behind the reasoning harness (it never touches a network) and
   the absence of production: Planner demand that reaches Supply's resolver or the production job is counted, not run.
3. **Personas** (`personas.ts`) decide what a person does next: which move, which offer, how to read it. A seeded random
   source (`rng.ts`) draws their choices and every identifier the lab invents. Reading timings come from each
   document's own reading facts (a Scroll's estimated reading time and block weights, a Reel's duration), and the
   recorder's claims are shaped like the app's.
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
| `reel-watcher` | Starts on a Reel and stays in Reels | Format stickiness, Reel evidence |
| `link-reader-reels` | Follows two shared links to Reels of one system and watches both | A Reel-only reader forming a system (exact) |
| `link-reader-scrolls` | Follows links to three Scrolls of one planet over two facets | A planet forming (exact) |
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
| I1 | A system-chosen offer (every slot of an answer: the one shown first and the buffered ones) never repeats an explanation the person has already met, in either format, while an unseen eligible one exists (owner decision on #674: no re-reads except as a last resort). A Region or a link the person opens is their own ask and is not checked. What a person opens while recording is paused is not history, so it is not "met". |
| I2 | When a person qualified enough distinct explanations (two under a system in either format, three Scrolls over two facets for a planet), the system or planet forms within the bounded number of settling drains, and no Geography run settles `coverage_unavailable` while Personal Context holds trusted supports. |
| I3 | No failed or dead-lettered job, no Planner or Cartographer run held queued, every drain settles. |
| I4 | Evidence exists only for exposures the person activated and reported; Personal Context counts qualified units only under topics the person qualified; offers, buffers and demand create no exposure; a pause creates none; another person's step never changes a row of this person's evidence or places (a fingerprint of every personal table before and after each step); and a reading qualifies exactly when it should (a full read does, a skim, a half-read and an idle tab do not). |
| I5 | Composer decisions, Geography runs and Planner runs stay within `config.bounds` per activity change (an encounter, a Like or a Save). |

I2's thresholds (two units under a system, three Scrolls over two facets for a planet) mirror Geography's formation
policy (`FORMATION` in `invariants.ts`). When slice 2.1 makes them catalogue data, change them there in the same pull
request.

### Known failures

The current dev code breaks some of these. `known-failures.ts` lists them, each keyed by the #674 slice that fixes it,
with the reason it fails and a `matches` that accepts only violations that fail for that reason:

| Entry | Invariant | Slice | Why it fails today |
| --- | --- | --- | --- |
| `I1/already-met-is-a-soft-penalty` | I1 | 1.2 | Nothing hard-excludes a met explanation. It costs a novelty term, so a met unit still wins while an unseen one exists (the lab reads the stored decision: the met unit was eligible and scored higher, or exploration drew it, or sticky format kept the person among met units of the format). |
| `I2/reel-only-evidence-forms-no-system` | I2 | 5.1 | A Reel has no coverage mapping or certificate; the trusted read serves only Scrolls. Two qualified Reels of one system form nothing. |
| `I3/planner-crashes-past-sixteen-topics` | I3 | 0.1 | The Planner passes up to 100 recent topics to a discovery read that refuses more than 16 (`DISCOVERY_QUERY_INVALID`): the job dead-letters and the run stays queued. |

The lab keeps two promises about them. Every violation of an invariant must be explained by an entry or the run fails
("unexpected violation"), so a new defect, or a known one failing for another reason, cannot hide behind an entry. And
every entry must still be reproduced: when a slice fixes the behaviour, the entry's test fails with "now fixed", and the
same pull request deletes the entry from `known-failures.ts`. From then on the invariant is a plain gate for the slice
and every later one. That is the equivalent of `it.fails`, with the reason checked.

Not yet failing, so they have no entry: planet formation from Scrolls (the exact `link-reader-scrolls`), isolation,
pause and resume, bounded cost.

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
  reply from the frozen context. Jev is off (the worker config the lab passes sets `jevEnabled: false`). No provider
  is called and no money is spent.
- **Real people.** Personas are bench patterns of attention, not measured behaviour. A pass says nothing about how people
  read.
- **Content quality or truth.** Every Scroll is the starter document under a fixture identity; every Reel is a valid
  document with no media.
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
