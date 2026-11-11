# Operator

## Follow an inspection

The Operator screen asks the API for diagnostic panels or a record's journey. The API checks the
account's current operator allowlist on every call. A shell operator can also inspect a person's
journey; the HTTP route cannot perform that broader account search.

Start at [public.ts](public.ts), [operator-access.ts](application/operator-access.ts) and
[read-journey.ts](application/read-journey.ts). Reads use the allowlisted `ops` views and change no
rows. An unknown or forbidden record gives no private explanation. For example, a model attempt
with no known outcome appears as a gap, never permission to send it again.

From the repository root, run
`pnpm --filter @knowscroll/backend exec vitest run src/modules/operator`
for local rules and fixtures. Real-database and installed-process checks use the
[integration suite](../../../../../tests/integration/README.md). Runtime notes below describe
their recorded checks; see [Status](../../../../../docs/STATUS.md) for deployment evidence.

Lets an operator look at the running system without reading the database by hand: the `ops` views,
the Operator screen's panels, and one record's journey across modules. Blueprint §26, decisions D-006 l,
D-017 and D-044.

Status: **implemented** and CI-verified against real PostgreSQL. **Runtime-verified** on a local
database and in a browser (D-044). This is historical check evidence; current deployment is tracked in Status.

## What an operator can do

- Open `/operator` (an operator account only) and see the diagnostic panels: system overview, journey search,
  content production, universe change, realtime delivery, privacy and diagnostics health, and a list of the
  newest reports to the safety team (7 · Reports: kind, reason, what it is about, whether a note exists, when),
  and each room's AI calls over the last day against the router's caps (8 · Rooms: asked, on its own, refused by which cap;
  room ids and counts only, never a message; v3 R-2).
- Paste the ID of a request, production run, Reel order, model attempt, reasoning run, exposure or asset
  and read what the records say, oldest first, with the gaps they leave.
- From a server shell: `node dist/operator.js journey <id>` or `journey --account <accountId>` (worker tree).
- Point Grafana or `psql` at the `ks2_ops_reader` role and read the `ops` views.
- From a server shell: `node dist/operator.js geography dry-run --universe <uuid>` and `planner dry-run --universe <uuid>` say
  what one Cartographer or Planner run would do for that universe, read-only and without a model (see Dry runs).
- From a server shell, once after the dirty set shipped: `node dist/operator.js geography reconcile-coverage [--universe <uuid>] [--unit <explanationUnitId>]... [--dry-run]`
  marks every topic with a support key dirty so each reader's history is read once, in paced runs (see the Geography README, "Operator:
  the reconciliation"; counts only).
- Hear about trouble without looking: an hourly watchdog logs a `watchdog.alert` warning when a code-only health rule fires
  (see Watchdog).

A person who is not an operator learns nothing: every operator route answers `404 NOT_FOUND`.

## What it never shows

IDs, states, times, counts and codes only. Never a prompt, a model answer, a request or message text, a
Reel script, an address, a provider payload or a score. Panels Tier 0 has no source for (service health,
request latency, media disk, realtime delivery, dropped diagnostics) say so and show no number.

## The views (schema `ops`, owned here)

Views have no data of their own: a row that is cleared or erased is gone from them at once. Each view
lists its columns by name; free-text columns that are really codes pass through `ops.safe_code`, which
returns null for anything not code-shaped. A test lists the exact columns of every view and plants
private text in every table that holds some.

