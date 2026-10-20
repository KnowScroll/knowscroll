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
  the run (`closeRun`, fence + 1) in that transaction.

Every request is framed by the harness: a fixed preamble and the role's instructions in the system
text; every context item as escaped, delimited data in the user text (`domain/prompt.ts`), so
retrieved text cannot close its block or pose as instructions. Answers must be exactly one JSON
object (bare or in one fenced block) that passes the role's schema (`domain/output.ts`).

## Tables

| Table | Migration | Holds | Erasure |
|---|---|---|---|
| `reasoning.business_runs` | `0006`, `0009` | One row per module run: owner module, purpose, privacy epoch, role id/version, policy version, provider, model, context bundle ref and item refs, `state`, `fence` | Erased with the universe once it has no attempts left |
| `reasoning.external_attempts` | `0006`, `0009` | One row per external call attempt: step, state, request hash, dispatch identity, remote id, usage, quota observation, outcome code, the validated output or validator issues, write-off reason and `cli:<name>` | Settled attempts are erased with the universe; `dispatched`/`unknown` ones stay as unresolved liability and the eraser reports `pending` |
| `reasoning.protected_requests` | `0009` | The exact request bytes (`bytea`, 1 B – 256 KiB), their SHA-256, `erasure_class`, `expires_at` (default 48 h) | Expires and is purged; erased with the universe even for an open attempt |
| `reasoning.usage_receipts` | `0009` | The minimal accounting identity per attempt: role, provider, model, UTC day, reserved and reported tokens, state. **No universe, purpose, context or output** | Not personal; kept so global and per-role budgets and late usage stay honest |

Personal rows are keyed `(universe_id, id)`, each attempt is tied to its run, and each protected
request to its attempt, by composite foreign keys that reference `identity.universes` with
`ON DELETE RESTRICT`. The erasure declaration is `adapters/erasure.ts`; it also declares the
non-row store `minimax/request-copies`: MiniMax keeps copies of what it was sent under its own
retention, which no eraser of ours can reach (the privacy copy must say so, D-021).

## Attempt state machine

`reserved → dispatched → succeeded | failed | unknown`, `reserved → not_sent`,
`unknown → reconciled | written_off`. `dispatched` means *may have been sent*: a later delivery
that finds it marks the attempt `unknown` and **never resends**. An answer that arrives for an
`unknown` attempt is recorded as `reconciled`; for a `written_off` attempt only its usage is
recorded (on the receipt) and the answer is never applied.

## One `propose`, step by step (`application/execute-attempt.ts`)

1. **Ledger inspection** (no lock): an attempt recorded with another request hash is refused
   (`request_mismatch`); a settled one is answered from the ledger (a kept answer is returned again
   without a second paid call); a `dispatched` one becomes `unknown`.
2. **Admission** (`withPersonalScope`, authority checked): admit or compare the run; re-read the step
   under the lock; check the three budgets; write the attempt (`reserved`), its protected request
   bytes and its usage receipt together.
3. **Quota preflight** (no transaction): an *observation* recorded on the attempt, not a
   reservation. Anything but `available`/`not_applicable` settles the attempt `not_sent`
   (`QUOTA_UNAVAILABLE`, charges nothing); a later delivery may reserve a new attempt of the same
   step, at most four.
4. **Dispatch intent** (`withPersonalScope`, authority rechecked): `reserved → dispatched`, with a
   new dispatch identity and the process that dispatched.
5. **Transport** (no transaction, exactly one invocation of the stored bytes). The network guard
   wraps every transport and throws inside a transaction (blueprint §19).
6. **Settlement** (ledger-owned short transaction with the receipt, independent of current
   authority): `succeeded` with usage and the validated, redacted output or the validator's issues;
   `failed` with the provider's code; `unknown` (timeout, reset or interrupted read after the
   request may have left).
7. **Eligibility** (lock-free read): an answer for an authority that no longer holds (for example a
   privacy reset while the call ran) is recorded but never handed over (`output_ineligible`).

**Repair**: after a conclusively invalid answer, exactly one repair attempt: a new admitted attempt
with its own reservation, `causation_attempt_id` = the first attempt, sending the validator's
structural findings (paths, codes, schema expectations — never the rejected answer, never received
key names). Never after `unknown` or `failed`.

## Budgets

