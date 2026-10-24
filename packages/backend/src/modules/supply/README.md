# Supply (Quartermaster)

Supply turns a person's ask for something to explore into admitted content they can open. It reuses
what exists, joins work that is already under way, and otherwise creates it: it commissions the
production of a library Scroll. Blueprint §3, §11, §15 and §19; decisions D-035 and D-037.

Status: **implemented**, CI-verified, and **runtime-verified** on a local database with the real
`MiniMax-M3.1-Flash` model (a free-text ask matched to the catalogue, produced and opened in the
client). Not yet running on dev.

## What a person can do

- Ask for a catalogue topic, or a topic and one of its angles (a facet), as a Reel, a Scroll or either.
- Type a request in their own words. A model proposes which catalogue topic it is about; code accepts
  only an exact catalogue member. Anything else closes honestly as `unsupported_request`.
- Ask for the same explanation in the other format (a variant).
- Read the state of one request or of their recent requests, and cancel one that is still preparing.
- Try again a request that closed as "could not prepare" (`RetryRequest`, below).

States a person sees: preparing (`requested` while their words are matched, `preparing` once work is
under way), ready, unavailable with a coarse reason, cancelled. No percentages, no waiting times.

## How a request is decided

1. **Reuse.** Exact current admitted content serves the brief: a primary topic (and, for a facet,
   admitted coverage bound to that facet), the language, the format. The request is `ready` at once.
2. **Join.** An active shared group for exactly this brief that is still producing already has work
   behind it. The request waits on that group. A group whose production ended is closed, not joined.
   A join also sends the group's production job again (same identity, so a queued job is never doubled):
   a job that paused or was dead-lettered is revived by the next person who asks, not left to time out.
3. **Create.** `commissionSupply` picks a library recipe by code and commits the group and the
   recipe's production job with the request, in one transaction. It refuses when:
   - the brief is a Reel or a variant (no production path): `budget_unavailable`;
   - the day's Create cap for this origin is used up: `budget_unavailable`. People's asks count against
     `KS_SUPPLY_CREATE_DAILY_CAP`; the Planner's demand against its own, smaller
     `KS_SUPPLY_PLANNER_CREATE_DAILY_CAP` (never above the first), so the Planner cannot starve an ask;
   - no recipe is left (all published, or none can be taken again): `could_not_prepare`.

   Only an exact catalogue meaning can be produced. The catalogue is derived from the library plan and
   a library test proves every facet has a recipe, so a recipe always exists for a valid brief.

A person may have at most 10 asks open at once; an eleventh is refused (`too_many_open`, HTTP 429, no
receipt) until one ends or is cancelled. The limit bounds the polling jobs.

The planned demand of the Planner follows the same rules (`RecordPlannedDemand`). Where nothing can
start it stores nothing and says so (`not_commissioned`); a later plan asks again. Planned demand asks
for something new: when it resolves it binds only to content outside the explanations the person has
met, derived again at that moment under their scope (a Scroll they read since the plan, or one that was
already there while the paid job is still queued, never stands in). If proof of what they met is
unavailable, nothing is bound.

## Waiting for production

Each waiter has its own `supply.resolve-request` job. It looks at the standing of the group's recipe
and acts:

| Standing | The waiter |
|---|---|
| Content now admitted | binds it and becomes `ready` |
| Production queued or running | looks again in 20 seconds (a delayed job, one per request and slot) |
| Production ended without a Scroll | closes as `could_not_prepare` |
| The group commissioned no production (it predates Create) | commissions as if the person had just asked: joins or starts a group that has work, or closes with an honest reason |
| Still waiting 30 minutes after the request | closes as `could_not_prepare`; the shared work carries on |

The 30-minute limit also applies when the request is read: an open request older than that reads as
`could_not_prepare` even if no job ever closed it (a poll was dead-lettered, the worker stayed down), and the
next write freezes the same outcome.