| View | Reads | Shows |
|---|---|---|
| `ops.business_runs` | `reasoning.business_runs` | Personal reasoning runs: purpose, role, policy, model, state, times. No universe, no context. |
| `ops.model_attempts` | `reasoning.external_attempts`, `reasoning.production_attempts` | Every model call: state, outcome code, tokens (null is unknown), times. No request, answer or payload. |
| `ops.production_runs` | `content.scroll_production_runs`, `reasoning.production_runs` | Scroll production jobs: recipe, take, state, writer run, attempts, refused answers. |
| `ops.rejected_answers` | `reasoning.production_rejected_answers` | Refused writer answers: verdict, finding codes, size. Never the text. |
| `ops.reel_orders`, `ops.reel_attempts` | `content.reel_orders`, `content.reel_attempts` | Reel orders and attempts: state, outcome, pool claim, cents. No script, request body, note or remote detail. |
| `ops.geography_runs` | `geography.runs` | Cartographer runs: state, outcome code, times. No universe or proposal. |
| `ops.room_faces` | `rooms.room_identity`, `rooms.room_backdrops`, `rooms.backdrop_attempts` | One row of counts for the room faces (v3 R-4, D-171): kits and painted backdrops waiting or approved, image attempts still unresolved, and what every attempt counts against the $1 cap in millionths of a dollar. No prompt, no image, no room. Read in the shell (`rooms spend` prints the same figures); not on an Operator screen yet. |
| `ops.room_turns` | `rooms.ai_turns` | AI turns of rooms, asked or unprompted: ids, trigger, for an ask its kind (`ask_kind`, v3 R-3), state, the cap that decided it, time. No message text, no person, no prompt. The limits shown beside the counts are the rooms router's own, added by the API. |
| `ops.feedback_reports` | `feedback.reports` | Reports to the safety team: kind, reason, target kind (`deleted_account` once the person deleted theirs) and IDs, whether a note exists, time. No note, no sender, no person reported (D-055). |
| `ops.planned_demand_outcomes` | `supply.planned_demand_outcomes` | What became of the Planner's missing-supply opportunities, counted per UTC day, outcome and reason (reused, already recorded, commissioned, joined, not commissioned or unsupported with why, expired). Counts of codes: no person, no topic, no words. The "Planner demand" line of panel 3 reads the last seven days (D-410). |
| `ops.supply_gaps` | `supply.gaps` | The holes the gap loop found in the library (D-414): kind, catalogue planet and facet, status, priority, readers, attempts, a reason code, how many recipes it names and times. Codes, catalogue ids and counts: no recipe text, no person. `supply gaps [--status]` in the shell prints the same. |
| `ops.privacy_operations` | `identity.clear_operations`, `identity.account_deletions`, `identity.data_exports` | Operation kind, state, failure code, attempts, times. No account. |
| `ops.jobs`, `ops.queue_backlog`, `ops.recent_errors` | `pgboss.job` and the views above | Queue, state, retries, age, code-only failure record; backlog per queue; failures and unknown outcomes. Never a payload. |
| `ops.watchdog` | `ops.jobs`, `ops.model_attempts`, `geography.runs`, `planner.runs`, `personal_context.*coverage_references`, `composer.decisions` | One row per observation the watchdog may alert on: a rule, a code-only subject and detail, when, and a magnitude. No ID, no text; the thresholds live in code. Built with the job views (below), because it reads `ops.jobs`. |
| `ops.journey_events` | the owners' tables, by column | One row per recorded step, with the keys that join steps. Carries scoped IDs, so only the application role reads it. |

`ops.jobs`, `ops.queue_backlog`, `ops.recent_errors` and `ops.watchdog` are not in a migration. pg-boss installs its own
schema after the SQL migrations and changes it when it upgrades, and a view blocks PostgreSQL from
changing the columns it reads. `migrate.js` drops them before it runs anything and creates them after
pg-boss has started (`infrastructure/postgres/ops-job-views.ts`). PostgreSQL also refuses to drop or
retype a column that an `ops` view reads: a migration that changes one drops and recreates the view in
the same file.

