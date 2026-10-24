# reasoning

The shared execution engine for model calls (blueprint §15): the harness module-owned roles call,
the attempt ledger that accounts for every external, possibly paid request, the protected request
store, and the provider transports behind `ModelPort`. It owns no role: a role's instructions,
output schema, semantic validator, context builder and applier live in its own module. The harness
owns admission, budgets, transport, parsing, limits and attempt tracking. No tool loops.

## What works today

| Capability | Status |
| --- | --- |
| Personal harness: admission, budgets, quota preflight, dispatch, settlement and one repair | Implemented. CI exercises every transition against real PostgreSQL with the labelled fixture model. |
| MiniMax transport (`MiniMax-M3.1-Flash`) | Implemented. Real calls have been made from the production operator command; no generated Scroll has been accepted yet. |
| Nonpersonal Scroll production scope | Implemented and operator-triggered only: no worker job is registered and both enable switches default off. |
| Recording-aware personal roles (Planner, Cartographer) | Implemented in source and CI. The roles are off by default and the path has not run on a live system. |
| Selective Clear accounting and erasure of a person's attempts | Implemented and CI-tested. |
| Crash sweep and request purge jobs | Implemented, scheduled in the worker and CI-tested. |
| Operator commands | Implemented and runtime-verified from the built worker tree (`release/worker-operator-journey.test.ts`). |
| Tool loops, a second queue, other providers | Not planned (blueprint §15). |

## Using it from a module

```ts
const outcome = await harness.propose({ run, role, context, limits }, signal);
```

- `run`: `{ id (stable across deliveries), authority (PersonalAuthority), ownerModule, purpose, policyVersion }`.
- `role`: `{ id '<module>.<role>', version, instructions, outputSchema (zod), maxOutputTokens, minContextItems?, budget? }`.
- Optional `role.safeCustomIssues` is a static, code-owned semantic code → fixed hint catalogue.
  Never construct it from user/provider values, retrieved text or context. Admission allows at most
  128 own entries, lowercase codes of at most 64 characters (`[a-z][a-z0-9_]*`, no prototype names)
  and nonempty hints of at most 256 characters without Unicode Cc/Cf control/format characters.
  Every own property counts: only enumerable string data properties are accepted; hidden,
  accessor and symbol entries refuse admission without invoking getters. A custom Zod issue can opt
  in with `params: { safeCode: 'declared_code' }`. Only an own allowlisted code and its fixed hint reach the
  existing bounded issue/repair record; `custom.message` is never read. Undeclared/malformed codes
  remain `custom` without detail. Paths still use only schema-declared names, numeric positions and
  placeholders. Roles without a catalogue keep the existing behavior. Feedback changes require a
  role version change; existing ledger issues and exact historical repair bytes are not rewritten.

Safe diagnostic paths retain every bounded schema candidate across union/intersection prefixes;
no rejected value or discriminant chooses a branch. Only declared field names and nonnegative safe
integer positions positively established by an array/tuple schema are printed; unknown names
and unresolved numeric segments remain `?`, while known record/map keys remain `[key]`. A numeric
Map key is caller-chosen data, never a fallback array index, including after budget/getter failure.
Ambiguous object/record paths use the masked form. Limits are ten path segments, 256 rendered
characters, 64 pending/candidate branches, 16 schema-wrapper/branch levels and 512 visits per
issue path. Exhaustion or an unreadable schema masks the remaining path conservatively; it never
changes validation. The eight-issue plus `more` bound stays unchanged. Old stored issues are replayed
as recorded, so improved diagnostics do not rewrite historic repair requests.
The schema is read in one place, `domain/schema-structure.ts`, through Zod's typed `schema.def` (never
`_zod` or `_def`); `domain/issue-paths.ts` holds the masking and its bounds. A Zod upgrade that
renames a definition field fails the type check, and one that changes how a schema describes
itself fails `schema-structure.test.ts`, instead of silently masking every path.

- `context` (D-021, blueprint §26 minimisation): `{ bundleRef, items: [{ ref, kind, text }] }`. The
  module freezes **prepared, bounded context** (topic/unit references and authorised excerpts),
  never a raw observation stream, another person's private data or a secret. The harness enforces
  the bounds (at most 64 items of 32,768 characters, refs and kinds in a fixed alphabet, the whole
  request under `KS_REASONING_MAX_REQUEST_BYTES`) and records only the `bundleRef` and item **refs**
  on the run; item text exists only inside the protected request bytes.
- Outcomes: `proposed { output, attemptId, usage, repaired, reconciled }`, `invalid_output`,
  `unknown` (may have been sent; never resent), `failed { code }` (conclusive provider failure),
  `refused { reason }`, `budget_exhausted { dimension, limit }`, `quota_unavailable`. `proposed`
  means the structure is valid and the authority still holds; the module still validates the
  content semantically and rechecks authority under the lock when it applies the result, then closes
  the run (`closeRun`) in that transaction.
- **A conclusive failure ends the run.** `failed` (a refused connection, a 429 or 5xx, an abort
  before the request left) charges nothing unless the provider reported usage, but the harness does
  not retry it: the same run answers `failed` again from the ledger. Whether to start a **new run**
  is the caller's decision (the caller's job policy, not a hidden retry).
- **A closed run answers `run_closed`** to every later `propose`, including a redelivery whose
  answer is still kept in the ledger: the applier closes the run in the transaction that applies the
  result, so a handler that sees `run_closed` knows the work is done. `closeRun` answers `closed`
  once and `not_open` after (that is the applier's idempotency token; the run's fence is recorded
  for audit only). A run admitted at one privacy epoch answers `run_mismatch` under another: it never
  continues, and never returns output, across a reset.
- **Queue settings for a job that calls `propose`.** A job's `expireInSeconds` must exceed everything
  one delivery can do: per attempt the quota preflight (10 s) plus the request deadline
  (`KS_MINIMAX_REQUEST_TIMEOUT_MS`, default 240 s, at most 300 s) plus the database waits (each
  personal-scope lock wait is at most `KS_SCOPE_LOCK_TIMEOUT_MS`, 5 s, and there are two), and a
  repair doubles it. Declare `expireInSeconds ≥ 2 × (10 + request deadline in seconds + 10) + 30`
  (550 s with the defaults, 670 s at the 300 s maximum). Below that, pg-boss expires a delivery that
  is still waiting on the provider; the next delivery finds the attempt `dispatched`, marks it
  `unknown` (never resent) and the operator has to write it off.
