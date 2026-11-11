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
  `prepareGeography` (candidate discovery, the trusted coverage read, compaction) or `prepareContext` (recent topics, inventory,
  the exploration snapshot, evidence), and the pure rules (`dueCreations`, `activityChanges`, the model packaging check).
- **What they never do.** Write a row, advance a revision, send a job or call a model. The scope is READ ONLY and always
  rolls back; the content authority recheck is the lock-free one, because PostgreSQL refuses a row lock in a READ ONLY
  transaction. A test attempts a write and a row lock and expects `25006`.
- **What they print.** One JSON line of counts and codes: the outcome a reading-triggered run would reach, the status and outcome
  its row would hold, why no context can be frozen, how many keys, references, supports and places, what is due by kind,
  activity changes, and the context's bytes. **Never** a label, title, topic id, unit id, support reference, text, universe or
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
| Same unavailable reason repeating | the latest settled Cartographer runs of a universe with coverage references | `geography_unavailable_repeating`: 3 in a row on `coverage_unavailable` or `context_limit`, seen within 7 days |
| A met explanation offered beside an unseen one | `composer-policy.v2` decisions only | `composer_repeat_offered`: 1 or more in 24 hours; with no v2 decision the rule has nothing to read and never fires |
| Unknown model attempts | attempts whose outcome is `unknown` | `unknown_attempts_old`: 1 or more for 6 hours |

`domain/watchdog.ts` holds the thresholds in one object and the pure rules (`alertsFrom`); `application/run-watchdog.ts` runs a
pass; `adapters/watchdog-store.ts` reads `ops.watchdog` in one READ ONLY transaction per rule, with a 5-second statement
timeout and at most 50 groups. The view is read by the application role and by `ks2_ops_reader`; it holds no ID. The
`composer_repeat` rows read the stored decision's own record of what the person had met and which candidates were eligible
(the `composer-decision` payload's `selection`, `evaluations` and `input.evidence.established.units`); the rule is written
against that shape and is checked by `tests/integration/modules/watchdog.test.ts`, which widens the policy check in its own
disposable database to plant a v2 decision. The Composer's v2 slice should re-run it when it fixes the payload.

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
