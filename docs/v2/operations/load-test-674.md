# Load test of the design target (#674, slice 4.4)

The issue's design target is **10,000+ topics, 100,000+ assets, and one person with thousands of topics of history and thousands of
formed places.** This is the measurement of that target on disposable data, on dev at `54eb5a3f` (Composer policy v2 default, incremental
formation, library support check, gap loop, recipes in Postgres; the catalogue is still TypeScript). It was run on 12 Nov 2026 on a
laptop against a throwaway PostgreSQL. It is a measurement of what the code does, not a claim about dev or any hosted server, and not a
change to the code: where a number is bad, the limit and a suggested fix are written down, nothing was optimised here.

**Result.** Two parts of the target are not met, and they are limits, not slowness: a reader cannot hold more than **1,000 places** (formation
stops there, and the Universe and Scenes reads refuse past it), so "thousands of formed places" cannot exist through the real code. Every hot
path that does run is far inside its budget on a quiet machine, with two watch items (a gap scan whose cost grows with the square of the
topics, and a navigation decision that costs about 95 round trips). The tables follow; the harness is
[tests/integration/load/](../../../tests/integration/load/README.md).

```sh
KS_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres pnpm --filter @knowscroll/integration-tests test:load
```

## Environment

| | |
| --- | --- |
| Machine | Apple M4 laptop, 10 logical CPUs, 24 GiB, macOS (Darwin 25.4), Node 22.23.0. Other work was running on it (load average 5 to 11 on 10 CPUs through the day), see [Variance](#variance-between-runs). |
| PostgreSQL | 16.14 (Homebrew), started for the run: `timezone=UTC`, `shared_buffers=512MB`, `effective_cache_size=4GB`, `work_mem=4MB`, `fsync=on`, `synchronous_commit=on`, `jit=on`, `random_page_cost=4`. Data directory on an external SSD. |
| Database | One database cloned from the migrated template (every migration through 0114, pg-boss, ops views), then seeded; `ANALYZE` after seeding. 700 MB (content 658 MB, personal tables 22 MB). |
| Client | One process, one request at a time (latency, not throughput). The application code is called directly (use cases and worker handlers from the same provider lists the API and worker compose), so there is no HTTP, Nest or network hop. Pool of 5 connections, statement timeout 20 s. |
| Everything is warm | The database fits in memory; shared buffers served almost every read (hit counts below). A cold start or a larger database would read more. |

## What the data was

| | Size | How it was made |
| --- | ---: | --- |
| Library assets | 102,001 (60,001 Scrolls, 42,000 Reels; one withdrawn template among the Scrolls) | `insert … select from generate_series`: 60,000 explanation units, each a Scroll and, for 70%, a Reel twin sharing the unit. Every Scroll holds the real compiled starter Scroll (read back after the real import), every Reel a valid Reel document. |
| Topics | 10,000 distinct, 138,000 `encounter_topics` rows | Each unit has a primary topic, 30% also a supporting one. Topic ids are `load.sNNN.tNNNNN`, 100 systems of 100. |
| Released Scrolls | 60,000 coverage heads and region bindings | Every Scroll has an admitted coverage binding (one topic, one of three facets), so the gap scan sees a library of 10,000 planets. |
| Heavy reader | 5,000 met explanations over 5,000 topics; statistics rows for 5,000 topics; 13,332 support keys over 2,400 planets; **998 places formed by the real code (989 when it stopped, 9 more from three runs that fitted), 7,248 stored after 6,250 were written by SQL** | Lineage and statistics by SQL; places formed by real Cartographer runs until they stopped, then the rest of the planets' places written by SQL. |
| Light readers | 1,000, with 8 met explanations each | Real sign-in (account, universe, recording policy) and SQL history. |
| A reader below the limit | 280 planets, 753 places, formed by real runs | For the cost of runs that create places. |
| A reader with the real catalogue formed | 17 planets, 82 places, formed by real runs | For the Universe and Scenes reads, which only answer for the code catalogue. |

### What was synthetic, exactly

- **Every library row and every reader's history is a labelled fixture** written by SQL (ids from `md5`, titles `Load unit n`). Nothing was written
  by a model, a person or a provider, and no provider, model or network call was made. The projections' rows (exposure and lineage,
  `topic_context`, `topic_format_cells`, Personal Context `topics`, `coverage_supports`) were written directly, not produced by qualifying
  thousands of encounters; the navigation runs confirm the real code honours them (753 offers, none an explanation the reader had met).