- **Aborts.** A graceful stop (the delivery's signal) before the request leaves records a failure
  with code `ABORTED_BEFORE_DISPATCH` that charges nothing; the stop after it left records `unknown`.

Every request is framed by the harness: a fixed preamble and the role's instructions in the system
text; every context item as escaped, delimited data in the user text (`domain/prompt.ts`), so
retrieved text cannot close its block or pose as instructions. Answers must be exactly one JSON
object (bare or in one fenced block, nested at most 32 levels) that passes the role's schema
(`domain/output.ts`).

A module reaches this engine only through `public.ts`: the types above, the injected
`REASONING_HARNESS` / `RECORDING_REASONING_HARNESS` and the queue declarations. The harness factory, its ports, the attempt ledger
and the model transport are deliberately not exported there (a boundary probe and the dependency
rules enforce it), so a module cannot build its own harness with its own ledger or transport, and an
ESLint rule keeps global `fetch`, Node's HTTP clients and provider SDKs out of everything but
`infrastructure/` and `reasoning/adapters/` (`pnpm lint:probe:network` proves it bites).

### Thinking models and the answer carrier

The answer carrier is plain text: one JSON object, bare or in one fenced block. A role may set
`effort` (`low`, `medium`, `high`) for a model that thinks adaptively; the adapter sends it as
`output_config.effort`, and a model that does not think ignores it. Thinking tokens count against
`maxOutputTokens`, so a role's ceiling must leave room for them. A reply cut off while thinking
is `OUTPUT_TRUNCATED`. There is no tool carrier, no forced tool choice and no structural schema
sent to the provider: the role's Zod schema (with its refinements) and the module's checks are the
only contract, and a refusal reaches the single repair as fixed, path-located findings.

## Nonpersonal Scroll production

The worker also injects `PRODUCTION_REASONING_HARNESS` (`ProductionReasoningHarness`) and
`WITH_PRODUCTION_SCOPE` (`WithProductionScope`). Its additive methods are
`proposeProduction({ run, role, context, limits }, signal)` and
`closeProductionRun(scope, { runId, state })`. The existing personal methods are unchanged.
`ProductionReasoningRun.authority` is `{ scopeId: 'scroll-supply', generation }`, with no account,
universe, privacy epoch or borrowed user actor. The role/context/validation/repair/transport and
attempt state machine are the same engine as personal proposals. This boundary admits no personal
context: a production role must prepare public/sanitised source material and job-local brief refs.

One `reasoning.production_scopes` row per database/world is the fixed Scroll supply root. Both
`KS_REASONING_PRODUCTION_ENABLED=1` in worker configuration and `enabled=true` on that row are
required. Both default off. An operator may disable the root or
advance its positive integer `generation` to fence queued/in-flight work; enabling a later generation
does not make an old run current. No HTTP/frontend grant or automatic production activation exists.

`withProductionScope` takes `FOR NO KEY UPDATE` on that root, then rechecks enabled/generation
**after** the lock wait. Its frozen, branded capability expires with the callback. Lock order is
production root → production run/attempt/domain rows → shared budget advisory lock. A production
transaction never acquires a personal root; nested transactions and model network operations refuse
under the same runtime transaction marker as personal scopes. Content adapters can use
`productionTransactionOf(scope)` to apply accepted content and close the run in one transaction.
Only a `closed` result authorises first application; rollback leaves the run open and fence unchanged.
The root generation and run fence are separate: generation revokes old work, closure increments the
run fence and prevents later proposal delivery. The applier reacquires the current root capability.

Production storage is separate (`0013_reasoning_production_scope`):

| Table                                | Key / ownership                                                                                               | Retention                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `production_scopes`                  | Fixed `scroll-supply` root; enabled + generation                                                              | Retained, operator controlled                                                     |
| `production_runs`                    | `(scope_id, id)`, root FK, admitted generation and monotonic run fence                                        | Audit retained; no automatic run retention job yet                                |
| `production_attempts`                | `(scope_id, id)`, composite production run FK; same state/dispatch/write-off checks                           | Audit retained, including unknown liabilities                                     |
| `production_requests`                | `(scope_id, attempt_id)`, composite production attempt FK, exact hash-checked bytes; `nonpersonal_production` | Same configured request expiry/purge and database backup policy as personal bytes |
| `production_rejected_answers` (0050) | `(scope_id, attempt_id)`, composite production attempt FK; redacted answer text, findings                     | 30 days, purged with the expired requests                                         |

These tables have **no identity/universe foreign key and no personal erasure entry**. Personal erasure
cannot own, retain or delete global supply. The existing minimal `usage_receipts` table is shared:
production reservations and settlements participate in the same global and per-role caps; the scope
cap counts the production root's own attempts. Attempt + exact request + receipt reserve atomically;
settlement + receipt commit atomically even after the root is disabled/replaced. A paid answer after
revocation is accounted but never returned as applicable output. Sweep, purge, unknown-list and
write-off include both personal and production tables, independent of production enablement.
Unknown/write-off never authorises another send, and late usage only updates the kept receipt.

### Refused answers of production attempts

A refused answer of a **nonpersonal production** attempt is kept in `production_rejected_answers`
so a failing writer can be diagnosed from evidence: the harness verdict, the validator's own
findings (the same fixed `{path, code, detail}` items the repair request carried), and the answer
text redacted by `redactProviderText` and cut at 64 KiB (an unreadable reply keeps its bounded raw
body instead, marked `raw_reply`: for the operator only, never fed back to a repair). One row per attempt, kept 30 days; the protected-request purge deletes expired
rows. Only the production ledger implements `recordRejectedAnswer`, so a personal ledger keeps no
answer text. A failure to record is logged (`reasoning.rejected_answer_not_recorded`) and never
changes the attempt's outcome. The operator lists and shows them (`reasoning rejected`).

## Failure/concurrency brake policy `role-failure-brake.v1`

Independently of spend caps, **five unresolved or conclusively failing runs per role per reservation
UTC day** bound new primary runs across all workers, personal universes and production together.
The shared budget advisory lock protects check + reservation. A held/unknown/written-off receipt
occupies a slot; success or `not_sent` releases it; conclusive failure keeps a `conclusive_failure`
boolean even when its spend reservation is fully refunded or the personal attempt is erased.
The next new primary run returns `refused: failure_brake`, before quota/transport. Changing role
version/provider/model or raising spend limits does not clear that role/day brake. A new UTC day
uses its own admission window. Existing outcomes, reconciliation and the one bounded repair remain
available; the brake is not a retry or a queue and never cancels accounting of work already admitted.

No additional identity metadata is retained: one business run can occupy at most one matching
receipt. A failed primary cannot repair; a repair follows a conclusively settled invalid primary
(which holds no slot); a `not_sent` replacement releases its predecessor; unknown/written-off never
starts a later paid attempt. CI regressions exercise these cases and cross-scope admission races.
The migration backfills still-present failures; failures erased before this schema cannot be recovered
from older receipts, which lacked an outcome marker. Rolling old workers may finish work but do not
enforce the new brake; enforce the policy only after all reasoning workers run this revision.

Primary attempts stopped before dispatch (for example unavailable quota) must recheck the role brake before a new primary reservation. Reusing reserved work or replaying a settled answer remains possible; the single admitted repair remains bounded by its run. This prevents staging unlimited quota-stopped runs and bypassing the brake after quota recovers.

Spend caps retain precedence when both a cap and the failure brake are full. Both checks and the new reservation remain under the same shared budget advisory lock; the ordering does not release a brake slot or allow an extra dispatch. Recovery integration cases use separate template-derived databases, so one case's deliberate unresolved liabilities cannot prevent another case from exercising its intended state transition.

## Tables

| Table                          | Migration              | Holds                                                                                                                                                                                                           | Erasure                                                                                                                                                                                                            |
| ------------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `reasoning.business_runs`      | `0006`, `0009`, `0032` | One row per module run: owner module, purpose, privacy epoch, role id/version, policy version, provider, model, context bundle ref and item refs, `state`, `fence`                                              | Erased with the universe once it has no attempts left                                                                                                                                                              |
| `reasoning.external_attempts`  | `0006`, `0009`, `0032` | One row per external call attempt: step, state, request hash, dispatch identity, remote id, usage, quota observation, outcome code, the validated output or validator issues, write-off reason and `cli:<name>` | Settled attempts are erased with the universe; `dispatched`/`unknown` and unproved reserved ones stay marked/redacted as unresolved liability; erasure reports `pending` until legitimate accounting resolves them |
| `reasoning.protected_requests` | `0009`                 | The exact request bytes (`bytea`, 1 B – 256 KiB), their SHA-256 (the database checks it equals the bytes' hash), `erasure_class`, `expires_at` (default 48 h)                                                   | Expires and is purged; erased with the universe even for an open attempt                                                                                                                                           |
| `reasoning.usage_receipts`     | `0009`                 | The minimal accounting identity per attempt: role, provider, model, UTC day, reserved and reported tokens, state. **No universe, purpose, context or output**                                                   | Not personal; kept so global and per-role budgets and late usage stay honest                                                                                                                                       |

Personal rows are keyed `(universe_id, id)`, each attempt is tied to its run, and each protected
request to its attempt, by composite foreign keys that reference `identity.universes` with
`ON DELETE RESTRICT`. CHECK constraints say what a row can say about the state machine: a
`written_off` attempt has a reason, an actor and a time; every state past `reserved`/`not_sent`
has a dispatch identity and time. The erasure declaration is `adapters/erasure.ts` (built with
`declareErasure`); it also declares the non-row store `minimax/request-copies`: MiniMax keeps copies of what it was sent under
its own retention, which no eraser of ours can reach (the privacy copy must say so, D-021).

### Erasing a person's attempts, and late accounting

Erasure locks the existing personal root, then run IDs and attempt IDs in order, before deleting
protected requests or changing receipts. Retained runs/attempts receive an immutable
`privacy_erased_at` marker. Run purpose becomes the fixed `privacy-erased` sentinel; context
bundle/item refs are NULL. Attempt output, issues, quota and dispatch actor are NULL; freeform
write-off reason/actor become fixed sentinels. Only bounded safe message IDs and exactly seven
code-owned outcome categories can survive: OUTCOME_NOT_RECORDED, TRANSPORT_OUTCOME_UNKNOWN,
AUTHORITY_REFUSED, QUOTA_UNAVAILABLE, SUCCEEDED, REJECTED and REQUEST_EXPIRED. Any other outcome
code is NULL. SQL CHECKs reject private writes and marker triggers reject clearing/re-timing a
marker. No production/Cutroom table or public authority is changed.

The marker serializes with ledger settlement on the attempt lock. Settlement classifies receipt
state and the role-failure bit from the original evidence BEFORE discarding private payload;
usage/state/reservation/day/dispatch identity remain honest. Personal scope charges read the
retained receipts through their attempt IDs, so deleting payload cannot refund a no-usage answer.
A retained current-day personal attempt without the matching minimal receipt (attempt ID, role
ID/version, provider/model, budget window and reserved tokens) refuses budget admission with a
fixed accounting error. No missing/mismatched receipt is fabricated or treated as zero spend;
legitimate state/usage differences are not an immutable-identity mismatch.
Global/role receipts and brakes survive eventual personal deletion. Existing eventual terminal
row deletion still resets the documented per-scope allowance; changing that policy belongs to the
later selective-clear design, not this prerequisite.

Only a freshly locked reserved row with NULL dispatch ID/time and its exact held receipt may
atomically become not_sent/released under the root fence. Missing/inconsistent proof stays pending
and redacted. A dispatched intent means possibly sent, even before send starts: privacy, timeout,
404 or absent payload never releases it or authorizes a resend. An already running process may
still hold bytes; this cannot recall provider/backup copies. No eraser invokes a provider.

Admission/dispatch/protected replay refuse marked work. Every committed answer is re-read from
the ledger before return, never synthesized from local private settlement details. A missing or
marked personal answer is ineligible. Written-off receipts can receive idempotent late usage even
after their personal attempt was deleted; late output is never restored or applied. A later
authorized retry may remove the exact old terminal rows; a future selective-clear coordinator
must not repeat a universe-wide cleanup against fresh post-clear data.

This is a payload/accounting prerequisite, not the complete privacy operation: epoch/barrier,
durable operation progress, client purge, selective Keep/Social preservation and completion copy
remain separate. Drain old personal Reasoning workers before using this schema/eraser; a CHECK
refusal from an incompatible old writer is not a successful financial-settlement rollout.

### Storage at rest, backups and retention

Protected request bytes are ordinary `bytea` in PostgreSQL: there is **no application-level
encryption**. They are readable by the database role of the world's programs (`ks2_<world>`) and by
`postgres`, are never selected except by the harness (and its reuse of a `reserved` attempt's own
bytes), and sit on the server's disk like every other personal row. The nightly `pg_dump` backups
(`ops/vps/backup`, `docs/v2/operations/backups.md`) include them: bytes that exist at dump time live
on in that dump (root-only, mode 0600) until it ages out after `KS_BACKUP_KEEP_DAYS` (14). So the
worst case between a request and its disappearance everywhere on our side is the retention
(`KS_REASONING_REQUEST_RETENTION_HOURS`, default 48 h) plus the dump retention. Erasing a universe
does not reach existing dumps (backups.md); lower the retention, not the policy, if that window is
too long. The purge **never deletes the bytes of a `dispatched` attempt** (the sweep resolves it
first) and settles an expired `reserved` attempt `not_sent` (`REQUEST_EXPIRED`, reservation
released) before its bytes go, so no attempt is left waiting for bytes that no longer exist; a
redelivery reserves a fresh attempt with fresh bytes.

## Attempt state machine

`reserved → dispatched → succeeded | failed | unknown`, `reserved → not_sent`,
`unknown → reconciled | written_off`. `dispatched` means _may have been sent_: a later delivery
that finds it marks the attempt `unknown` and **never resends**; so does the scheduled sweep when no
delivery ever comes back (a crash after dispatch). An answer that arrives for an `unknown` attempt
is recorded as `reconciled`; for a `written_off` attempt only its usage is recorded (on the
receipt) and the answer is never applied.

Cutroom is not a reasoning role. Its Reel orders keep a ledger of the same states in Content
(`content.reel_attempts`), because a Reel request is a content production request with its own
budget in the shared pool, not a model call.

## How `propose` is built (`application/propose.ts`)

`makeScopedReasoningHarness` is the one engine. A proposal runs as named steps that pass their
values explicitly; no step keeps state in a closure flag.

1. **Admission** (`admitProposal`, pure). The first failing check names the refusal: no provider,
   an invalid role, run or context, or fewer context items than the role needs. Nothing is
   recorded or reserved yet.
2. **Purge** (`makeOpportunisticPurge`), described below.
3. **Primary attempt** (`runPrimary`). The request is encoded (a request over the protected
   store's limit is refused `request_too_large`), planned (`planAttempt`: exact bytes, hash,
   reservation and budgets) and handed to `executeAttempt`, which does the steps in the next
   section. `outcomeOf` reads the finished attempt back as a typed outcome.
4. **Repair** (`runRepair`), only after a conclusively invalid answer and unless the caller set
   `allowRepair: false`. It reads the kept refused answer when the role asks for it, builds the
   richest request that fits (answer and notes, then the answer alone, then the findings alone) and
   runs a second attempt caused by the first.

**Purge.** Before the first attempt a proposal may delete expired protected request bytes, so
expiry does not depend on the scheduled job being on time. It is ledger-owned bookkeeping in its own
short transaction, with no authority check: it deletes up to 500 expired request bodies of **any**
run in the database (never those of a dispatched attempt, and expired `reserved` attempts are first
settled `not_sent`) and logs `reasoning.requests_purged`. It runs at most once per
15 minutes (`settings.purgeIntervalMs`) per engine; a personal call builds an engine each time, so
the personal guard keeps the throttle per process instead. A failure is logged
(`reasoning.purge_failed`) and swallowed: a purge never fails a proposal, the interval is spent either
way, and the scheduled `reasoning.purge-expired-requests` job is the backstop.

**Personal runs.** `makeBoundPersonalHarness` builds the same engine for each call with the ledger
and `withScope` of `application/personal-guard.ts`. The guard rechecks the owner's authority under the
personal lock before every private read or write, and still lets every outcome be accounted after
authority is gone. What one call has learned (the planned attempt, whether the latest refusal came
from revoked authority, whether anything settled) lives in one `PersonalCall` object. An authority
refusal is answered as a `refused` outcome, never thrown; `output_ineligible` is reported when an
attempt was already settled.

## One attempt, step by step (`application/execute-attempt.ts`)

1. **Ledger inspection** (shared engine; personal adapters first acquire their fresh gated root): an attempt of a run admitted at another privacy epoch is refused
   (`run_mismatch`) and one of a closed run answers `run_closed`; an attempt recorded with another
   request hash is refused (`request_mismatch`); a settled one is answered from the ledger (a kept
   answer is returned again without a second paid call); a `dispatched` one becomes `unknown`.
2. **Admission** (`withPersonalScope`, authority checked): admit or compare the run (including its
   epoch); re-read the step under the lock; check the three budgets; write the attempt (`reserved`),
   its protected request bytes and its usage receipt together.
3. **Quota preflight** (no transaction): an _observation_ recorded on the attempt, not a
   reservation. Anything but `available`/`not_applicable` settles the attempt `not_sent`
   (`QUOTA_UNAVAILABLE`, charges nothing); a later delivery may reserve a new attempt of the same
   step, at most four.
4. **Dispatch intent** (`withPersonalScope`, authority rechecked): `reserved → dispatched`, with a
   new dispatch identity and the process that dispatched.
5. **Transport** (no transaction, exactly one invocation of the stored bytes). The network guard
   wraps every transport and throws inside a transaction (blueprint §19); the harness accepts only
   a `GuardedModelPort`, a type only `guardedModelPort` can produce.
6. **Settlement** (ledger-owned short transaction with the receipt, independent of current
   authority): `succeeded` with usage and the validated, redacted output or the validator's issues;
   `failed` with the provider's code; `unknown` (timeout, reset or interrupted read after the
   request may have left).
7. **Eligibility** (personal private reads use a fresh gated root, with the existing authority check): an answer for an authority that no longer holds (for example a
   privacy reset while the call ran) is recorded but never handed over (`output_ineligible`).

**Repair**: after a conclusively invalid answer, exactly one repair attempt: a new admitted attempt
with its own reservation, `causation_attempt_id` = the first attempt, sending the validator's
structural findings. The findings are built from the role's schema only: names the schema declares,
array positions, the placeholder `[key]` for the keys of a record or map, `?` for anything else,
fixed issue codes, and the schema's own expectations (types, bounds with their unit, allowed
values). No string the model chose (a key, a value, a message) is ever part of these findings or of
the ledger's issue record. A role may also opt in (`repairWithPreviousAnswer`, honoured only for
nonpersonal production, whose ledger keeps refused answers) to have the refused answer repeated in
the repair: escaped and delimited as `<previous-answer>` data in the user message, never in the
system text, so the model revises instead of rewriting. The role may also derive `repairNotes` from
that answer (for the Scroll writer, the source words it copied): bounded to 2,000 characters,
escaped and sent as `<repair-notes>` data after the previous answer, so third-party text such as
public research never reaches the system text. A personal role never receives its refused
answer; neither does a production role that does not opt in, nor one whose answer was not the
model's own text (a raw provider reply) or was cut at the bound. Never after `unknown` or `failed`.

