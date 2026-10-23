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

States a person sees: preparing (`requested` while their words are matched, `preparing` once work is
under way), ready, unavailable with a coarse reason, cancelled. No percentages, no waiting times.

## How a request is decided

1. **Reuse.** Exact current admitted content serves the brief: a primary topic (and, for a facet,
   admitted coverage bound to that facet), the language, the format. The request is `ready` at once.
2. **Join.** An active shared group for exactly this brief that is still producing already has work
   behind it. The request waits on that group. A group whose production ended is closed, not joined.
3. **Create.** `commissionSupply` picks a library recipe by code and commits the group and the
   recipe's production job with the request, in one transaction. It refuses when:
   - the brief is a Reel or a variant (no production path): `budget_unavailable`;
   - the day's Create cap (`KS_SUPPLY_CREATE_DAILY_CAP`, UTC) is used up: `budget_unavailable`;
   - no recipe is left (all published, or none can be taken again): `could_not_prepare`.

   Only an exact catalogue meaning can be produced. The catalogue is derived from the library plan and
   a library test proves every facet has a recipe, so a recipe always exists for a valid brief.

The planned demand of the Planner follows the same rules (`RecordPlannedDemand`). Where nothing can
start it stores nothing and says so (`not_commissioned`); a later plan asks again.

## Waiting for production

Each waiter has its own `supply.resolve-request` job. It looks at the standing of the group's recipe
and acts:

| Standing | The waiter |
|---|---|
| Content now admitted | binds it and becomes `ready` |
| Production queued or running | looks again in 20 seconds (a delayed job, one per request and slot) |
| Production ended without a Scroll, or none stands behind it | closes as `could_not_prepare` or `budget_unavailable` |
| Still waiting 30 minutes after the request | closes as `could_not_prepare`; the shared work carries on |

Every look is a fresh authority check under the personal root: owner active, epoch, source, and the
content's current admission. A redelivery changes nothing that is already decided.

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

`CreateRequest`, `ReadRequest`, `ListRequests`, `CancelRequest` and `ResolveRequest` are framework-free
ports; `supplyProviders` binds them. The API serves create, read, list and cancel
(`apps/api/src/http/supply.controller.ts`); the worker runs `ResolveRequest` as the
`supply.resolve-request` consumer and the Planner calls `RecordPlannedDemand` inside its accepting
transaction. Reading and listing change nothing.

Creation checks the immutable receipt key, validates any exact owned activated source and latest
Composer session, then rechecks current Content after the sorted SHARE-lock wait. Retryable stale or
source refusals write no receipt. A fresh accepted demand, its receipt, the personal revision and the
queued jobs commit together. A replay keeps the original request ID and receipt. Cancel changes only an
open owned waiter; shared work and other waiters are untouched.

## Tables, jobs and lock order

| Store | Role | Erasure |
|---|---|---|
| `supply.requests` | Private demand and waiter in one row: command, state, brief, group link, one ready binding. Person asks and Planner asks (`origin`). | Erased with the person (full erasure and Clear). |
| `supply.work` | Public shared group: SHA-256 key of a code-built brief, the recipe whose production it commissioned, `active`. No owner, no private context. | Survives erasure; it is public metadata. |
| `pgboss/supply.resolve-request` | IDs only (`universeId`, `privacyEpoch`, `requestId`). Four at a time, 360 s expiry, three retries. | The eraser removes every queued, active, retained and dead-lettered payload of the owner. |
| `pgboss/content.produce-scroll` | Owned by Content; names a recipe, never a person. | Nothing personal to erase. |

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
- `tests/integration/modules/supply-create.test.ts`: Create end to end with a fixture writer: one
  committed job, Join, one job for two briefs that choose one recipe, the daily cap, stopped and rejected
  recipes, the wait limit, planned demand, the list, erasure, and free-text matching with a fixture model.
- `tests/integration/modules/supply-planned.test.ts`, `planner-loop.test.ts`: the Planner's demand.
- `tests/integration/release/requests-http.test.ts`: the installed API.

CI fixtures only; real-provider runs are summarised in the pull request for #239.

## Related

Production jobs and recipes: `../content/production/README.md`. Decisions: `docs/v2/decisions.md` D-035,
D-037. Client: `apps/client/features/requests/`. Operator runbook: `docs/v2/operations/scroll-production.md`.
