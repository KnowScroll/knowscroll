# reasoning

The shared execution engine for model calls (blueprint §15): the harness module-owned roles call,
the attempt ledger that accounts for every external, possibly paid request, the protected request
store, and the provider transports behind `ModelPort`. It owns no role: a role's instructions,
output schema, semantic validator, context builder and applier live in its own module. The harness
owns admission, budgets, transport, parsing, limits and attempt tracking. No tool loops.

## Using it from a module

```ts
const outcome = await harness.propose({ run, role, context, limits }, signal);
```

- `run`: `{ id (stable across deliveries), authority (PersonalAuthority), ownerModule, purpose, policyVersion }`.
- `role`: `{ id '<module>.<role>', version, instructions, outputSchema (zod), maxOutputTokens, minContextItems?, budget? }`.
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
  (`KS_MINIMAX_REQUEST_TIMEOUT_MS`, default 60 s, at most 300 s) plus the database waits (each
  personal-scope lock wait is at most `KS_SCOPE_LOCK_TIMEOUT_MS`, 5 s, and there are two), and a
  repair doubles it. Declare `expireInSeconds ≥ 2 × (10 + request deadline in seconds + 10) + 30`
  (190 s with the defaults, 670 s at the 300 s maximum). Below that, pg-boss expires a delivery that
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
`REASONING_HARNESS` and the queue declarations. The harness factory, its ports, the attempt ledger
and the model transport are deliberately not exported there (a boundary probe and the dependency
rules enforce it), so a module cannot build its own harness with its own ledger or transport, and an
ESLint rule keeps global `fetch`, Node's HTTP clients and provider SDKs out of everything but
`infrastructure/` and `reasoning/adapters/` (`pnpm lint:probe:network` proves it bites).

## Nonpersonal Scroll production (#232 foundation)

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
required. Both default off. This PR does not activate either. An operator may disable the root or
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

| Table | Key / ownership | Retention |
|---|---|---|
| `production_scopes` | Fixed `scroll-supply` root; enabled + generation | Retained, operator controlled |
| `production_runs` | `(scope_id, id)`, root FK, admitted generation and monotonic run fence | Audit retained; no automatic run retention job yet |
| `production_attempts` | `(scope_id, id)`, composite production run FK; same state/dispatch/write-off checks | Audit retained, including unknown liabilities |
| `production_requests` | `(scope_id, attempt_id)`, composite production attempt FK, exact hash-checked bytes; `nonpersonal_production` | Same configured request expiry/purge and database backup policy as personal bytes |

These tables have **no identity/universe foreign key and no personal erasure entry**. Personal erasure
cannot own, retain or delete global supply. The existing minimal `usage_receipts` table is shared:
production reservations and settlements participate in the same global and per-role caps; the scope
cap counts the production root's own attempts. Attempt + exact request + receipt reserve atomically;
settlement + receipt commit atomically even after the root is disabled/replaced. A paid answer after
revocation is accounted but never returned as applicable output. Sweep, purge, unknown-list and
write-off include both personal and production tables, independent of production enablement.
Unknown/write-off never authorises another send, and late usage only updates the kept receipt.

### Failure/concurrency brake policy `role-failure-brake.v1`

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

## Tables

| Table | Migration | Holds | Erasure |
|---|---|---|---|
| `reasoning.business_runs` | `0006`, `0009` | One row per module run: owner module, purpose, privacy epoch, role id/version, policy version, provider, model, context bundle ref and item refs, `state`, `fence` | Erased with the universe once it has no attempts left |
| `reasoning.external_attempts` | `0006`, `0009` | One row per external call attempt: step, state, request hash, dispatch identity, remote id, usage, quota observation, outcome code, the validated output or validator issues, write-off reason and `cli:<name>` | Settled attempts are erased with the universe; `dispatched`/`unknown` ones stay as unresolved liability and the eraser reports `pending` until the sweep and an operator resolve them |
| `reasoning.protected_requests` | `0009` | The exact request bytes (`bytea`, 1 B – 256 KiB), their SHA-256 (the database checks it equals the bytes' hash), `erasure_class`, `expires_at` (default 48 h) | Expires and is purged; erased with the universe even for an open attempt |
| `reasoning.usage_receipts` | `0009` | The minimal accounting identity per attempt: role, provider, model, UTC day, reserved and reported tokens, state. **No universe, purpose, context or output** | Not personal; kept so global and per-role budgets and late usage stay honest |

Personal rows are keyed `(universe_id, id)`, each attempt is tied to its run, and each protected
request to its attempt, by composite foreign keys that reference `identity.universes` with
`ON DELETE RESTRICT`. CHECK constraints say what a row can say about the state machine: a
`written_off` attempt has a reason, an actor and a time; every state past `reserved`/`not_sent`
has a dispatch identity and time. The erasure declaration is `adapters/erasure.ts`; it also
declares the non-row store `minimax/request-copies`: MiniMax keeps copies of what it was sent under
its own retention, which no eraser of ours can reach (the privacy copy must say so, D-021).

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
`unknown → reconciled | written_off`. `dispatched` means *may have been sent*: a later delivery
that finds it marks the attempt `unknown` and **never resends**; so does the scheduled sweep when no
delivery ever comes back (a crash after dispatch). An answer that arrives for an `unknown` attempt
is recorded as `reconciled`; for a `written_off` attempt only its usage is recorded (on the
receipt) and the answer is never applied.

## One `propose`, step by step (`application/execute-attempt.ts`)

1. **Ledger inspection** (no lock): an attempt of a run admitted at another privacy epoch is refused
   (`run_mismatch`) and one of a closed run answers `run_closed`; an attempt recorded with another
   request hash is refused (`request_mismatch`); a settled one is answered from the ledger (a kept
   answer is returned again without a second paid call); a `dispatched` one becomes `unknown`.
2. **Admission** (`withPersonalScope`, authority checked): admit or compare the run (including its
   epoch); re-read the step under the lock; check the three budgets; write the attempt (`reserved`),
   its protected request bytes and its usage receipt together.
3. **Quota preflight** (no transaction): an *observation* recorded on the attempt, not a
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
7. **Eligibility** (lock-free read): an answer for an authority that no longer holds (for example a
   privacy reset while the call ran) is recorded but never handed over (`output_ineligible`).

**Repair**: after a conclusively invalid answer, exactly one repair attempt: a new admitted attempt
with its own reservation, `causation_attempt_id` = the first attempt, sending the validator's
structural findings. The findings are built from the role's schema only: names the schema declares,
array positions, the placeholder `[key]` for the keys of a record or map, `?` for anything else,
fixed issue codes, and the schema's own expectations (types, bounds with their unit, allowed
values). No string the model chose (a key, a value, a message) ever reaches the next request or the
ledger, and neither does the rejected answer. Never after `unknown` or `failed`.