## Budgets

Three daily caps (UTC day), checked at admission under a transaction advisory lock: **global**,
**role** (across personal and production work) and **scope** (one universe or the production root). A reservation charges one request and
`request bytes + max output tokens` tokens; reported usage replaces the estimate at settlement.
What settles:

| Outcome                                                                                   | Charge                                                                                             |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `succeeded` / invalid answer / `reconciled` with an answer                                | the reported input + cached + output tokens; the whole reservation when the provider reported none |
| `failed` (conclusive) or a late conclusive rejection that reconciled an `unknown` attempt | the reported usage if any; **nothing, and not a request**, when none was reported                  |
| `unknown`                                                                                 | the whole reservation, until usage is known or it is written off (a write-off does not refund it)  |
| `not_sent`                                                                                | nothing                                                                                            |

Accounting is deliberately conservative: input tokens include cache writes and the charge adds cache
reads on top, which may count a cached read twice if MiniMax's `input_tokens` already includes it
(an open question to check on the first real response on dev, `providers-and-secrets.md`).
Erasing a universe deletes its attempts, which are what the **scope** cap counts, so a person who
repeatedly clears their history gets a fresh per-scope allowance each time; the role and global caps
count the receipts, which survive, and bound that (review m4: accepted, no change). Defaults and
variables: `docs/v2/engineering/runtime-configuration.md`.

