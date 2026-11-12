# Load test of the design target (#674, slice 4.4)

Seeds a disposable PostgreSQL with the issue's design target (10,000+ topics, 100,000+ assets, one reader with thousands of topics of
history and thousands of formed places, about a thousand light readers), then times the hot paths through their real application code and
writes the numbers. Results and shortfalls are recorded in [docs/v2/operations/load-test-674.md](../../../docs/v2/operations/load-test-674.md).

It is **not** part of `test`, `test:simulation` or any CI job: it takes tens of minutes and leaves a database of a few gigabytes. It
records; it asserts nothing about speed (a missed budget is a finding in the report, not a red test).

## Run it

From the repository root, on a disposable PostgreSQL 16 server (`TimeZone` UTC) that is yours to fill:

```sh
KS_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres \
  pnpm --filter @knowscroll/integration-tests test:load
```

| Variable | Meaning |
| --- | --- |
| `KS_TEST_DATABASE_URL` | The disposable server, as for the rest of the suite (a role that may create databases; the seed also needs to own the tables, so a superuser on a throwaway server). Never point it at dev, stage or the owner's databases. |
| `KS_LOAD_SIZE` | `target` (default): 60,000 units, 10,000 topics, about 102,000 assets, 1,000 light readers, a heavy reader with 5,000 met explanations and 2,400 planets. `small`: a minute-long smoke run of the same code, for a change to this directory. |

The run writes `output/measurements.md` and `output/results.json` (git-ignored) next to the test. `docs/v2/operations/load-test-674.md` is
that report with the shortfalls written up; copy new numbers into it when you re-run on the same footing.

## What it does

| File | Role |
| --- | --- |
| `config.ts` | The two sizes and the synthetic topic naming. |
| `seed.ts` | Bulk seeding by SQL (`insert … select … from generate_series`): the library, readers' history, support rows. |
| `formation.ts` | A formation fixture over a catalogue of any size, and a Cartographer runner (the pattern of `modules/incremental-formation.test.ts`). |
| `worker.ts` | The worker's buffer preparation and Scenes, composed from the same provider lists the worker and API compose. |
| `measure.ts` | Percentiles, timing, statement capture (wraps `pg.Client.prototype.query`), and `EXPLAIN (ANALYZE, BUFFERS)` of the slowest statement of a path. |
| `report.ts` | The tables of the report. |
| `load.test.ts` | Orchestration: seed, then one `it` per path. |

Paths timed: the Composer v2 vertical decision (heavy reader, light readers), the worker's buffer preparation, one Cartographer run after one
new qualified reading (steady state, and a run that creates a place), the one-time catch-up of every topic, the Universe read and the Scenes
manifest and chunk reads, `geography dry-run` and `planner dry-run`, and the gap loop's scan. Each path's slowest statement is replayed under
`EXPLAIN (ANALYZE, BUFFERS)` in a rolled-back transaction on its own connection (a warm repeat: its time is the plan's, the path's own time is
in the table).

## What is synthetic (and what is not)

- **The library** is bulk-inserted: ids are `md5`-derived, titles say `Load unit n`, every Scroll carries the real compiled starter Scroll's
  document (read back from the database after the real import) and every Reel a valid Reel document with no media. Topics are
  `load.sNNN.tNNNNN` strings over a hundred synthetic systems. Nothing was written by a model or a person.
- **The topic catalogue in Postgres holds the 17 topics of release 1** (D-419). The library, retrieval, Evidence and Personal Context
  accept any topic id, so the 10,000 topics are real to them. Formation and the Universe read are tied to the seeded catalogue, so the
  Cartographer's `catalogue` port is replaced by a fixture release (`fixtureSnapshot`) of 10,000 planets and its trusted read is a
  labelled fixture that vouches for the support rows the seed wrote (Content's and Evidence's real certificate checks have their own suites).
  Everything else in a run, including the model harness with a fixture model, is the real code. The Universe read and Scenes, which cannot
  be given a catalogue, are measured twice: for the heavy reader (what the code answers for thousands of synthetic places) and for a reader
  whose whole real catalogue is formed (what it answers when it can answer).
- **The gap scan** walks the seeded catalogue's 17 planets in memory (it is given release 1 through `readCatalogue`) but reads the whole
  library's coverage by SQL; the 10,000-topic synthetic catalogue is not given to it.
- **Readers' history** is written by SQL rows of the shape the projections write (an exposure and its lineage; `evidence.topic_context`,
  `topic_format_cells`, `personal_context.topics`, `coverage_supports`), not by qualifying thousands of encounters. The navigation checks
  confirm the real code honours it (offers never repeat an explanation the reader has met).
- **Statistics** are gathered (`ANALYZE`) after seeding, as autovacuum would have by the time a table that size exists.

## Environment notes

The numbers belong to the machine and server settings the report names (a laptop, a PostgreSQL started with `shared_buffers=512MB`, the
default `work_mem`, data on an external SSD). They show where a path's cost comes from and how it grows, not a hosted server's latency.
The statement timeout of the suite's test databases (20 s) applies to every measured path; the seed uses its own connection without one.