## Budgets

Three daily caps (UTC day), checked at admission under a transaction advisory lock: **global**,
**role** (across personal and production work) and **scope** (one universe or the production root). A reservation charges one request and
`request bytes + max output tokens` tokens; reported usage replaces the estimate at settlement.
What settles:

| Outcome | Charge |
|---|---|
| `succeeded` / invalid answer / `reconciled` with an answer | the reported input + cached + output tokens; the whole reservation when the provider reported none |
| `failed` (conclusive) or a late conclusive rejection that reconciled an `unknown` attempt | the reported usage if any; **nothing, and not a request**, when none was reported |
| `unknown` | the whole reservation, until usage is known or it is written off (a write-off does not refund it) |
| `not_sent` | nothing |

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

| Queue | Schedule | Work |
|---|---|---|
| `reasoning.sweep-dispatched-attempts` | every 5 minutes (pg-boss cron, worker) | Move attempts `dispatched` for longer than the request deadline + 2 minutes to `unknown` (`OUTCOME_NOT_RECORDED`, receipt `unknown`). A crash after dispatch leaves such an attempt; without the sweep nothing could see it (not `reasoning unknown`, not the write-off) and the universe's erasure waited on it for ever. Never resends; a late answer from a live handler still reconciles. |
| `reasoning.purge-expired-requests` | every 15 minutes (pg-boss cron, worker) | Delete protected request bytes past `expires_at`, in batches that skip locked rows, keeping those of `dispatched` attempts and settling expired `reserved` ones `not_sent` first. The attempt, its hash and its receipt stay. The harness also purges opportunistically (at most every 15 minutes per process). |

Model calls themselves are made inside the owning module's job handlers. A queue delivery is never
permission to repeat a paid call: the handler calls `propose`, which consults the ledger first.

## Operator commands (the worker release tree)

`node dist/operator.js reasoning write-off --attempt <uuid> --reason <text>` (`unknown →
written_off`; records the reason and `cli:<name>`; never resends; does not prove the provider
stopped; does not refund the reservation), `reasoning unknown [--limit n]` (what awaits
reconciliation: IDs, provider, model, role, code, time — no context), `reasoning sweep-dispatched
[--older-than-seconds n]` (the sweep on demand, default 900) and `reasoning purge-expired`.
Results are one JSON line on stdout, diagnostics on stderr; exit 0 done, 2 refused or not
applicable, 1 failure. This is the worker tree's `dist/operator.js`; the API tree has its own
(`issue-sign-in`). How to run it on a server: `docs/v2/operations/environments.md`.

## Providers (`adapters/`)

- `minimax/`: the MiniMax token-plan transport (Anthropic-compatible `…/anthropic/v1/messages`,
  `MiniMax-M3` default). One `fetch` per attempt, no SDK, no retries, no redirects, one deadline
  over the whole exchange, bounded request and response. `thinking` is disabled in the request and
  a leading `<think>…</think>` is stripped from the **answer** only. Mapping: 200 → answer or an
  `unreadable` marker; 4xx/429/500/503/529 → conclusive failure; 502/504, a timeout, a reset or an
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

## Tests

Unit tests: `domain/` and `adapters/` next to the code. Real-PostgreSQL integration tests:
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
