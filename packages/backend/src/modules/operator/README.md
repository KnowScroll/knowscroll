# Operator

Lets an operator look at the running system without reading the database by hand: the `ops` views,
the Operator screen's panels, and one record's journey across modules. Blueprint §26, decisions D-006 l,
D-017 and D-044.

Status: **implemented** and CI-verified against real PostgreSQL. **Runtime-verified** on a local
database and in a browser (D-044). Not yet running on dev.

## What an operator can do

- Open `/operator` (an operator account only) and see six panels: system overview, journey search,
  content production, universe change, realtime delivery, privacy and diagnostics health, and a list of the
  newest reports to the safety team (7 · Reports: kind, reason, what it is about, whether a note exists, when),
  and each room's AI calls over the last day against the router's caps (8 · Rooms: asked, on its own, refused by which cap;
  room ids and counts only, never a message; v3 R-2).
- Paste the ID of a request, production run, Reel order, model attempt, reasoning run, exposure or asset
  and read what the records say, oldest first, with the gaps they leave.
- From a server shell: `node dist/operator.js journey <id>` or `journey --account <accountId>` (worker tree).
- Point Grafana or `psql` at the `ks2_ops_reader` role and read the `ops` views.

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
| `ops.journey_events` | the owners' tables, by column | One row per recorded step, with the keys that join steps. Carries scoped IDs, so only the application role reads it. |

`ops.jobs`, `ops.queue_backlog` and `ops.recent_errors` are not in a migration. pg-boss installs its own
schema after the SQL migrations and changes it when it upgrades, and a view blocks PostgreSQL from
changing the columns it reads. `migrate.js` drops them before it runs anything and creates them after
pg-boss has started (`infrastructure/postgres/ops-job-views.ts`). PostgreSQL also refuses to drop or
retype a column that an `ops` view reads: a migration that changes one drops and recreates the view in
the same file.

`ks2_ops_reader` (SELECT only) may read every view except `ops.journey_events`. The migration role
cannot create roles: the owner creates the role once per cluster, and the next `migrate.js` run grants
it (`grantOpsReader`: CONNECT on the world's database, which refuses PUBLIC, usage on `ops` and the views; a missing role is a warning, not a failure). The panels read three views at a time so they cannot take the API's connection pool.

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

Dependency direction: `domain/` (journey rules, panel shapes, timeline text) → `application/` (use cases
and ports) → `adapters/` (Kysely over `ops.*`, Nest wiring). The module reads Identity's
`ReadAccountAddress` and `operatorAddressMatcher` through `public.ts`, and no other module's code.

## Configuration

`KS_OPERATOR_ACCOUNTS`: comma-separated addresses or one-`*` patterns. Unset: on `dev` with operator
sign-in enabled, the operator sign-in pattern; everywhere else nobody. A wildcard is refused on `live`.

## Tables, jobs, notices

Tables: none. Jobs: none. Notices: none. Lock order: none; every read is a plain statement. Erasure:
nothing to erase here; the views read the owners' rows, which the owners erase.

## Verification

- `domain/*.test.ts`, `application/*.test.ts`: journey rules, scope, gaps, panels, who is an operator.
- `tests/integration/modules/operator-journeys.test.ts`: journeys over a real request, production run,
  refused answer and unknown outcome (CI fixture models).
- `tests/integration/modules/operator-views.test.ts`: exact columns, planted private text, the reader
  role, the job views around a pg-boss upgrade.
- `tests/integration/release/operator-http.test.ts`, `journey-operator.test.ts`: the installed API and the
  worker command.

## Related

Runbook: `docs/v2/operations/looking-at-the-system.md`. Migration `0057_ops_views`. Contract:
`packages/contracts/src/operator.ts`. Client: `apps/client/features/operator/`.
