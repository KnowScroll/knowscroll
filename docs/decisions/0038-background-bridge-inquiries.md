# ADR-0038 — Background bridge inquiries: standing consent, a coalesced mailbox, and proposals only the validator admits

Date: 2026-09-24. Status: accepted by the coordinator for [#132](https://github.com/KnowScroll/knowscroll/issues/132)
(bounded background intent), parent #72. Builds on ADR-0012/0013 (reasoning storage and fairness),
ADR-0017 (sealed contexts), ADR-0018/0019 (withdrawal, retirement, reconciliation), ADR-0031
(bridges only the validator admits), ADR-0033 (Ask answers) and ADR-0036 (the reader's places).
Target design: `docs/architecture/target/21-REASONING-RUNTIME.md` §4 and §8, `22-GLOBAL-EXECUTION.md`.

## Context

ADR-0033 made one direct intent executable: a reader's tap on their own Ask. #132 also requires
bounded *background* work: reasoning nobody tapped for, which must still be authorised, coalesced,
fair, cancellable and unable to change state except through deterministic validation. The storage
already anticipates it (`reasoning_job.class = 'background_inquiry'`, `wake_kind = 'dirty'` with
a `dirty_scope` and `through_sequence`), but nothing consumes it.

ADR-0031 names the first real background task: model-proposed bridges. When the reader's places
change (ADR-0036), there may be a real, sourced connection between two of their places that no
editor wrote down. A model can look for one; only `bridge-validator-v1` can admit it.

## Decision

1. **Standing consent is the authority.** Background model work runs for a universe only while its
   reader has turned on "Look for connections between my places" (one `background_inquiry_consent`
   row per universe and privacy epoch; set or cleared by an explicit request from a live session of
   that universe, with a client request id and the expected epoch). It carries a daily limit on
   inquiries (default 3, at most 10). Turning it off, pausing recording, Clear and Reset each stop
   everything not yet sent, as below. Consent is personal history: erased by Clear/Reset and
   exported. Nothing is ever backfilled: consent never turns earlier changes into paid work, and
   old recorded-only Asks are untouched.
2. **A deployment route, like answers.** `background_inquiry_route` (operator-installed; transport
   `fixture` or `minimax`; model; input/output bounds; request and token caps; per-owner and per-job
   capacity; coalescing delay; job time-to-live; enabled). Without an enabled route, consent can be
   given but nothing runs, and the client says so.
3. **The mailbox coalesces.** When the Cartographer forms a planet or region in a universe with
   active consent, recording not paused, the same transaction appends an `inquiry_mail` row
   (universe, epoch, kind `bridge_between_places`, the causing delta, a global sequence). At most
   one inquiry per (universe, kind) is `pending` at a time; later mail while it is pending joins it
   as another cause (bounded). A pending inquiry becomes due once its first mail is older than the
   route's coalescing delay, so a burst of new places costs one inquiry, not many.
4. **The worker creates the Job, with fresh authority.** For a due inquiry the worker rechecks, in
   one transaction under the universe lock: consent active for the current epoch, not paused, route
   enabled, today's limit not reached. It then compiles the context. If no candidate pair exists,
   the inquiry closes as `nothing_to_ask` with no Job and no provider call. Otherwise it creates the
   Job (`class = background_inquiry`, `wake_kind = dirty`, `dirty_scope = inquiry:bridge_between_places`,
   `through_sequence` = the last mail sequence it covers), its sealed context, one Step and the exact
   request bytes, and enqueues it fairly (ADR-0013) under the route's buckets. Direct Asks keep
   their interactive class; the existing class-aware fairness decides between them, and a test proves
   a queue of background work never starves a direct Ask.
5. **What the model is shown is sealed and small.** Candidate pairs: two of the reader's live
   planets or regions whose anchors are not parent/child, have no active relation or admitted
   bridge between them in either direction (shared or this universe), are not suppressed by the
   reader's "seems wrong", and have not already been put to an inquiry in this epoch. At most three
   pairs, in a deterministic order (claims mentioning both anchors first, then concept codes). For
   each anchor, at most eight currently supported claims about it (key, statement, source title),
   and the supported claims that mention both. The context records each claim's support and each
   pair's disconnection as dependencies; they are rechecked at admission, before sending, and before
   applying. Any change discards the inquiry as stale; it is never re-sent.
6. **One call, no replay.** The worker sends exactly the reserved bytes once through
   `invokeReasoningOnce`. An unconfirmed outcome is held (ADR-0012) and never retried; a provider
   error fails the inquiry. Leases, fences, retirement and the recovery sweep are the existing
   ADR-0019 machinery.
7. **Provider text is never authority.** The reply must be exactly one JSON object: either
   `{"proposal": <bridgeProposalPayload>}` for one offered pair, citing only offered claim keys, or
   `{"none": true}`. Anything else closes the inquiry as `rejected` (`shape`). A proposal goes through
   `submitBridgeProposal` (universe scope, `proposerKind = model`, `proposerRef` = the Attempt id) in
   the applying transaction, after the context recheck. The validator's decision is the outcome:
   `admitted` (a personal bridge, which the existing continuations and Composer already read, and
   which "seems wrong" already suppresses) or `rejected` with the validator's reason codes. No
   provider text is stored outside a payload that parsed and was decided; `none` stores nothing.
8. **Stopping.** Turning consent off, pausing, Clear and Reset withdraw pending inquiries and
   queued Jobs (ADR-0018 withdrawal, cause recorded). A call already in flight is not cancelled
   remotely, but its reply is discarded at apply because the recheck fails. Clear/Reset erase the
   universe's mail, inquiries, consent and personal proposals/bridges (ADR-0031 §6 ordering).
9. **The reader sees what was looked for.** `GET /v1/inquiries` lists the reader's inquiries, newest
   first, with the pair names, status (`waiting`, `looking`, `found`, `nothing_found`,
   `did_not_hold_up` with the validator's reasons, `nothing_to_ask`, `failed`, `withdrawn`) and, for
   `found`, the bridge's sentence and evidence. Android's Privacy & account screen gets the switch,
   its limit and this list; an admitted bridge appears as a continuation where either side is read.

## Not in this version

Optional child inquiries with inherited budgets and native provider continuation (M3 thinking
blocks) are the next slices; this one is a single-step Job. Other triggers (hypothesis changes,
corrections), other inquiry kinds, and the web client's controls.

## Consequences

Migration 0032 (route, consent, mail, inquiry, owner bucket; guards: at most one pending inquiry
per universe and kind, mail and inquiry rows immutable except their permitted transitions, consent
changes only with a recorded request); `packages/core/src/reasoning/bridge-inquiry.ts` (pure:
candidate pairs, request bytes, reply parsing); `packages/db/src/reasoning-inquiries.ts`;
`apps/worker/src/reasoning/inquiry-worker.ts`; HTTP `PUT /v1/inquiries/consent`,
`GET /v1/inquiries`; contract `packages/contracts/src/inquiries.ts`; Android privacy screen.

## Verification

Pure tests (pair selection, bytes, reply parsing; mutants); HTTP/SQL tests over a fixture
transport (coalescing, daily limit, consent off/pause/Clear during queue and during a call, stale
context, no replay, fairness against a direct Ask); a process-level crash test; an emulator journey;
then a bounded live experiment on the owner-authorised MiniMax route with receipts that hold
statuses, counts and hashes only.