`ks2_ops_reader` (SELECT only) may read every view except `ops.journey_events`. The migration role
cannot create roles: the owner creates the role once per cluster, and the next `migrate.js` run grants
it (`grantOpsReader`: CONNECT on the world's database, which refuses PUBLIC, usage on `ops` and the views; a missing role is a warning, not a failure). The panels read three views at a time so they cannot take the API's connection pool.

## Dry runs (shell, #674, D-411)

`geography dry-run --universe <uuid>` and `planner dry-run --universe <uuid>` (worker tree,
`apps/worker/src/dry-run-operator.ts`) answer "what would one run do for this universe now?" so a fix can be checked on a real
dev universe without writing anything. They live in the Geography and Planner modules (`application/dry-run.ts`); this
module owns only the runbook and the rule that their output is safe to paste into a public issue.

- **What they read.** Exactly what a run reads: the universe's personal scope (the root lock a read takes), then
  `prepareGeography` (the dirty topics and the places a quiet settle would look at by the clock, the newest keys of each facet, the trusted coverage read; D-416) or `prepareContext` (recent topics, inventory,
  the exploration snapshot, evidence), and the pure rules (`dueCreations`, `activityChanges`, the model packaging check).
- **What they never do.** Write a row, advance a revision, send a job or call a model. The scope is READ ONLY and always
  rolls back; the content authority recheck is the lock-free one, because PostgreSQL refuses a row lock in a READ ONLY
  transaction. A test attempts a write and a row lock and expects `25006`.
- **What they print.** One JSON line of counts and codes: what a reading-triggered run would do (`action`), the status and outcome
  its row would hold, in the codes a real run records (no second vocabulary), how many topics, keys, references, supports and places,
  what is due by kind, activity changes, and the context's bytes. **Never** a label, title, topic id, unit id, support reference, text, universe or
  account. A unit test plants such words in the facts and expects none in the output.
- **Authority.** The universe is named by its ID from a server shell, as `journey` is. The command claims epoch 1 and, told
  the current one by the scope's refusal, claims that: no account is named. A missing or suspended universe is refused (exit 2).

## Watchdog (D-411)

`operator.watchdog` (pg-boss cron, `7 * * * *`, worker) evaluates six code-only rules over `ops.watchdog` and logs a
`watchdog.alert` warning for each that fires: `reasonCode`, `count`, `windowSeconds` and, where it applies, a `queue`, a
`context` (planner, geography, personal, production) or an `outcome` code. It names no person and no record, repairs nothing,
and calls no model. A rule whose read fails (the view is missing, or the read passes its 5-second timeout) is logged as
`watchdog.rule_skipped` and the other rules still run.

| Rule | Reads | Alert (threshold, `WATCHDOG_THRESHOLDS`) |
|---|---|---|
| Dead-lettered jobs per queue | jobs in `<queue>.dead` | `dead_lettered_jobs`: 1 or more in 3 hours |
| Same failure repeating | `state = failed`, grouped by queue and failure code | `failed_jobs_repeating`: 5 or more in 6 hours |
| Personal runs held | Planner and Geography runs `queued` or `prepared` | `personal_runs_held`: row unmoved for 1 hour (a claim lasts 1150 s, a paced wake 5 minutes) |
| Same unhealthy outcome repeating | the latest settled Cartographer runs of a universe with coverage references (`no_trusted_support` is recorded only when the reader's other recent topics are untrusted too, so a withdrawn Scroll among trusted reading is `no_changes`, PR #723) | `geography_insufficient_repeating`: 3 in a row on one `insufficient` outcome other than the healthy `no_changes`, `disabled`, `no_support_yet`; 1 or more universes, seen within 7 days |
| A met explanation offered first beside an unseen one | `composer-policy.v2` vertical decisions with no exact target | `composer_repeat_offered`: 1 or more in 24 hours, among the newest 5,000 decisions of the last 7 days; v2 is built to make this impossible, so it fires only on a regression |
| Unknown model attempts | attempts whose outcome is `unknown` | `unknown_attempts_old`: 1 or more for 6 hours |

`domain/watchdog.ts` holds the thresholds in one object and the pure rules (`alertsFrom`); `application/run-watchdog.ts` runs a
pass; `adapters/watchdog-store.ts` reads `ops.watchdog` in one READ ONLY transaction per rule, with a 5-second statement
timeout and at most 50 groups. The view is read by the application role and by `ks2_ops_reader`; it holds no ID. The
`composer_repeat` rows read the stored decision's own record, built by the Composer's code: `input.mode` and `input.intent.exactTarget`
(the unseen-first rule applies to a vertical move with no exact target), the FIRST slot of `selection` (the offered item), the
`evaluations` (`explanationUnitId`, `eligible`) and what the person had met (`input.evidence.established.units[].encountered`, or
`input.evidence.recent`, the same notion as the Composer's `isMetIn`). It fires when the offered item was met while an eligible
candidate was not. `tests/integration/modules/watchdog.test.ts` builds its decisions with `composeEncounter`: policy v2's own choices
(unseen offered; the last resort) are stored through the Composer's own store and do not fire; a regression (the same code with
unseen-first switched off, under the v2 label, which the store refuses to keep) is written raw and does; a second-slot repeat, a return, a
move with an exact target and a v1 decision do not.

**Cost at scale (EXPLAIN on a seeded scratch database, PostgreSQL 16, warm cache, 11 November 2026).** Seed: 50,000 universes and
`geography.state` rows, 600,000 `geography.runs` (10,000 universes with 30 more runs of history, 5,000 queued), 100,000 rows in each reference
table, 100,000 `composer.decisions` (about 25 kB of payload each, 280 MB, 40% under v2).

| Rule | Plan | Time |
|---|---|---|
| `geography_insufficient_repeat` | seq scan of `geography.state` (11,202 rows with a run settled in 7 days), then per universe a read of its newest runs through `runs_pkey (universe_id, id)`, then 1,212 index-only probes of each reference table's `*_probe` index for the stuck ones | 113 ms warm, 499 ms cold; about 10 µs per active universe, so the 5-second statement timeout holds to roughly 400,000 universes active in a week, after which the rule is skipped and logged (`watchdog.rule_skipped`) until it is made incremental |
| `composer_repeat` | backward range scan of `composer_decisions_expired_idx` for the newest 5,000 decisions expiring after now + 23 days, then the JSON checks on those 5,000 | 335 to 347 ms; bounded by the 5,000-row sample whatever the table's size |
| `run_held` | bitmap scan of the partial index `geography_active_run` (and `planner_one_active_run`) | milliseconds for 5,000 active runs |

An earlier shape built a CTE of every recent run and scanned it once per universe, and a full hash of both reference tables; the
lateral read and the per-universe `limit 1` probes replaced them. The view orders a universe's runs by `id desc`, which is creation order
because the server mints run ids as UUIDv7.


## Journeys

`ReadJourney(id)` finds the steps that carry the ID in a key column, then follows the keys they name for
up to four rounds (request to group, group to the production run of its recipe, run to attempts and
refused answers, run to asset, exposure to asset). It stops at 300 steps and keeps the newest.

- **Scope.** A universe ID (a person's whole journey) is answered only by the operator command, never by the API. The first step names a universe or none. Later rounds read that universe's records and shared
  records (groups, production, Reel orders) only. An asset ID answers with its shared steps alone. A
  production run shows no request and no person; several waiters on one group stay apart.
- **Gaps.** An attempt whose outcome is `unknown` is shown as a gap that is never sent again. A started
  step with no recorded end after 30 minutes is shown as having no recorded completion.
- **Account search** is not in the screen or the API. `journey --account` resolves the account to its universe
  through Identity's read port, from the server shell.

## The canary (#674, D-413)

A post-deploy check that drives the real deployed API and worker with disposable test accounts and judges whether
recommendation, formation and supply behave. It lives here because it is an operator tool: the worker's `canary run` and
`canary cleanup` commands (`apps/worker/src/canary-operator.ts`) compose it, and nothing else calls it.

Follow one run. Start at [run-canary.ts](application/canary/run-canary.ts).

1. The command checks the world (`dev`, `stage` with `--allow-stage`, `ci` or `local`, operator sign-in on), prints the run id on
   stderr, and makes one account per persona with Identity's `issueOperatorSignIn`, at `canary-<run>-<persona>@<operator pattern>`.
   Minting writes the accounts and their audit rows. The link is redeemed through the real `POST /auth/redeem`
   ([http-api.ts](adapters/canary/http-api.ts)).
2. Each persona ([personas.ts](domain/canary/personas.ts)) runs on its own, at the same time, through
   [session.ts](application/canary/session.ts): it opens, asks the system to move, activates the offer it is shown, and reads or
   watches it. It uses only public routes, with the recording generation and scope claim a client sends. What those routes cause
   is what a reader causes: the worker projects evidence, and the Planner, Cartographer and Jev call models within the world's
   caps. A disposable account never starts or joins shared supply: Supply checks the account's disposable flag first (see below).
3. Reading is reported in the recorder's wire shapes ([reading-plan.ts](domain/canary/reading-plan.ts)): per-stop visible intervals,
   active dwell and value-free call interactions for a Scroll, one-second samples for a Reel, every 15 s. Times come from the
   Scroll's own document. The intake bounds every claim by the wall time since activation, so waits are real time; `--speed` makes a
   reader quicker down to a floor an honest reader still qualifies at.
4. After the journeys the run waits, within `--wait`, for the places and Planner runs the reading entitles. It reads the places
   through the public universe routes, and evidence, runs, supply and model attempts through the read-only operator reads
   ([reads-store.ts](adapters/canary/reads-store.ts)): `ops.journey_events` and the pg-boss rows whose payload names a canary
   universe. Evidence comes from the view because the dev diagnostics route answers only for the legacy intake. It is final once the
   worker has no `evidence.project-scroll-reading` job queued, retrying or running for that universe: each accepted batch queued one
   in the same transaction, and a job projects the exposure's whole watermark when it runs. A reading still being projected when the
   wait ends is `inconclusive`, not red.
5. [evaluate.ts](domain/canary/evaluate.ts) judges the invariants and returns counts and codes only. Then each account is deleted
   through the real account deletion flow, and the receipt must say `completed`.

**Stopping.** SIGINT, SIGTERM, SIGHUP and `--timeout` (default 90 minutes) abort the run: the journeys end at their next step,
nothing is judged, and the run's accounts are deleted within a bounded wait; the result is `aborted`. A crash still prints one
`failed` line and deletes what it made. `canary cleanup [--run <id>] [--dry-run]` ([cleanup-canary.ts](application/canary/cleanup-canary.ts))
finds a world's canary accounts again by the exact address shape (`canary-<8 hex>-<persona>` inside the operator pattern, and a
disposable account) and deletes them through the same flow; it opens no other address.

| Persona | What it does | What it proves |
|---|---|---|
| `cold-start` | A new account reads what it is offered, then moves once | A new reader is offered something and it is recorded |
| `deep-reader` | Follows a series part by part | Its system and planet form (two and three qualified units) |
| `topic-switcher` | Reads a series, waits for the place, opens one region on purpose | Region open works on a place the run formed |
| `reel-watcher` | Opens the Reel of what it is offered and keeps moving in Reels | A Reel is offered, served and qualifies |
| `many-reads` | Skims `--many` (default 18) Scrolls in one sitting | No re-reads; the Planner past 16 topics where the library allows |

Every invariant reports a status: `ok` (exercised and held), `violated`, `not_exercised` (what it guards never happened, so nothing was
proved) or `inconclusive` (evidence still being projected). `--strict` fails a run with any `not_exercised` or `inconclusive`.

| Invariant (code) | Fires when | Exercised when |
|---|---|---|
| `first_offer_missing` | A first open is not ready | any persona ran |
| `repeat_while_unseen_exists` | A system-chosen offer repeats a unit the reader met while another canary reader was offered one this reader had not, at or before that move (a repeat with none is a counted last resort) | a system-chosen move came after the reader had met something |
| `exhausted_while_unseen_exists` | The system says nothing is left while such a unit exists | the system answered `exhausted` to a system-chosen move |
| `reel_never_offered` | The Reel watcher never opened a Reel though Reels were offered | the Reel watcher ran and a Reel was offered to someone |
| `reading_not_stored`, `reading_not_projected`, `reading_not_qualified` | An honest reading was rejected, never projected, or judged short | a reading was reported |
| `formation_system_missing`, `formation_planet_missing` | Two (three) qualified units of one series left no system (planet) | a reader reached that series depth |
| `reel_media_unreachable` | A Reel grant did not serve its first bytes | a Reel was watched |
| `api_refused` | A route refused what a client may send (status and code only) | any persona ran |
| `operator_reads_failed` | The operator reads could not be made | always |
| `job_failed`, `job_dead_lettered` | A pg-boss job naming a canary universe failed or was dead-lettered | the reads were made |
| `shared_supply_touched` | A canary universe started or joined shared work (must be 0) | the reads were made |
| `planner_run_unknown`, `planner_run_stuck`, `geography_run_stuck` | A run has an unknown outcome, or sat unsettled for over 15 minutes | a run that is not parked (`blocked`, a Planner that is switched off) exists |
| `cleanup_incomplete` | An account was not confirmed deleted | the accounts were not kept |

The summary also reports `spend`: the supply requests of the run's universes, the shared work they commissioned (0), and the model
attempts whose request left, by the purpose of their run.

**A disposable account feeds no shared supply (D-413, D-414).** `commissionSupply` asks Identity, through `CheckPersonalAccountDisposable`
(the port the gap loop also reads), whether the account's address is disposable (made by operator sign-in, not yet proved by a mailed
link). If so, Create is off for it (`create_off`): a person's ask is recorded and closes `budget_unavailable`, and the Planner's demand
is recorded when admitted content already serves it and otherwise stores nothing (`not_commissioned`); neither starts nor joins a shared
group, and no gap signal is left. Planner and Cartographer model calls stay allowed: they are what the canary tests.

Limits, stated plainly. "Unseen exists" is proved only by what the canary's own readers were offered, so a repeat can be missed but
none is invented. Formation is judged by series depth, because no public route says which topic an asset has. It is not a load test
or a content-quality check. A reader killed with `SIGKILL` leaves its accounts: `canary cleanup` finds them.

Tables, jobs, notices: none. Minting writes accounts, universes, receipts and `ops.operator_sign_ins` rows through Identity; everything
else the canary causes is made by the public routes and the worker, and erased by account deletion. Runbook:
`docs/v2/operations/environments.md`, "Run the canary on dev". Tests: `domain/canary/*.test.ts`, `application/canary/*.test.ts` (a
scripted world that validates every batch against the real wire contract and judges readings with Evidence's own qualification) and
`tests/integration/release/canary-operator.test.ts`.

## Entry points

| Operation | Called from | Authority |
|---|---|---|
| `ReadOperatorPanels()` | `GET /v1/operator/panels` | `IsOperator` on the signed-in account, checked on every call |
| `ReadJourney(id)` | `GET /v1/operator/journeys/{id}`, `operator.js journey` | The same check; the CLI runs from the server shell |
| `IsOperator(accountId)` | the controller | The account's address now matches one entry of `KS_OPERATOR_ACCOUNTS` |
| `RunWatchdog()` | the worker's `operator.watchdog` consumer | None: reads `ops.watchdog` only; names no person |

Dependency direction: `domain/` (journey rules, panel shapes, timeline text) → `application/` (use cases
and ports) → `adapters/` (Kysely over `ops.*`, Nest wiring). The module reads Identity's
`ReadAccountAddress` and `operatorAddressMatcher` through `public.ts`, and no other module's code.

## Configuration

`KS_OPERATOR_ACCOUNTS`: comma-separated addresses or one-`*` patterns. Unset: on `dev` with operator
sign-in enabled, the operator sign-in pattern; everywhere else nobody. A wildcard is refused on `live`.

## Tables, jobs, notices

Tables: none. Jobs: `operator.watchdog` (hourly, no payload, no dead letter). Notices: none. Lock order: none; every read is a plain statement
(the watchdog's are READ ONLY). Erasure:
nothing to erase here; the views read the owners' rows, which the owners erase.

## Verification

- `domain/*.test.ts`, `application/*.test.ts`: journey rules, scope, gaps, panels, who is an operator.
- `tests/integration/modules/operator-journeys.test.ts`: journeys over a real request, production run,
  refused answer and unknown outcome (CI fixture models).
- `tests/integration/modules/operator-views.test.ts`: exact columns, planted private text, the reader
  role, the job views around a pg-boss upgrade.
- `tests/integration/release/operator-http.test.ts`, `journey-operator.test.ts`: the installed API and the
  worker command.
- `domain/watchdog.test.ts`, `application/run-watchdog.test.ts`: each rule fires on its condition and not otherwise, one
  unreadable rule is skipped, the thresholds come from one object.
- `tests/integration/modules/watchdog.test.ts`: a planted dead letter, repeated failures, a stuck Cartographer and Planner run, an
  old unknown attempt, a universe that keeps settling unavailable, and a v2 decision that repeats; no id or text in any alert or row.
- `tests/integration/release/dry-run-operator.test.ts`: the installed worker's dry-run commands.

## Related

Runbook: `docs/v2/operations/looking-at-the-system.md`. Migration `0057_ops_views`. Contract:
`packages/contracts/src/operator.ts`. Client: `apps/client/features/operator/`.
