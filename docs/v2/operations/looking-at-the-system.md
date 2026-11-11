# Looking at the system

How to see what the running system did, without a database prompt and without reading anyone's text.
Decision D-044; module README `packages/backend/src/modules/operator/README.md`.

What you can see is IDs, states, times, counts and codes. Prompts, model answers, request and message
text, Reel scripts, addresses and scores are never in these views.

## Who may look

The Operator screen and its API routes are for the accounts a world names in `KS_OPERATOR_ACCOUNTS`
(`<world>.v2.env`): a comma-separated list of addresses, each one exact or with one `*` in the local
part. Everyone else, and anyone signed out, gets "This page isn't here" and the server answers 404.

- **dev:** if the list is unset and operator sign-in is on, every `*@test.knowscroll.space` account is
  an operator. Sign in as one with `issue-sign-in` (`environments.md`, "Operator sign-in").
- **stage and live:** unset means nobody. Name the owner's address. A wildcard is refused on live.

Change the list, restart the API (`ks2-api@<world>`), and the next request is checked against it.

## The Operator screen

Open `https://app.dev.knowscroll.space/operator` signed in as an operator. Nothing in the app links to it.

| Panel | Reads | Use it to |
|---|---|---|
| 1 System overview | queue backlog, model attempts of the last 24 h, recent errors | See a queue that is not draining (oldest wait), failed jobs, unknown outcomes. |
| 2 Journey search | one record's steps across modules | Paste an ID, or press Journey on a row. |
| 3 Content production | production runs, refused writer answers, Reel orders | See why a Scroll was not published and what a Reel order has claimed or settled. |
| 4 Universe change | Cartographer runs of the last 7 days | See runs by state and their outcome codes. |
| 5 Realtime delivery | nothing | Unavailable: hints leave no record. |
| 6 Privacy & diagnostics health | clear, deletion and export operations; retention jobs | See an operation that failed or never finished, and when each sweep last ran. |

Service health, request latency, media disk and dropped diagnostics are shown as unavailable. Tier 0 has
no source for them; use `journalctl` (below) and `df`.

## One record's journey

On the server, from the world's **worker** tree, with the same shell pattern as the reasoning commands
(`environments.md`):

```sh
node dist/operator.js journey <id>
node dist/operator.js journey --account <accountId>
node dist/operator.js journey <id> --json
```

`<id>` is a request, production run, Reel order, model attempt, reasoning run, exposure, asset or
universe ID. Exit 0 found, 2 not found or bad usage, 1 failure. Output is one line per step: time (UTC),
`personal` or `shared`, stage, state, code, label, how long it took, the record's ID. Then the gaps.

What to expect:

- A request shows its shared group, the production run of its recipe, the model attempts, any refused
  answer and the admitted Scroll. Several requests that waited on one group stay apart: you see only
  the one you asked about.
- A production run shows shared records only: no request and no person.
- An asset shows its shared steps only (admission, production, Reel order). What people did with it is
  not part of an asset's journey.
- `--account` starts from a person's whole journey, newest 300 steps. Use it on disposable accounts,
  or when someone asked for help. The screen has no account search on purpose.
- A **gap** line is the records saying less than you hoped. `Outcome unknown` is a model attempt whose
  outcome nobody knows: it is never sent again, and `reasoning write-off` or `reel write-off` closes it.
  `Started, and no completion has been recorded` is a step older than 30 minutes with no end.

Worked example: "Asha's Scroll never appeared". Take her request ID from the Requests screen or from
`ops.recent_errors`. `journey <requestId>` shows `supply.request` preparing, the group, the
production run, and where it stopped (a refused answer, an unknown attempt, or no run at all). The text
she asked for is not in any of it.

## SQL and Grafana

Create the SELECT-only role once for the cluster (the world roles cannot create roles):

```sh
sudo -u postgres psql -c 'create role ks2_ops_reader nologin'
sudo -u postgres psql -c "create role <grafana login role> login in role ks2_ops_reader"   # set its password out of band
sudo -u postgres psql -c "alter role ks2_ops_reader set statement_timeout = '30s'"
```

The statement timeout is inherited by the login role. It keeps a long dashboard query from holding the
views while a deploy rebuilds them (the deploy also gives up on a lock after a few seconds and tries again).
The world's database refuses CONNECT from everyone but the world's role; `migrate.js` grants `ks2_ops_reader`
CONNECT on it together with the views, so the login role connects after the next deploy.

The next deploy's `migrate.js` grants `ks2_ops_reader` the views (a missing role is only a warning in
its output: `migrate.warning`, `ops_reader_role_missing`). To grant now, run `migrate.js` again.

The role may select `ops.business_runs`, `model_attempts`, `production_runs`, `rejected_answers`,
`reel_orders`, `reel_attempts`, `geography_runs`, `privacy_operations`, `jobs`, `queue_backlog`,
`recent_errors` and `watchdog`. It cannot select `ops.journey_events` (scoped IDs), any table or pg-boss's own tables.
Examples:

```sql
select queue, ready, retrying, failed, oldest_waiting_seconds from ops.queue_backlog order by oldest_waiting_seconds desc nulls last;
select occurred_at, source, state, code, label from ops.recent_errors order by occurred_at desc limit 20;
select state, count(*), sum(coalesce(input_tokens,0)+coalesce(output_tokens,0)) as tokens
  from ops.model_attempts where reserved_at > now() - interval '24 hours' group by state;
select script_name, attempts, settled_cents, claimed_open_cents from ops.reel_orders;
```

