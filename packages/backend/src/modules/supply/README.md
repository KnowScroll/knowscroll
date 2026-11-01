# Supply (Quartermaster)

Supply turns a person's ask for something to explore into admitted content they can open. It reuses
what exists, joins work that is already under way, and otherwise creates it: it commissions the
production of a library Scroll. Blueprint §3, §11, §15 and §19; decisions D-035 and D-037.

Status: **implemented**, CI-verified, and **runtime-verified** on a local database with the real
`MiniMax-M3.1-Flash` model (a free-text ask matched to the catalogue, produced and opened in the
client). Not yet running on dev. Ask orders (below, D-218) are **implemented** and CI-verified with labelled fixture
models; the real-model run of five ask orders is **planned** (the coordinator's, on dev). The library check of a question (D-251) and the support
check of an order's answer (D-250, in [content/production](../content/production/README.md)) are **implemented** and CI-verified with labelled
fixture models; their real-model measurement is **planned** (the coordinator's replay, `content ask-check`). S-7c (D-263, D-265 to D-267) made the check work on real
model output: quotes are matched after normalising marks and spacing, a verdict that breaks a rule makes only its sentence unsupported, titles and
headings may be marked as stating no fact, and a long answer is checked in batches.

## What a person can do

- Ask for a catalogue topic, or a topic and one of its angles (a facet), as a Reel, a Scroll or either.
- Type a request in their own words. A model proposes which catalogue topic it is about; code accepts
  only an exact catalogue member. Anything else closes honestly as `unsupported_request`.
- Ask for the same explanation in the other format (a variant).
- Read the state of one request or of their recent requests, and cancel one that is still preparing.
- Try again a request that closed as "could not prepare" (`RetryRequest`, below).
- Ask a question from a Scroll they are reading (D1) and get a short Scroll made for them alone (ask orders, below).

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
   - no recipe is left (all published, or none can be taken again): `could_not_prepare`. A v2 library recipe is never
     chosen: its Scroll waits at the operator review gate before anyone is served it (D-138), so the operator's
     library run makes those and an ask for such a meaning is answered once the Scroll is released.

   Only an exact catalogue meaning can be produced. The catalogue is derived from the library plan and
   a library test proves every facet has a recipe, but a recipe that is v2 exists only through the operator.

A person may have at most 10 asks open at once; an eleventh is refused (`too_many_open`, HTTP 429, no
receipt) until one ends or is cancelled. The limit bounds the polling jobs.

The planned demand of the Planner follows the same rules (`RecordPlannedDemand`). Where nothing can
start it stores nothing and says so (`not_commissioned`); a later plan asks again. Planned demand asks
for something new: when it resolves it binds only to content outside the explanations the person has
met, derived again at that moment under their scope (a Scroll they read since the plan, or one that was
already there while the paid job is still queued, never stands in). If proof of what they met is
unavailable, nothing is bound.

## Ask from here and ask orders (D-218, D-230, D-231; v3 S-7)

A person reading a v2 Scroll asks a question from one of its stops: `intent: { kind: 'ask', source, anchor: { kind: 'stop', stopId }, question, recordingGeneration }`.
It is the same request row, the same states (E07), polling, cancel and retry; only where it goes differs.

1. **Gate.** The create transaction refuses an ask while recording is paused or its generation is stale (`recording_paused`, `recording_stale`; no receipt),
   checks the exact activated source, and reads the anchor from the exact immutable revision (`READ_SCROLL_ASK_FACTS`): a stop that is not there is `source_unavailable`.
2. **A suggested question** (the exact words of the Scroll's own `askSuggestions`) is about that Scroll by construction. `commissionAskOrder` runs in the same transaction: no model call.
3. **A typed question** waits as `matching`. The worker's `supply.resolve-request` runs the scope step (`ask-scope.1`, one call and one repair on the recording-aware personal harness, at the recording generation the question was asked at, D-264):
   `here` makes an ask order; `catalogue` runs the library check below; `none` closes `unsupported_request`; a failure or an unknown outcome closes `could_not_prepare` and is never resent.
   **The library check** (D-251, `application/ask-library.ts`, `ask-library-role.ts`): a library Scroll is offered for a question only when a checker finds that it answers it.
   Code lists up to three admitted library Scrolls of the matched subject (never the Scroll being read), reads their prose (`READ_LIBRARY_PASSAGES`), and the personal harness runs
   `supply.ask-library` (`ask-library.2`, one call and one repair, outside every transaction). The reply is a handle and a quote copied from that Scroll; code accepts a Scroll only if
   the quote has three words or more, is in its text and is about the question (it carries at least two of the question's key words). Whether it answers is the checker's judgement (measured with the replay, D-252). A Scroll that answers is bound (`ready`, `reuse`) and costs no order. Otherwise (none answers, the subject has none, the reply stayed unusable) an
   ask order is made for the question within the caps (step 4), or the request closes `budget_unavailable`. **The library is never started for a question** (no Join, no Create).
   A spent personal budget closes it `budget_unavailable`; an attempt of unknown outcome closes it `could_not_prepare` and is never resent. One personal transaction closes one personal run, so
   the library check's run closes in its own transaction first; a redelivery after that offers no Scroll and makes an order.
4. **The order** (`application/ask-orders.ts`). Under the commissioning lock: the world's day cap (`KS_SUPPLY_ASK_DAILY_CAP`, from `supply.ask_orders`) and the person's
   (`KS_SUPPLY_ASK_PERSON_DAILY_CAP`, from their own requests) are checked; the research pages come from the source Scroll's provenance (`READ_SCROLL_SOURCE_PAGES`); Content records
   the order (`RECORD_MADE_TO_ORDER_SCROLL`, mode `question`, kicker "You asked", factual framing); the ledger row is written; the production job for take 1 is sent. A full cap is `budget_unavailable`.
5. **Waiting** (`application/ask-resolve.ts`). The waiter reads the order's standing on its own transaction (`READ_MADE_TO_ORDER_PRODUCTION_IN`): admitted and readable becomes `ready` (and the ledger notes, once, how long it took);
   queued or running within the wait limit looks again in 20 seconds; anything else is `could_not_prepare`. Nothing sends a second take by itself.
6. **Try again** (`application/ask-retry.ts`) re-drives the same request and order: a Scroll admitted meanwhile makes it ready; otherwise the next take is sent (three in all). Nothing else can start: `not_retryable`.
7. **The Scroll is open to its asker only** (`READ_ASK_ORDER_AUDIENCE`, `adapters/postgres-ask-orders.ts`): an account whose own request, not cancelled, names the asset. Erasing the request (Clear, account deletion) first sets the order's brief empty
   (`adapters/erasure.ts`), so a later take finds no order and the Scroll opens to nobody.
8. **The "usually" time.** `snapshot` adds `typicalSeconds` to a preparing request that is an ask order (not one still being placed, not one the library answers): the median of the last 20 finished orders **made under the support check** (`supply.ask_orders.support_checked`, D-252), and only from five (`domain/ask-order.ts`). The check is part of the wait, so an order made before it is not counted.
9. **The brief is one quoted line.** `askBrief` collapses the person's words (and the Scroll's title and stop) to one line, dropping control and format characters, so typed text cannot start a line of the brief of its own.
10. **Never the Scroll being read.** `inventory` skips the source's explanation for every ask, so placing, polling and Try again can all not return the Scroll the question was asked from (D-230).

*Implemented.* Not built: Reel asks (no production path), a v2 ask order (the review gate, D-138, would have to be skipped for a private audience) and asking as a wager (D3). Asking from selected words (D2) is the Quick answer below.

## Quick answer (D-086, D-253 to D-255; v3 S-9b)

A person who selects words in a read stop of a v2 Scroll and chooses Ask gets a short answer under the stop, labelled "Quick answer · not a checked Scroll". It is not a Scroll, not evidence and never part of the Universe. It is a different request from an ask: its own table, its own caps and no production behind it.

| Capability | Where | Status |
|---|---|---|
| Ask: `POST /v1/quick-answers` stores the row, one ledger row and one job in one transaction (`application/quick-answers.ts`). No model call. | `AskQuickAnswerUseCase` | implemented |
| Answer: a worker asks the writer (one repair) on the recording-aware personal harness, role `supply.quick-answer`, then the support check below, outside any transaction, then settles the row (`application/answer-quick-answer.ts`, `quick-answer-pipeline.ts`). At most six paid attempts. | `supply.answer-quick-answer` | implemented, CI-verified with labelled fixture models; real-model run is the coordinator's on dev |
| Read and dismiss: `GET /v1/quick-answers/{id}`, `POST /v1/quick-answers/dismiss` (clears the words now). | `ReadQuickAnswerUseCase`, `DismissQuickAnswerUseCase` | implemented |
| What the model is offered: the read stops up to and including the reader's and the plainer words of that stop, nothing after, no call (`READ_SCROLL_QUICK_ANSWER_FACTS`, Content). Whether the answer stays within them is what the checks below decide. | `domain/quick-answer.ts` | implemented |
| What code checks of a draft: every citation is an offered passage, a digit only where a cited passage, the selected words or the question states it, plain text, and a question about the selected words and the cited passages. It cannot see whether a sentence without a digit says what its passage says. | `quickAnswerRefusals` | implemented |
| What the checker model judges: S-7b's support check (D-250) reads each sentence against the passages the answer cites, under its own role `supply.quick-answer-support`; code validates the shape of its reply and judges each verdict on its own sentence (a quote in a cited passage and about the sentence, D-265; a verdict that breaks a rule makes that sentence unsupported). A Quick answer is checked in one request (D-267): its writer's answer is held to ten sentences (`too_many_sentences`, `quick-answer.2`), so its bound stays six. Not cleared: one rewrite with fixed hints and a second check; not cleared again, or no usable check at all: no card. No paid step starts once the person's wait is over. The answering step cannot be built without a checker. A model's judgement, not a proof. | `quick-answer-support.ts`, `quick-answer-pipeline.ts` | implemented; real-model accuracy is the coordinator's on dev |
| A question the passages do not cover: the card shows a sentence code owns, under the person's own words, and none of the model's. | `shownOf` | implemented |
| Caps: the world's day (`KS_SUPPLY_QUICK_ANSWER_DAILY_CAP`, from the ledger; 0 is off), the person's day (`KS_SUPPLY_QUICK_ANSWER_PERSON_DAILY_CAP`, from their rows) and three waiting at once. A full cap is an honest `unavailable` outcome with no row and no receipt. | `refusalReason` | implemented |
| Refused while recording is paused (D-254). A person who paused and resumed is answered at their current generation (D-264); a card asked before a pause is not answered after it. | `fenceRecording`, recording-aware harness | implemented |
| Retention (D-255): the selected words and the typed question are cleared when the answer settles or the card is dismissed, when a job arrives after the wait limit, or when `supply.purge-quick-answers` (every ten minutes) finds the answer still waiting after it; the answer is kept one day, then the purge deletes it; an expired answer reads as not found at once. The three-at-once limit counts only answers younger than the wait limit. | `adapters/postgres-quick-answers.ts` | implemented |
| A report keeps the answer's words (`READ_QUICK_ANSWER_FOR_REPORT`, read by Feedback). | `makeReadQuickAnswerForReport` | implemented |

A wait is four minutes at most. A status read past it says "could not answer" even if no worker ever closed the row, and a late answer finds the wait ended and is dropped. A redelivered job answers from the ledger (the run is the answer's ID), and an attempt of unknown outcome is never resent: the card ends as unavailable and the run stays open for an operator. The files that may name a Quick answer are allow-listed by `quick-answer-wall.test.ts`: nothing that ranks, plans, remembers or forms places can.

## Recording generation (D-264)

A question's placement (`ask-scope`, `ask-library`) and a Quick answer's writer, rewrite and support checks (`quick-answer`,
`quick-answer-support`) run on the recording-aware personal harness, as the Planner's and the Cartographer's do. Supply is its third owner.

| Capability | Where | Status |
|---|---|---|
| Each run is stamped when it starts with the person's account, the generation its record was asked at and a hash of what the model is sent, and every private read and write of it is fenced to that generation (and the root, epoch and account). | `application/recording-runs.ts`, `reasoning/application/personal-recording.ts` | implemented, CI-verified on real PostgreSQL with labelled fixture models |
| The generation is the request's own (`command.intent.recordingGeneration`) or the card's (`supply.quick_answers.recording_generation`, migration 0096), both checked against the person's root by the create transaction. | `application/requests.ts`, `application/quick-answers.ts` | implemented |
| Supply's owner check finds the record still current: the request still `matching`, or the card not dismissed, and asked at that generation. | `application/check-recording-run.ts`, installed by `supplyRecordingOwnerProviders` | implemented |
| A verdict or an answer is stored in the transaction that closes its run, under the fence. When the fence refuses, the question closes as `could_not_prepare` and the card as unavailable, and the model's reply is dropped. After a Clear nothing is written. | `applyQuestionVerdict` in `application/matching.ts`, `apply` in `application/answer-quick-answer.ts` | implemented |
| A free-text ask, Jev, What-if and a room's contribution still use the compatibility harness and run only at the first generation. | | planned, each with its own owner check |

Failure and recovery: a pause, a resume or a Clear while a run is in flight ends it. A reply that arrives late is paid for and dropped,
and a reservation not yet sent is released. A run the fence will not close stays open until the ledger's idle sweep closes it (six
hours). A question or card asked before a pause is not answered after it; the person asks again. The lock order is unchanged: root,
then the account gate, then the owner's rows.

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
unsupported. A free-text ask runs on the compatibility personal harness, which works only while recording is at its
initial generation, so a person who used Pause gets `could_not_prepare` for a free-text ask until it moves to the
recording-aware harness (its request records no generation yet; D-264 names it as not changed).

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
  it off) or `thread_cap` when the thread has had all the branches it may today, five per UTC day (`KS_SUPPLY_SCENARIO_THREAD_DAILY_CAP`, D-158);
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
| `pgboss/content.produce-answer` | Owned by Content; the same job for an ask order's answer (supply's ask path sends it, D-267); names an order's key, never a person. | Nothing personal to erase. |
| `supply.scenario_orders` | The ledger of a thread's branch orders that the scenario caps count: order ID, thread ID, time. | Names no person; survives erasure. |
| `supply.quick_answers` | A person's Quick answer (0093): the Scroll revision and stop, the words they selected and the question they typed (only while it waits), then the question the card shows and the answer. One day (`expires_at`). | Erased with the person (full erasure and Clear), at once; the export lists the answers still kept. |
| `supply.quick_answer_ledger` | The ledger of Quick answers: an ID and a time, no person and no words. The world's day cap reads it. | Names no person and no words; survives erasure. |
| `pgboss/supply.answer-quick-answer` | IDs only (`universeId`, `privacyEpoch`, `quickAnswerId`). Four at a time, 1,950 s expiry (six paid attempts at the largest request deadline, as the reasoning README counts it), one retry. | The eraser removes every queued, active, retained and dead-lettered payload of the owner. |
| `pgboss/supply.purge-quick-answers` | Cron, every ten minutes: first closes the Quick answers still waiting after the wait limit and clears their words, then deletes the ones whose day is over, 500 per transaction, at most ten batches a run. Logs `supply.quick_answers_given_up` and `supply.quick_answers_purged` with counts. | Nothing personal. |
| `supply.ask_orders` | The ledger of ask orders: order ID, when it was made, when its Scroll was first seen admitted, and whether it was made under the support check (`support_checked`, D-252). The world's cap and the "usually" time read it (D-218). | Names no person and no words; survives erasure. |
| `supply.requests.ask_order_id`, `ask_asset_id` | The link from a person's ask to the order and the Scroll made for it. It is also the audience of that Scroll. | Erased with the request; the order's brief is set empty first. |

An ask from here also writes one row in Content's `made_to_order_scrolls` (mode `question`) and reads the production jobs of the order; supply's erasure sets that row's brief empty (the one write it makes outside its own tables).
Erasure ownership: the request (the person's words) is erased by Clear and by account deletion and is exported under "requests"; the ledger is not personal.
What erasure does not reach (D-231), all of it unlinked from the person: the writer's request bytes in the production scope (the brief, with the question), kept up to 48 hours (`KS_REASONING_REQUEST_RETENTION_HOURS`); a refused writer answer, kept up to 30 days for the operator (`REJECTED_ANSWER_RETENTION_DAYS`), which can echo the question; and the Scroll the answer became, whose title and text stay in Content (revisions are immutable), open to nobody.

States of `supply.requests`: `matching`, `requested`, `deferred` (Planner), `ready`, `unavailable`,
`cancelled`.

Lock order: personal root, owned demand, Content asset SHARE locks in UUID order, the commissioning
advisory lock, the shared group row. A Quick answer's ask takes the personal root and then its own advisory lock (`supply.quick-answers`), last; no other path takes it. A resolver handles one recipient per transaction and never holds
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
- `tests/integration/modules/supply-ask.test.ts`: ask from here on real PostgreSQL with labelled fixture models: a suggested question orders at once with no model call; a typed question placed here, in the catalogue or nowhere; the order, brief, pages and ledger; produced, bound and opened by the asker alone; both caps and zero; a refused take, Try again, three takes; cancel; paused and stale refused; a stop that is not in the Scroll; export, erasure and Clear; no exposure, observation or action written.
- `tests/integration/modules/supply-ask.test.ts` also covers the library check (D-251): a Scroll offered only with words of it that are about the question, none answers, a quote not in the Scroll, a quote that is not about the question, or an unknown handle, no candidate, no shared work, the Scroll being read never a candidate, the cap, an unknown outcome) and the support check of the order's answer (D-250: supported, repaired once, refused, unusable, unknown, paused).
- `domain/ask-order.test.ts`, `application/ask-scope.test.ts`, `application/ask-library-role.test.ts`: the brief, the suggestion rule, the median, the scope answer, and the library check's reply and outcomes.

CI fixtures only; real-provider runs are summarised in the pull request for #239.

## Related

Production jobs and recipes: `../content/production/README.md`. Decisions: `docs/v2/decisions.md` D-035,
D-037, D-218, D-230 to D-232, D-250 to D-252. Client: `apps/client/features/requests/`. Operator runbook: `docs/v2/operations/scroll-production.md`.