## Lock order (blueprint §19)

personal root (`identity.universes`, taken by `withPersonalScope`) → this universe's rows (run,
attempt, request, receipt) → the budget advisory lock (`pg_advisory_xact_lock`, only ever taken
after the personal root, so it cannot deadlock with it). Ledger-owned settlement, write-off, purge,
sweep and the operator's reads take no root lock: they lock one attempt or receipt row at a time
(`skip locked` where they batch).

## Jobs

| Queue                                 | Schedule                                | Work                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reasoning.sweep-dispatched-attempts` | every 5 minutes (pg-boss cron, worker)  | Move attempts `dispatched` for longer than the request deadline + 2 minutes to `unknown` (`OUTCOME_NOT_RECORDED`, receipt `unknown`). A crash after dispatch leaves such an attempt; without the sweep nothing could see it (not `reasoning unknown`, not the write-off) and the universe's erasure waited on it for ever. Never resends; a late answer from a live handler still reconciles. |
| `reasoning.purge-expired-requests`    | every 15 minutes (pg-boss cron, worker) | Delete protected request bytes past `expires_at`, in batches that skip locked rows, keeping those of `dispatched` attempts and settling expired `reserved` ones `not_sent` first. The attempt, its hash and its receipt stay. The harness also purges opportunistically (at most every 15 minutes per process).                                                                               |

Model calls themselves are made inside the owning module's job handlers. A queue delivery is never
permission to repeat a paid call: the handler calls `propose`, which consults the ledger first.

## Operator commands (the worker release tree)

`node dist/operator.js reasoning write-off --attempt <uuid> --reason <text>` (`unknown →
written_off`; records the reason and `cli:<name>`; never resends; does not prove the provider
stopped; does not refund the reservation), `reasoning unknown [--limit n]` (what awaits
reconciliation: IDs, provider, model, role, code, time — no context), `reasoning sweep-dispatched
[--older-than-seconds n]` (the sweep on demand, default 900), `reasoning purge-expired`,
`reasoning rejected [--limit n]` (refused production answers, newest first, without their text) and
`reasoning rejected --attempt <uuid>` (one with its text and findings).
Results are one JSON line on stdout, diagnostics on stderr; exit 0 done, 2 refused or not
applicable, 1 failure. This is the worker tree's `dist/operator.js`; the API tree has its own
(`issue-sign-in`). How to run it on a server: `docs/v2/operations/environments.md`.

## Providers (`adapters/`)

- `minimax/`: the MiniMax token-plan transport (Anthropic-compatible `…/anthropic/v1/messages`;
  `MiniMax-M3.1-Flash`, `MiniMax-M3`, `MiniMax-M2.7`, `MiniMax-M2.7-highspeed`). One `fetch` per
  attempt, no SDK, no retries, no redirects, one deadline over the whole exchange, bounded request
  and response. `MiniMax-M3.1-Flash` is sent `thinking: adaptive` (it refuses `disabled`),
  `MiniMax-M3` `disabled` (the one verified value) and the M2.7 models none; `thinking` blocks and a leading `<think>…</think>` are dropped from the
  **answer** only, and thinking tokens are recorded as reasoning tokens. The reply's `model` must
  equal the configured model: an unknown name is silently served by another model, so a mismatch
  is a conclusive `MODEL_MISMATCH` failure that still charges the reported usage. Mapping: 200 →
  answer or an `unreadable` marker (which carries the bounded raw body for diagnostics); 4xx/429/500/503/529 → conclusive failure; 502/504, a timeout, a reset or an
  interrupted read after the request may have left → `unknown`; refused/DNS/TLS before sending, an
  oversized request, or an abort before the request left → a conclusive failure the ledger records
  as `failed` with a `NOT_CONNECTED_*` / `REQUEST_TOO_LARGE` / `ABORTED_BEFORE_DISPATCH` code (it
  charges nothing and is not retried inside the run). Only a sanitised error code is kept: the
  provider's `error.type` if it is one of the known Anthropic-compatible types, otherwise
  `UNRECOGNISED` (never an error message, header or URL from the provider). The key travels in a
  header and is never logged or stored.
- The labelled CI **fixture** model (`success`, `malformed`, `truncated`, `timeout_after_dispatch`,
  `rate_limited`, `not_connected`, `server_error`, `gateway_timeout`, `hold`) is test support
  (`tests/integration/support/fixture-model-port.ts`), not part of this package or its build.
- `recording.ts`: the recording boundary (CF-10). Every string and every object key in a parsed
  answer is cleaned, at every depth the harness accepts, before it is stored or returned:
  credential-bearing URL queries dropped (`http(s)`, other schemes such as `s3://` and `oss://`, and
  scheme-less `//host/…`), key- and token-shaped values masked. The harness refuses an answer nested
  deeper than 32 levels (`OUTPUT_TOO_DEEP`) before redacting; if a deeper value ever reached the
  boundary it would be replaced by `[redacted-too-deep]`, never passed through.