Dashboards and saved queries belong in `ops/observability/` when Grafana is installed. None exist yet.

## What a run would do: the dry runs

Before and after a fix to the Cartographer or the Planner, ask what one run would do for one universe, without doing it
(#674, D-411). From the worker tree, with `KS_WORLD` and `DATABASE_URL` (and `KS_CARTOGRAPHER_ENABLED` /
`KS_PLANNER_ENABLED` set as the worker has them, so the answer says whether the role would be off):

```sh
node dist/operator.js geography dry-run --universe <uuid>
node dist/operator.js planner dry-run --universe <uuid>
```

Each prints one JSON line. It enters the universe's personal scope (the root lock a read takes), but in a READ ONLY
transaction that is always rolled back: no row is written and no job is sent. It freezes the same context a real run
freezes and applies the same rules; **no model is called**. The line holds counts and codes only, so it is safe to paste into
a public issue: never a label, title, topic, unit, reference or text.

- `geography dry-run`: `outcome` is what a reading-triggered run would do (`calls_model`, `applies_by_rules`,
  `settles_no_changes`, `context_unavailable`, `context_limit`, `disabled`, `recording_paused`, `not_runnable`,
  `would_fail`); `wouldRecord` is the status and outcome the run row would hold; `unavailableReason` names why no context
  can be frozen (`no_references`, `discovery_limit`, `not_observed`, `trusted_limit`, `trusted_changed`, `object_limit`,
  `route_limit`, `context_size`); `references` counts the keys discovery found, the trusted references read, the distinct
  supports and how many compaction kept; `due` counts the places the rules entitle by kind and how many one delta applies;
  `activityChanges` counts places due to go quiet or active again; `contextBytes` is the frozen context's size.
- `planner dry-run`: `outcome` is `calls_model`, `insufficient_evidence`, `proof_unavailable`, `context_bounds`,
  `disabled`, `recording_paused` or `not_runnable`; it counts the topics in the frozen context, the topic bound the
  inventory read was given, the inventory items and evidence references, and the context's bytes.

Exit 0 read, 2 refused (usage, unknown or suspended universe), 1 failure. It waits for the root lock like any read and
gives up after five seconds. Running it twice changes nothing.

## The watchdog

Once an hour the worker runs `operator.watchdog`: code-only health rules over `ops.watchdog`. A rule that fires logs a
`watchdog.alert` warning (`reasonCode`, `count`, `windowSeconds`, and a queue, module or outcome code where it applies);
nothing is repaired and no person or record is named. `watchdog.rule_skipped` names a rule whose read failed. The rules
and their thresholds are in `WATCHDOG_THRESHOLDS` (`modules/operator/domain/watchdog.ts`):

| Alert (`reasonCode`) | Fires when | Threshold |
|---|---|---|
| `dead_lettered_jobs` | a queue has jobs in its dead-letter queue | 1 or more in the last 3 hours, per queue |
| `failed_jobs_repeating` | a queue's jobs fail with the same code | 5 or more in the last 6 hours |
| `personal_runs_held` | a Planner or Geography run is still `queued` or `prepared` and its row has not moved | for 1 hour |
| `geography_unavailable_repeating` | a universe with coverage references has its latest 3 settled Cartographer runs end on the same unavailable reason | 1 or more universes, seen in the last 7 days |
| `composer_repeat_offered` | a `composer-policy.v2` decision offered an explanation the person has met while it records an eligible unseen candidate | 1 or more in the last 24 hours (never fires before v2 exists) |
| `unknown_attempts_old` | a model attempt is still `unknown` | for 6 hours |

Find an alert: `journalctl -u ks2-worker@<world> | grep watchdog.alert`. Then follow the code: a dead letter or a repeated
failure is `select * from ops.jobs where queue = '<queue>'`; a held run or a repeating universe is a `dry-run`; an old unknown
attempt is `reasoning unknown`. `select * from ops.watchdog order by observed_at desc limit 50` shows the observations the rules
read (the role `ks2_ops_reader` may select it).

## Logs

The journal holds operational events without personal IDs, for about 14 days within its disk quota:

```sh
ssh knowscroll-vps journalctl -u ks2-api@dev -u ks2-worker@dev --since -15min
journalctl --disk-usage          # and the oldest record: journalctl -u ks2-api@dev --reverse | tail -1
```

Say the oldest record you actually have; do not promise 14 days. `operator.read` and `operator.refused`
events show who looked at the screen as counts and codes only, never who.

## When something is wrong

- A queue's `oldest` keeps growing and `active` is 0: the worker is not consuming. Check
  `journalctl -u ks2-worker@<world>`.
- `failed` grows on a queue: `select * from ops.jobs where queue = '<name>' and state = 'failed'` shows the
  code-only failure record (`failure`, `failure_class`, `failure_code`). The message is not stored (D-017).
- An `unknown` model attempt: `reasoning unknown`, then `reasoning write-off` (`environments.md`).
- The panels say "the view is not installed": run `migrate.js`; it rebuilds the job views.
- A migration that changes a column read by an `ops` view fails with "cannot drop … because view … depends
  on it": drop and recreate the view in the same migration (never `cascade`).