Asks left open from before Create have no resolver job. The operator command
`supply recover-open-demand [--dry-run]` sends one for each open ask (`adapters/recover-open-demand.ts`;
stable job ID per request, so a second run sends nothing new). It names IDs only and calls no provider.

Every look is a fresh authority check under the personal root: owner active, epoch, source, and the
content's current admission. A redelivery changes nothing that is already decided.

## Trying a request again

`RetryRequest` reopens a request that closed as `could_not_prepare`: the same row and request ID, the same
words and brief, a new wait. It decides the brief the way Create does (Reuse, then Join or Create), so it
respects the day's Create cap, the open-request limit (`too_many_open`, no receipt) and the recipes still
left. `retries` counts the retries (three at most) and `wait_started_at` starts the new wait: the wait limit,
the read-time deadline and the resolver's poll slots count from it, and the poll job's identity names the
retry, so a new chain never collides with the one that ended. `created_at` still says when it was asked.

The command answers with an immutable receipt:

| Outcome | Meaning |
|---|---|
| `retrying` | The request is waiting again, or already served from what exists. Read its status for which. |
| `already_open` | It is still preparing or already ready. Nothing changed. |
| `not_retryable` | It was cancelled or closed for another reason, its retries are used, it is a free-text ask that was never matched, or nothing can start now (the day's limit). Nothing changed. |

A free-text ask that was never matched is not retried: its model attempt may have had an outcome nobody
saw, and unknown outcomes are never resent. A retry never calls a model and never resends a paid attempt:
a new production job is a new take of a recipe under Content's own rules (a recipe takes at most three
takes). The Planner's demand is not a person's ask and is not retried (`not_found`). A foreign or unknown
request is `not_found`.

## Free-text asks

A free-text ask is stored as `matching` (no brief, no group, decision `pending`) and queues one resolver
job. The worker runs one model call outside any transaction on the personal reasoning harness, with the
request ID as the business run, so a redelivery never pays twice. The answer is `{topicId, facetId}`
and must be an exact catalogue member (the schema refuses anything else; one repair is allowed). A match
is then handled like a person's own catalogue ask. A cancel that arrives while the model thinks wins.
An attempt of unknown outcome is never resent: the request closes as `could_not_prepare` and the run is
left for an operator. A context-bearing text ask ("about this encounter") is not matched and closes as
unsupported. The personal harness runs only while recording is at its initial generation, so a person
who used Pause gets `could_not_prepare` for a free-text ask until the recording-aware harness accepts
this purpose.

## Entry points

`CreateRequest`, `ReadRequest`, `ListRequests`, `CancelRequest`, `RetryRequest` and `ResolveRequest` are framework-free
ports; `supplyProviders` binds them. The API serves create, read, list, cancel and retry
(`apps/api/src/http/supply.controller.ts`); the worker runs `ResolveRequest` as the
`supply.resolve-request` consumer and the Planner calls `RecordPlannedDemand` inside its accepting
transaction. Reading and listing change nothing.

Creation checks the immutable receipt key, validates any exact owned activated source and latest
Composer session, then rechecks current Content after the sorted SHARE-lock wait. Retryable stale or
source refusals write no receipt. A fresh accepted demand, its receipt, the personal revision and the
queued jobs commit together. A replay keeps the original request ID and receipt. Cancel changes only an
open owned waiter; shared work and other waiters are untouched.

## Orders for a thread's branch (D-049)

A What if or Another perspective in a content thread (the `scenarios` module) is not a request of a person's
and does not match the catalogue. When a member chooses a direction, the scenarios module hands Supply a
code-built order and `COMMISSION_SCENARIO_ORDER` runs inside the member's transaction, after the thread's lock:

- it takes the commissioning lock (last in the lock order), so the day's count and the orders it admits agree;
- it refuses with `day_cap` when the world's UTC day is full (`KS_SUPPLY_SCENARIO_DAILY_CAP`, 0 turns
  it off) or `thread_cap` when the thread has had all the branches it may (`KS_SUPPLY_SCENARIO_THREAD_CAP`);