## Provider choice and deployment

`KS_REASONING_PROVIDER` defaults to **`none`**: every `propose` is refused (`provider_unavailable`)
before anything is reserved. That is deliberate: a worker that has not been told to talk to a
provider never does, whatever else is in its environment, and CI never exercises a real provider
(tests inject the fixture model). The v2 worker unit sets `minimax` and reads
`/etc/knowscroll/secrets/shared/minimax.env`; the Ansible role checks that the file exists and
defines a token-plan key before it installs the unit (`ops/vps/ansible/roles/worlds_v2`).

**Blast radius.** The worker is one process: a missing `minimax.env` stops the unit, and a key of
the wrong shape (or an invalid `KS_MINIMAX_*`/`KS_REASONING_*` value) makes it exit with
`config.invalid` — which takes the worker's other consumers (evidence apply, the identity and
reasoning sweeps) down with it. The precheck keeps that from happening at deploy time; at run time
it is the usual rule that a bad setting stops the program. The API never receives the key.

## Diagnostics (D-017)

`reasoning.provider_configured` (once at worker start), `admission_refused`, `attempt_reserved`,
`quota_observed`, `attempt_dispatched`, `attempt_settled`, `attempt_written_off`, `dispatched_swept`,
`requests_purged`, `purge_failed` carry run/attempt IDs, provider, model, role, prompt version,
outcome and reason **codes**, usage counts and durations. Never a prompt, context, answer, error
message, URL or key. Failed jobs store code-only output.

