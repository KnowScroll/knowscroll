# ADR-0033 — Authorized Scroll Ask answers: fresh authority, worker-only provider, validated application

Date: 2026-09-24. Status: accepted by the coordinator under the owner's six-phase mandate for
[#132](https://github.com/KnowScroll/knowscroll/issues/132), parent #72. Builds on ADR-0012
(admission and reconciliation), ADR-0013 (fairness), ADR-0016/0017 (Ask facts and sealed Ask
context) and ADR-0019 (terminal retirement), all of which stay in force. Migration 0028.

## Context

A reader can record an Ask about the Scroll in front of them (`recorded_only`), and every durable
primitive a paid answer needs already exists: a sealed Ask context bound to the original session,
fair admission with reservations, a one-time dispatch authorization, minimal receipts and
settlement, idle withdrawal, Clear and retirement. What is missing is the consumer: something
that turns a reader's explicit request into exactly one admitted job, sends exactly the reserved
bytes from the worker only, and lets the reply change state only after it passes a validator.

## Decision

1. **Fresh authority, per Ask.** `POST /v1/asks/:askId/answer {clientRequestId, expectedPrivacyEpoch}`
   is the only path from an Ask to execution. It must come from the Ask's original live session
   (ADR-0017), while recording is not paused, with a configured and enabled answer route. In one
   transaction, under ADR-0017's lock order, it creates the direct interactive Job
   (`intent_id = askId`), compiles the sealed Ask context, creates the Step, derives the request
   bytes (`serializeAskAnswerRequest`), enqueues fairly, and records one `ask_answer_request`.
   An exact retry returns the same request; another key for the same Ask is 409. Nothing sweeps,
   backfills or replays older recorded-only Asks into jobs.
2. **Worker-only provider.** Only `apps/worker` runs the answer loop and holds provider
   configuration. The API never imports a provider. Transports: `fixture` (deterministic, for
   tests and journeys; its replies are labelled fixture) and `minimax` (MiniMax-M3 through the
   subscription route only, `sk-cp-` key from the worker's environment, quota preflight of at least
   25% interval and weekly remaining before every request, no retries). The bounded live
   experiment's request cap is also a `route_quota` bucket, so admission, not goodwill, stops a
   run at its limit.
3. **Exactly the reserved bytes, once.** The worker rebuilds the request from the sealed context
   with the same pure serializer; the hash must equal the reserved one before
   `invokeReasoningOnce` may authorize dispatch. There is no automatic second Attempt: an unknown
   outcome, refusal, error or deadline fails the answer and is shown as such.
4. **Validated application.** Provider text is evidence, not authority. After a recorded
   successful receipt, `applyAskAnswer` locks universe → original session → Job → Step, requires the
   current lease fence, current epoch, eligible output authority and a clean context recheck, then
   runs the answer validator (now `ask-answer-v2`, see the amendment below): one JSON object with
   exactly `answer`, `basis` and `limits`; every basis quote found in the sealed Scroll; bounded
   lengths; nothing said about the reader. It writes one immutable `ask_answer` (`answered`,
   `not_in_source`, or `rejected` with reasons and no provider text) and completes or fails the Job.
5. **Reading and cancelling.** `GET /v1/asks/:askId/answer` returns the request's state and, once
   applied, the answer with its basis quotes and limits. `POST /v1/asks/:askId/answer/cancel`
   withdraws an answer that has not started (ADR-0018 idle withdrawal); a running one ends by its
   own outcome or deadline.
6. **Private history.** Answer requests and answers are erased by Clear and Reset (before the
   Ask facts and after the execution graph), exported, and survive seven-day retirement of the
   execution graph, which they do not reference by foreign key. Late output after cancel, deadline
   or Clear is discarded by the existing output-authority and epoch rules and creates nothing.

## Alternatives rejected

- Running every recorded Ask automatically: an Ask is a fact, not consent to a paid task (ADR-0016).
- Returning provider text directly: violates ADR-0012; a plausible answer with invented quotes
  would reach the reader.
- Automatic retry after an unknown outcome: may pay twice for one request; the reader asks again.

## Consequences

Migration 0028; `packages/core/src/reasoning/ask-answer.ts`; `packages/db/src/reasoning-answers.ts`;
`apps/worker/src/reasoning/answer-worker.ts` and provider transports; API routes; Android Ask
controls. The existing J004 proof keeps covering the protocol; the answer path adds its own
crash, unknown-outcome, cancellation and Clear checks and one live, bounded, authorized round trip.

## Amendment — validator v2 (2026-09-24)

Live measurement on the Android journey's question ("Does this Scroll say anything about tides?")
rejected five of five MiniMax-M3 replies with `shape_basis_item`: the quotes did not come as exact
`{"quote": string}` items. v1's exact item shape guarded nothing the other rules do not: only the
quote is ever kept, and it is still checked word for word against the Scroll. `ask-answer-v2`
therefore takes a basis item given as a bare string or as an object whose `quote` is a string,
drops every other key unread (never stored or shown), and changes nothing else. Rejections now carry
content-free sub-codes next to `shape_invalid` (`shape_keys`, `shape_types`, `shape_basis_item`, …)
so a live failure can be diagnosed without recording provider text.