- it records the order with Content (`RECORD_MADE_TO_ORDER_SCROLL`), writes a row in `supply.scenario_orders`
  (order and thread, no person and no words) and sends the production job for take 1 (same identity, so a
  repeat is never doubled).

An order is its own work: never joined with another, never reused for another thread, not part of
`supply.work` and not counted by the two Create caps above. That is why it has its own ledger and does not
go through ContentDemand's compatible-supply matching, which joins a request to supply for the same brief:
the opposite of a Scroll made for one thread. The scenarios module makes one order per branch in the
transaction that makes the branch, so a retry never gets here twice. The scenarios module's sweep sends later takes.
*Implemented.*

## Tables, jobs and lock order

| Store | Role | Erasure |
|---|---|---|
| `supply.requests` | Private demand and waiter in one row: command, state, brief, group link, one ready binding, retry count and the start of the current wait. Person asks and Planner asks (`origin`). | Erased with the person (full erasure and Clear). |
| `supply.work` | Public shared group: SHA-256 key of a code-built brief, the recipe whose production it commissioned, who commissioned it (`person` or `planner`, for the two caps), `active`. No owner, no private context. | Survives erasure; it is public metadata. |
| `pgboss/supply.resolve-request` | IDs only (`universeId`, `privacyEpoch`, `requestId`). Four at a time, 360 s expiry, three retries. A recovery job uses the same payload. | The eraser removes every queued, active, retained and dead-lettered payload of the owner. |
| `pgboss/content.produce-scroll` | Owned by Content; names a recipe, never a person. | Nothing personal to erase. |
| `supply.scenario_orders` | The ledger of a thread's branch orders that the scenario caps count: order ID, thread ID, time. | Names no person; survives erasure. |

States of `supply.requests`: `matching`, `requested`, `deferred` (Planner), `ready`, `unavailable`,
`cancelled`.

Lock order: personal root, owned demand, Content asset SHARE locks in UUID order, the commissioning
advisory lock, the shared group row. A resolver handles one recipient per transaction and never holds
shared work while acquiring another personal root. No model call or network wait happens inside a
transaction or on the HTTP path.

## Revision and status

Status is a read-only projection of the stored request and current Content availability. Its request
revision is the stored revision plus Content's availability deltas since binding, so withdrawal
invalidates `ready` and re-admission can restore it at a higher revision. A terminal outcome freezes at
the latest derived revision plus one and never resumes. Clients keep the highest request revision they
have seen and fence snapshots by AccountScope. Global Content changes do not advance the personal
catch-up watermark.

## Verification

- `tests/integration/modules/supply.test.ts`: receipts, sharing, cancel, source authority, erasure.
- `tests/integration/modules/supply-create.test.ts` also covers retry: same request bound when the next take publishes, replay, `already_open`, a restarted wait, a free-text ask never retried, the day cap, the retry limit, cancelled and Reel asks, foreign and unknown requests.
- `tests/integration/modules/supply-create.test.ts`: Create end to end with a fixture writer: one
  committed job, Join, one job for two briefs that choose one recipe, the daily cap, stopped and rejected
  recipes, the wait limit and the read-time deadline, planned demand (including never binding met content),
  the list, the open-request limit, the separate Planner cap, a join resuming a paused or dead-lettered
  job, recovery of open demand left from before Create, erasure, and free-text matching with a fixture model.
- `tests/integration/modules/supply-planned.test.ts`, `planner-loop.test.ts`: the Planner's demand.
- `tests/integration/release/requests-http.test.ts`: the installed API.
- `application/scenario-orders.test.ts`, `tests/integration/modules/scenarios.test.ts`: the order, both caps and idempotence.

CI fixtures only; real-provider runs are summarised in the pull request for #239.

## Related

Production jobs and recipes: `../content/production/README.md`. Decisions: `docs/v2/decisions.md` D-035,
D-037. Client: `apps/client/features/requests/`. Operator runbook: `docs/v2/operations/scroll-production.md`.