Three daily caps (UTC day), checked at admission under a transaction advisory lock: **global**,
**role** (across universes) and **scope** (one universe). A reservation charges one request and
`request bytes + max output tokens` tokens; reported usage replaces the estimate at settlement;
an `unknown` attempt stays charged at its reservation until usage is known or it is written off
(a write-off does not refund it); `not_sent` charges nothing. Defaults and variables:
`docs/v2/engineering/runtime-configuration.md`.

## Lock order (blueprint §19)

personal root (`identity.universes`, taken by `withPersonalScope`) → this universe's rows (run,
attempt, request, receipt) → the budget advisory lock (`pg_advisory_xact_lock`, only ever taken
after the personal root, so it cannot deadlock with it). Ledger-owned settlement, write-off, purge
and the operator's reads take no root lock: they lock one attempt or receipt row at a time.

## Jobs

| Queue | Schedule | Work |
|---|---|---|
| `reasoning.purge-expired-requests` | every 15 minutes (pg-boss cron, worker) | Delete protected request bytes past `expires_at`, in batches that skip locked rows. The attempt, its hash and its receipt stay. The harness also purges opportunistically (at most every 15 minutes per process). |

Model calls themselves are made inside the owning module's job handlers. A queue delivery is never
permission to repeat a paid call: the handler calls `propose`, which consults the ledger first.

## Operator commands (the worker release tree)

`node dist/operator.js reasoning write-off --attempt <uuid> --reason <text>` (`unknown →
written_off`; records the reason and `cli:<name>`; never resends; does not prove the provider
stopped; does not refund the reservation), `reasoning unknown [--limit n]` (what awaits
reconciliation: IDs, provider, model, role, code, time — no context) and `reasoning purge-expired`.
Results are one JSON line on stdout, diagnostics on stderr; exit 0 done, 2 refused or not
applicable, 1 failure. This is the worker tree's `dist/operator.js`; the API tree has its own
(`issue-sign-in`). How to run it on a server: `docs/v2/operations/environments.md`.

## Providers (`adapters/`)

- `minimax/`: the MiniMax token-plan transport (Anthropic-compatible `…/anthropic/v1/messages`,
  `MiniMax-M3` default). One `fetch` per attempt, no SDK, no retries, no redirects, one deadline
  over the whole exchange, bounded request and response. `thinking` is disabled in the request and
  a leading `<think>…</think>` is stripped from the **answer** only. Mapping: 200 → answer or an
  `unreadable` marker; 4xx/429/500/503/529 → conclusive failure; 502/504, a timeout, a reset or an
  interrupted read after the request may have left → `unknown`; refused/DNS/TLS before sending →
  not sent. Only a sanitised error code is kept (never an error message, header or URL from the
  provider). The key travels in a header and is never logged or stored.
- `fixture/`: the labelled CI fixture (`success`, `malformed`, `truncated`, `timeout_after_dispatch`,
  `rate_limited`, `server_error`, `gateway_timeout`, `hold`). Selected only by tests and role
  evaluations; no deployed composition root can select it.
- `recording.ts`: the recording boundary (CF-10). Every string in a parsed answer is cleaned before
  it is stored or returned: credential-bearing URL queries dropped, key- and token-shaped values
  masked.

## Diagnostics (D-017)

`reasoning.provider_configured` (once at worker start), `admission_refused`, `attempt_reserved`, `quota_observed`, `attempt_dispatched`,
`attempt_settled`, `attempt_written_off`, `requests_purged`, `purge_failed` carry run/attempt IDs, provider, model,
role, prompt version, outcome and reason **codes**, usage counts and durations. Never a prompt,
context, answer, error message, URL or key. Failed jobs store code-only output.

## Tests

Unit tests: `domain/` and `adapters/` next to the code. Real-PostgreSQL integration tests:
`tests/integration/modules/reasoning-attempts.test.ts` (every transition),
`reasoning-harness.test.ts` (budgets, quota, protected store, repair, guard, canary, runs), plus
`infrastructure/erasure.test.ts` and `transaction-guard.test.ts`. Role evaluation: the separate
Vitest project `role-evaluation` (`tests/integration/evaluation/`), labelled synthetic contexts
(insufficient evidence, malicious retrieved text, duplicate delivery, rejected and good
proposals, privacy reset) run through the real harness with the fixture model; it asserts harness
behaviour, not content quality. CI never calls a provider.