For newly refused JSON extraction, the existing `OutputIssue.detail` can additionally contain
`json-refusal.v1`: fixed `phase` (framing/syntax), `framing` and `prefix` enums, an allowlisted
syntax category and a bounded UTF-16 character count of the trimmed candidate (the whole trimmed
reply for an invalid fence). Categories are `expected_property`,
`expected_comma_or_separator`, `unterminated_string`, `unexpected_end`, `unexpected_token` or
`other`. Recognised fixed engine prefixes follow [Node 22's V8 templates](https://github.com/nodejs/node/blob/v22.23.0/deps/v8/src/common/message-template.h);
unknown messages fall back to `other`. Classification is a diagnostic hint, not a new parser.
Only the built-in parser inspects object-shaped refused text; no recovery, lexical repair or
broader extraction is attempted. Bare/exact-one-fence acceptance, refusal codes, size/depth limits,
schemas, authority, transport and the single repair are unchanged.

Neither reply snippets, keys, values, URLs, credentials, parser error text, unexpected characters,
offsets nor answer hashes enter these issues. Invalid raw answers remain unretained; issues alone
are persisted and used as trusted repair feedback. Logs still carry only the existing refusal code.
Old refusals are not re-diagnosed: ledger replay uses their original stored issues, so existing
repair request bytes/hashes stay stable. `issueFor`'s legacy detail and harness framing `hp2` are
unchanged. This cannot diagnose earlier replies that were intentionally never retained.

## Accounting without private payloads

### Production run accounting

`ProductionReasoningHarness.readProductionRunAccounting(scope, runId)` reads at most 32 attempt
IDs, steps/states, provider/model and nullable reported token usage under a live production root
capability. It checks the root and run generation again in that transaction; expired/forged
capabilities throw, foreign/missing runs return `not_found`, and an oversized ledger returns
`accounting_limit` instead of incomplete totals. No request, output, context, quota or write-off
reason is selected. Content can retain both primary and repair identities and print honest usage
without reaching reasoning SQL or its private payload stores. Usage comes from the retained receipt,
including late usage reported after write-off; the attempt's state and identity remain unchanged.

### Selective Clear and accounting ownership

Status: implemented, CI-tested against real PostgreSQL.

`clearReasoning` is an opt-in owner port. Capture locks the personal run/attempt/receipt chain and
returns at most 1000 bounded exact accounting tuples, never protected bytes or outputs. Missing or
mismatched receipt proof and oversized identities refuse acceptance before a barrier is published.
Selective erasure uses the existing irreversible markers and dispatch-proof release rule; the full
`reasoningErasure.erase` behavior is preserved. Requests, context, outputs, issues, quota and freeform
actor/reason fields are removed while minimal marked current-day attempt links survive. Their
presence preserves the existing per-scope current UTC budget join across repeated Clear operations.

After core completion `verifyAndPrune` accepts only a live accounting capability and visits its
captured identities, in run → attempt → receipt lock order. It preserves unresolved charges and all
global/role receipts. Terminal links remain through their UTC window, then only those exact old IDs
and orphaned marked parent runs may be pruned. The normal ledger still owns settlement, write-off,
late usage and brakes; Clear neither refunds nor increases caps. A later delivered answer remains
redacted under the #337 marker checks. No production or pool row is read or changed here.

## Recording-aware personal roles (Planner and Cartographer)

Status: implemented in source and covered by CI against real PostgreSQL with fixture owners. The
Planner and Cartographer roles are off by default (`KS_PLANNER_ENABLED=0`,
`KS_CARTOGRAPHER_ENABLED=0`) and the path has not been exercised on a running system.

### The facade

`RECORDING_REASONING_HARNESS` is a separate required personal facade. The existing generic
`ReasoningHarness.propose` is only actual initial 1/on compatibility; a first real toggle
permanently makes omitted provenance ineligible. Generic close also requires actual 1/on and an
unproved legacy run, so an old in-flight applier cannot commit through closure after a toggle. Neither path can stamp a later current generation
onto an old run. This foundation installs no Role/API/UI/worker control and changes no production
root, transport profile, cap, accounting state machine, reservation policy or paid permission.

### Run identity and proof

A strict `PersonalRecordingPurpose` contains version `personal-role-purpose.v1`, actual account,
universe, privacy epoch, original recording generation, business run, current claim, immutable full
frozen-context SHA and exact model-context SHA. Its only owner/purpose pairs are
planner/personal-planner and geography/personal-cartographer. All fields are required; bounded UUID,
int32 positive odd generation and lowercase 64 hex parsing has no default/coercion/transform. Own
undefined, extra/hidden/symbol fields, inherited objects and getters refuse. The facade snapshots
purpose, authority and exact bounded context items; no mutable input or live capability crosses
network waits. It hashes the actually supplied `{bundleRef,items}` independently before entry.

### Owner proof

Both `CHECK_PLANNER_RECORDING_RUN` and `CHECK_GEOGRAPHY_RECORDING_RUN` are mandatory real owner
ports. A closed dispatcher selects the exact pair; missing functions fail construction/DI. Each
owner must read its exact account/generation/status/claim/hash HEADER before any frozen body,
refuse old/malformed provenance, and recompute the complete frozen-context and model-items hashes.
Prepared status, active business run and unexpired exact current claim remain required. A string
purpose or a caller-supplied hash cannot authorize a private read. Actual owner implementations
and their positive combined fixture graph remain separately allocated dependencies.

### Reads and writes under authority

`proposePersonal({run,role,context,recordingPurpose},signal)` adapts the unchanged shared attempt
engine with per-call personal access. BEFORE every `find`/`findLocked`, kept output/issues,
protected request replay, admission, reservation and dispatch it obtains the real personal root,
Identity own-account UPDATE gate once, original-generation/on capability and required owner proof.
It then checks the exact reasoning-run metadata/proof header. An existing row must bind actual
owner/purpose/epoch, role/version/policy/provider/model/bundle/refs, account/generation and both
hashes. NULL proof remains legacy unknown and cannot pass the new facade; a generic initial 1 call
cannot read a populated recording proof. No private output or validator issues enter the first
metadata selection. Before private attempt selection, a fixed 9-row raw prefix proves the at most 8
primary/repair sequence set and checks the exact planned request hash; changed same-ref text or
instructions refuse before kept output selection. Protected bytes are read through that SAME
transaction, exact run/attempt and hash, never a global unguarded replay query.

### Storage

Four nullable `reasoning.business_runs` proof columns are the only new storage dependency:
`recording_account_id`, `recording_generation`, `recording_context_sha256` and
`recording_model_context_sha256`. They are inserted together with a new proved run and compared
on retry; no legacy adoption/default/backfill is performed. Root owns their separate forward DDL
and codegen. This source preview normally includes the frozen schema 43 prerequisite `2c49e1f0`; that composition
remains source only and has no hosted fixture or runtime acceptance. Account linkage is declared; both full and selective erasers NULL all four proof
fields in the same irreversible privacy-marker update. Usage receipts/brakes/late accounting
remain unchanged and do not acquire account/context/proof data.

### Applying the result and closing the run

Application uses `withPersonalApply(authority,purpose,work(cap))` as its SOLE outer transaction.
It locks root→own UPDATE exactly once→original generation→owner proof/reasoning header before
private role context or semantic validation. It issues a callback-only private WeakMap membership
for the genuine `RecordingScopeTx`. `closePersonalRun` requires that same facade/callback/purpose
capability, rechecks current generation/owner/header and closes while the owner still has prepared
status and active claim. Only then may the callback write domain/owner terminal state; all effects
roll back together. Copied, forged, closed, common-only and other-facade capabilities cannot close.
No nested root, copied account SQL or second own-gate acquisition is used.

### Accounting for a run after Clear

`readPersonalRunAccounting(scope,runId,readExpectedBinding)` takes the own-account gate as the FIRST gate under a
fresh already-held current personal root/epoch. It deliberately has no original-generation gate.
After that gate, it invokes the fixed owning callback ONCE to read only the exact minimal Role
header and return the closed owner/purpose/account/epoch/original-generation binding. The callback
may retain that header locally for necessary retirement in this SAME transaction. No private
body, context or hashes are read. Reasoning compares only its own minimal exact header and a
proof-complete boolean; partial, mismatched or legacy NULL provenance stays unproved. Neither
NULL nor an absent original generation is stamped with current server state.
It selects only the exact run's at most 8 attempt IDs/steps/states with a 9-row overflow sentinel;
invalid sequence/proof/overflow yields unavailable, never zero liability. `not_found` means the
exact parent is absent (the existing validated composite FK forbids orphan attempts). It proves
ZERO RETAINED attempts, not never-admitted history, zero cost or a payment conclusion. This
supersedes the earlier design assumption that Reasoning had no pruning path: full erasure deletes
only non-reserved/non-dispatched/non-unknown attempts and their empty parent; selective Clear
keeps all attempts, redacts proof, and deletes only empty parents; later Clear prune preserves
held/unknown receipts and reserved/dispatched/unknown attempts. A reservation may become
not_sent only through the existing exact dispatch-null/matching held receipt transition under
the root. Planner/Geography Clear deletes their old headers, and fresh epoch/own-account fencing
precedes callback invocation. Missing, erased or old-epoch Role header must return unavailable.
No absent ledger is closed or settled; accounting history/receipts/budgets are never reset.
Existing empty runs
can be conclusively no-attempt while that root is held. Dispatched/unknown/reserved states remain
unresolved. The reader changes no claim, run, output, receipt, reservation, job or accounting state.
It cannot close unknown work or authorize resend. Necessary owner cleanup must occur in that same
transaction before releasing the root and cannot acquire another own gate.

### While recording is paused or revoked

Settlement, late usage, purge, sweep and write-off keep their independent existing transactions
while paused or revoked. A sent result is accounted even when a later private read refuses; no
answer is synthesized from in-memory settlement details. Pause between quota and dispatch sends
nothing; pause after committed dispatch does not promise recall of that one invocation. An old
unknown remains a financial/owner blocker until conclusive disposition, never a resumed attempt.

### Verification and what remains

New unit fixtures test strict purposes/getters/closed owner selection/exact input hashes and
private-query refusal. PostgreSQL fixtures exercise real root/account wait races, initial 1 replay
revocation, exact pre-read request hashes, late usage/no-repair while off, payload-free accounting
and copied/expired/common-cap close denial. Explicit deny-owner fixtures prove refusals only;
they do not stand in for positive Planner/Geography proof adapters or complete recording pipeline
wiring. Existing assertions remain; the dispatch/erasure fixture now targets actual dispatch CAS
instead of an obsolete transaction-entry count. All suites run only in hosted Actions. Root must
compose frozen DDL, actual role proofs, positive graph, PC availability/composite-witness consumers
and all growth writers before any recording control or runtime acceptance.

### Releasing a reservation after authority is revoked

The personal wrapper may invoke `releaseUndispatchedPersonal` only after actual gates establish
true revocation; a generic protected-read refusal is insufficient. This optional capability belongs to the actual personal PostgreSQL
ledger; the production ledger and production execution engine are unchanged. Absence means
necessary accounting is unavailable: the public result remains refused and the reservation held.
It is never a successful no-op, fake settlement, or permission to resend.

The short ledger-owned transaction locks the exact original run, at most nine raw attempt rows
(eight plus overflow sentinel) in run/step index order, then the selected receipt. It compares
original epoch, complete descriptor/proof and planned request fingerprints in SQL without
selecting context, output, issues or request bytes. Only the latest valid logical-step reservation
can stop; earlier sequences must be not_sent. Any dispatched/unknown row, dispatch identity or
timestamp, missing/mismatched held receipt, malformed sequence, overflow or unproved binding
leaves accounting unchanged. A reserved→not_sent AUTHORITY_REFUSED transition and exact held→released
receipt commit together. Dispatch CAS locks the same attempt and requires reserved: cancellation
winning prevents dispatch; dispatch winning prevents release. No root/account/generation is
adopted and no personal capability, new attempt, model request or semantic effect is issued.
Existing settlement, Clear, late usage, request expiry, caps and failure brakes retain authority.

A settled answer can still encounter a busy/revoked protected read. The response reveals no
private attempt/output identity after revocation. Under a busy root it fails closed; the exact
SUCCEEDED attempt and settled usage receipt survive for the same-business replay after a fresh
valid gate. Hosted fixtures verify one send, exact financial rows, finally-released fixture locks,
missing capability and negative cancellation proofs. These are authored CI cases, not local suite
execution, provider evidence or runtime acceptance.

The private `accountingRevoked` fact never reaches ProposeOutcome. After the one actual active
own-account gate, only known original-generation/on refusal qualifies; purpose/account mismatch,
owner/claim/header/hash denial, busy, unavailable and malformed dependency do not. Before an own
gate can run, only trusted server SYSTEM authority may classify actual root epoch/status/barrier
revocation. An account actor's old-epoch root refusal remains unproved and held, because the root
checks epoch before ownership; it cannot infer another account's authority. No extra root/own
probe, Identity SQL copy or generation adoption is introduced.

Both initial lookup cancellation and the existing authority-refused pre-dispatch/admission
settlement branches use this same classified capability. Other settlements (quota, conclusive
provider results, unknown, late usage) remain unchanged. A stale claim A cannot cancel current
claim C's still-reserved identical request. Actual owner fixtures use the real Planner request,
store, current PC snapshot, hashes, both owner checkers and durable recovery markers; the fixture
role remains a financial protocol probe and never applies a personal proposal.

## Tests

Unit tests sit next to the code in `domain/`, `application/` and `adapters/`; the personal
authority guard is pinned by `application/personal-guard.test.ts` and the schema reader by
`domain/schema-structure.test.ts`. Real-PostgreSQL integration tests:
`tests/integration/modules/reasoning-attempts.test.ts` (every transition),
`reasoning-harness.test.ts` (budgets, quota, protected store, repair, guard, canary, runs),
`reasoning-recovery.test.ts` (the crash sweep, what a failure costs, epochs and closed runs, the
database constraints, the purge, the stored-output bound), `reasoning-caps-race.test.ts` (the caps
under concurrency), `reasoning-boundary.test.ts` (redaction at depth, feedback without model-chosen
strings), plus `infrastructure/erasure.test.ts` and `transaction-guard.test.ts`. Release tests from
the built tree: `release/worker-operator-journey.test.ts`. Role evaluation: the separate Vitest
project `role-evaluation` (`tests/integration/evaluation/`), labelled synthetic contexts
(insufficient evidence, malicious retrieved text, duplicate delivery, rejected and good proposals,
source correction, privacy reset) run through the real harness with the fixture model; it asserts
harness behaviour, not content quality. CI never calls a provider.