- **The catalogue is still code (17 topics).** Retrieval, Evidence and Personal Context accept any topic id, so the 10,000 topics are real to
  them. Formation is tied to the catalogue: the Cartographer's `catalogue` port was replaced by a generated catalogue of 10,000 planets, and its
  trusted read is a fixture that vouches for the support rows the seed wrote (the real certificate checks have their own suites). Everything
  else in a run is real, including the reasoning harness with a fixture model that answers the normal empty proposal. This is the pattern
  of `modules/incremental-formation.test.ts`.
- **The Universe read and Scenes cannot be given a catalogue**: they validate stored places against the code catalogue. They are measured for the heavy
  reader (what they answer for thousands of synthetic places) and for the reader whose real catalogue is formed (what they answer when they can).
- **The gap scan's catalogue is code**, so its in-memory structural pass saw 17 planets; its SQL read saw all 60,000 bindings.
- **Not measured:** the client's map load and level of detail, HTTP/Nest and network latency, concurrent load, Jev and model calls, the Planner's
  full run, the quiet sweep, Clear and erasure at this size, and a cold cache.

## Results

Statistic for each budget in the last columns; **p50 / p95 / max** are milliseconds over `n` samples. Run of 12 Nov 10:08 UTC (the fourth; see
[Variance](#variance-between-runs)), generated by the harness.

| Path | n | p50 ms | p95 ms | max ms | Budget | Result |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| Composer v2 vertical decision, heavy reader | 250 | 84 | 93 | 100 | navigation: p95 ≤ 300 ms | pass |
| Composer v2 vertical decision, light readers | 250 | 76 | 81 | 91 | navigation: p95 ≤ 300 ms | pass |
| Buffer preparation, heavy reader | 60 | 74 | 83 | 98 | none set | n/a |
| Buffer preparation, light readers | 60 | 84 | 112 | 124 | none set | n/a |
| Formation run after one new reading, heavy reader (a topic whose places are formed) | 30 | 45 | 47 | 48 | formation run: p95 ≤ 2000 ms | pass |
| Formation run after one new reading, heavy reader (a planet would be created) | 30 | 92 | 97 | 98 | formation run: p95 ≤ 2000 ms | pass, but 27 of 30 refused (`limit`) |
| Formation run after one new reading, reader below the limit (a planet and its regions are created) | 30 | 59 | 63 | 65 | formation run: p95 ≤ 2000 ms | pass |
| Formation run after one new reading, heavy reader with all 7,248 places stored | 30 | 2.7 | 3.0 | 3.1 | formation run: p95 ≤ 2000 ms | pass in time, **30 of 30 refused** (`structure_limit`) |
| Formation catch-up of 2,400 planets (every topic dirty) | 1 | 44,576 | | | none (one-time) | **stopped at 989 places, 2,032 topics still dirty** |
| Universe read, heavy reader (7,248 places) | 30 | 2.1 | 2.5 | 3.7 | sky read: p95 ≤ 500 ms | **fails: answered `unavailable/limit` 30 of 30** |
| Universe read, reader with the real catalogue formed (82 places) | 30 | 0.9 | 1.4 | 1.5 | sky read: p95 ≤ 500 ms | pass (`ready`) |
| Scenes manifest read, heavy reader | 30 | 2.1 | 2.4 | 2.8 | sky read: p95 ≤ 500 ms | **fails: `unavailable`, nothing projected** |
| Scenes manifest read, real-catalogue reader (+ one chunk read p50 1.3, p95 1.7) | 30 | 3.1 | 3.5 | 4.2 | sky read: p95 ≤ 500 ms | pass |
| `geography dry-run`, heavy reader (every topic dirty) | 5 | 0.9 | 1.3 | 1.3 | none set | n/a |
| `geography dry-run`, light reader | 5 | 0.9 | 1.0 | 1.0 | none set | n/a |
| `planner dry-run`, heavy reader | 5 | 32 | 41 | 41 | none set | n/a |
| `planner dry-run`, light reader | 5 | 30 | 31 | 31 | none set | n/a |
| Gap loop scan, first (100,000 uncounted marks to count) | 1 | 1,730 | | | gap scan: ≤ 5000 ms | pass |
| Gap loop scan, later (marks counted) | 4 | 1,377 | 1,445 | 1,445 | gap scan: ≤ 5000 ms | pass |

A budget is judged on the numbers; the shortfalls that matter are not about time. The Universe and formation rows that "pass" in time are
refusals: a fast `limit` is not a read or a formation.

### The slowest statement of each path

Every statement the path sent was captured (text, parameters, wall time), the slowest one was replayed under `EXPLAIN (ANALYZE, BUFFERS)` in a
rolled-back transaction, and the shapes that took the most total time are listed. The replay is a warm repeat: its execution time is the plan's,
the "seen" time is what the path measured. Plans are in `tests/integration/load/output/measurements.md` after a run.

| Path | Statements in the sample | All statement time ms | Slowest seen ms | Replay execution ms | Rows (top node) | Shared buffers hit / read |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Decision, heavy reader (250 decisions) | 23,787 | 10,643 | 13 | 4.5 | 100 | 6,626 / 0 |
| Decision, light readers (250) | 23,828 | 9,429 | 12 | 4.4 | 100 | 5,610 / 0 |
| Buffer preparation, heavy (60) | 2,444 | 2,079 | 12 | 2.3 | 1 | 318 / 5 |
| Buffer preparation, light (60) | 2,338 | 2,317 | 14 | 4.8 | 100 | 4,623 / 0 |
| Formation run, formed topic (30) | 6,360 | 1,144 | 3.8 | 4.2 | 1 | 2,023 / 0 |
| Formation run, creation refused at the limit (30) | 7,062 | 2,112 | 6.2 | 14 | 16 | 3,089 / 0 |
| Formation run, creation below the limit (30) | 7,020 | 1,159 | 3.1 | 3.4 | 1 | 2,228 / 0 |
| Formation run, 7,248 places stored (30) | 660 | 75 | 0.6 | 0.2 | 0 | 49 / 0 |
| Universe read, heavy (30) | 240 | 60 | 2.3 | 0.7 | 1,001 | 1,024 / 0 |
| Universe read, real-catalogue reader (30) | 300 | 21 | 0.7 | 0.1 | 82 | 148 / 0 |
| Scenes manifest, heavy (30) | 330 | 59 | 1.8 | 0.8 | 1,001 | 1,024 / 0 |
| Scenes manifest, real-catalogue reader (30) | 540 | 41 | 0.4 | 0.01 | 1 | 1 / 0 |
| `geography dry-run`, heavy (5) | 55 | 3.8 | 0.3 | 0.4 | 1 | 227 / 0 |
| `planner dry-run`, heavy (5) | 140 | 73 | 6.0 | 2.6 | 100 | 2,685 / 0 |
| Gap scan (5 scans) | 145 | 1,759 | 232 | 232 | 1 | 121,562 / 494 |

The limiting statements, by total time in each path:

- **Decision.** Two statements of the retrieval lanes per decision (`discovery-store.ts`, `laneAssetIds`) take 7 ms each (3,485 ms over 500 calls for
  the heavy reader), the hydration of the candidates (`rows`, 9 calls per decision, 3,062 ms over 2,269) 12 ms per decision, the decision insert 2 ms.
  The 5,000-id met list the heavy reader sends costs little (heavy is within 15% of light at p95), because retrieval stops at its lane limits.
  Statement time is 43 ms of the 84 ms median (10,643 ms over 250 decisions): the rest is spent in the process, where a decision reads and
  schema-checks up to 100 candidate documents (`canRender` in `discovery-store.ts`) and ranks them. That share was not profiled separately.
- **Formation.** The frozen-context read of the dirty topic (`with named as (select topic_id from personal_context.coverage_supports …`) is the largest
  shape, 2 ms a call; a run is about 60 statements. A run reads one topic (max 1 topic evaluated, context 12 to 49 KB), not the 2,400.
- **Gap scan.** Statement time is 1.76 s over the five scans together (the count of the first scan's marks, 1,109 ms, and the two library
  aggregates, 112 ms a scan). The scans themselves took 7.6 s: about 1.3 s of each is **in the process, not SQL** (see shortfall 4).

## Shortfalls

### 1. A reader's formation stops at 1,000 places: the target's "thousands of formed places" cannot exist (not met)

The heavy reader has support for 2,400 planets and the catalogue holds 10,000. The explicit request marked all 2,400 topics dirty; 174 runs of
16 topics each (44.6 s, 255 ms a run) formed **989 places (327 planets, 654 regions, 4 systems, 4 stars)** and then no run was pending: 2,032 topics
stayed dirty, with nothing to wake them. The last runs record `stale` / `limit`. Afterwards a reading that would create a place is refused (27 of 30
`limit`; 3 fit in the remaining room), and once a reader holds more than 1,000 places even a reading of a formed topic is refused before any work
(`insufficient` / `structure_limit`, 2.7 ms). The 7,248 places in the heavy reader's final state were written by SQL; no run made them.

- **Limiting code:** the 1,000-object bound in `geography/application/apply.ts:228` (`prepared.structure.objects + added.objects > 1000` → `limit`),
  `application/context.ts:705` (`structure_limit`), the `limit 1001` of `geographyStore.structure` and `view`, and the same constant in `read.ts:40` and
  `scene-input.ts:12`. The issue lists it ("1000 objects, 100 routes, 100 supports, 1000 references: each silently stops or truncates").
- **Not a speed problem:** below the limit a run creating a planet and two regions takes 59 ms p50, 63 ms p95 (753 places stored).
- **Suggested fix:** slice 4.3 should make the bound per system (read and write a system's places, never the universe's), keep the dirty topics
  that a `limit` refusal leaves in a state the next run can resume from (today they wait with no run), and report a reader at its bound in the
  Operator screen instead of settling quietly.

### 2. The Universe read and Scenes refuse past 1,000 places and for any concept outside the code catalogue (not met)

For the heavy reader (7,248 places) the Universe read answers `unavailable` / `limit` in 2 ms, 30 of 30; the Scenes manifest answers `unavailable`
and the projection (`scenes.project`) returns after 3 ms and 10 statements. Both read at most 1,001 objects (`select … from geography.objects … order by id
limit 1001`, 1,024 buffers) and refuse. Below the bound and with places valid for the code catalogue (the real-catalogue reader, 82 places) they answer
`ready` in 1.4 ms p95 (Universe) and 3.5 ms p95 (manifest) with a chunk read of 1.7 ms p95.

- **Limiting code:** `read.ts:40` (`view.objects.length > 1000 … 'limit'`), `read.ts:71` (more than 100 routes or aliases → `limit`), `scene-input.ts:12`,
  and `validView` against `PRODUCT_CATALOGUE` (a place whose concept the code catalogue lacks makes the read `temporarily_unavailable`; seen at 337
  places in the small run). Slice 2.1 (catalogue in Postgres) and slice 4.3 (sky read plus per-system chunks) are the fix; this test is the
  baseline they should beat with 7,248 places and 10,000 topics.

### 3. The catalogue is code, so the target size is only reachable by injection (limit of this test)

A 10,000-topic catalogue could only be given to the Cartographer's port. Everything that reads the code catalogue (the Universe read, Scenes, the
gap scan's structural pass, coverage admission) sees 17 topics. Re-run this test unchanged after slice 2.1; its sections for those paths are
then measuring the product, and the injection in `load/formation.ts` can go.

### 4. The gap scan grows with the square of the topics (watch; passes at 1.4 to 2.1 s of 5 s)

A scan takes 1.4 s once its marks are counted (1.7 s the first time, which counts 100,000 marks in 1.1 s of SQL). Its SQL is 0.11 s: the two aggregates
over `region_bindings` (260 and 294 ms over five scans). The rest is `readReleasedCoverage` in `content/adapters/gap-reads.ts`, which pairs each planet
with its facets by filtering the whole facet list once per planet (`facets.rows.filter((facet) => facet.topic_id === row.topic_id)` inside
`planets.rows.map`): 10,000 planets × 60,000 facet rows is 6×10⁸ comparisons. Replayed on its own at that size, the loop takes seconds (2.9 s on the busy
laptop) and a `Map` takes 5 ms, the same order as the 1.3 s each scan spends outside SQL; the scan was not profiled directly. It reaches the 5 s budget at about 20,000 topics with 120,000 released Scrolls, well inside the design's "10,000+". The scan runs every
fifteen minutes under an advisory lock, so this is waste before it is an outage.

- **Suggested fix:** group the facets by topic in one pass (a `Map`), or return them already grouped from SQL (`array_agg … group by topic_id`); and
  compute the two aggregates in one read (`grouping sets`). Neither is done here.

### 5. A navigation decision is about 95 round trips (watch; passes with 3x margin on a quiet machine)

A vertical decision sent 95 statements to PostgreSQL (transaction plumbing included): 84 ms p50 and 93 ms p95 for the heavy reader, 81 ms p95 for light
readers on a quiet machine, against a 300 ms budget. Three things follow from the count: a database not on the same machine adds its round trip to each of
the 95 (at 2 ms each, about 190 ms on top of the 84, so 274 ms of the 300); the one run made while the laptop was busy (see below) gave p95 587 ms for
the heavy reader; and the buffer preparation, which runs the same retrieval, costs about as much (74 to 84 ms) off the
request path. Reading the retrieval and hydration statements (above) as the cost drivers, the fix is fewer, wider statements and fewer scoped
re-checks per decision, not new indexes: the slowest statement replays in 4.5 ms with 6,626 buffers hit and no reads.

### 6. Nothing here is a shortfall in what was budgeted and measured

Formation after one new reading (45 ms p50 and 47 ms p95 for a formed topic; 59 and 63 ms for a creation below the limit) and the Universe/Scenes reads for
a reader they can answer (1.4 and 3.5 ms p95) are 40 to 350 times inside their budgets; the dry-run commands are 1 ms (geography; its statements are consistent with stopping at the structure
count for a reader over the limit) and 32 ms (planner, which reads the exploration snapshot and one retrieval).

## Variance between runs

The laptop was shared (other agents' databases and workers, indexers; load average 5 to 11 on 10 CPUs). The same code and data gave:

| Run | Library seed | Heavy decision p50 / p95 ms | Light decision p50 / p95 ms | Gap scan first / later ms | Catch-up |
| --- | ---: | --- | --- | --- | ---: |
| 1 (earlier harness) | 20.8 s | 97 / 120 | 89 / 105 | 2,054 / 1,788 | 41.5 s |
| 2 (machine busy) | 134.7 s | **252 / 587** | 79 / 90 | 2,086 / 1,929 | 50.1 s |
| 3 | 20.3 s | 110 / 146 | 104 / 145 | 1,502 / 1,546 | 33.8 s |
| **4 (reported)** | 19.0 s | 84 / 93 | 76 / 81 | 1,730 / 1,445 | 44.6 s |

Run 2 is the only one that fails the navigation budget, and it is the one in which the seed also took seven times as long: contention, not the data.
The headroom is therefore about 2 to 3 times on a quiet machine, and none under heavy contention: see shortfall 5. Formation and the Universe numbers moved by
less than a factor of 1.5 across runs.

## How to read this against the issue's acceptance

"Design target met in the load test, or each shortfall stated with its limit": **not met**, with the limits stated above (1 and 2 are the target's
own numbers: more than 1,000 places; 3 is the test's limit; 4 and 5 are watch items with measured headroom). The budgets in the brief (navigation p95 ≤ 300 ms,
formation run ≤ 2 s, sky read ≤ 500 ms, gap scan ≤ 5 s) are met where the code answers, and the paths that answer by refusing are named.

Re-run the test after slices 2.1, 4.3 and 4.2 land, and copy the new tables here with the date and the environment. The raw output of a run
(`measurements.md`, `results.json`, with every plan) is written to `tests/integration/load/output/` and is not committed.
