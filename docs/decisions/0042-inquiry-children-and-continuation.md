# ADR-0042 — Inquiry children and native continuation: one bounded repair step, child Jobs on one budget, and more reasons to look

Date: 2026-09-24. Status: accepted by the coordinator for [#166](https://github.com/KnowScroll/knowscroll/issues/166)
(parent #132). Extends ADR-0038 (background bridge inquiries), whose "Not in this version" names this
work, and folds in the follow-ups of [#153](https://github.com/KnowScroll/knowscroll/issues/153).
Builds on ADR-0012/0013 (admission, reconciliation, fairness), ADR-0017 (sealed contexts),
ADR-0018/0019 (withdrawal, retirement), ADR-0031 (bridges only the validator admits), ADR-0032 (the
personal model) and ADR-0033 (quota preflight before every request). Migration 0036.
Target design: `docs/architecture/target/21-REASONING-RUNTIME.md` §3, §8 and §9,
`22-GLOBAL-EXECUTION.md` §10.

## Context

A background inquiry (ADR-0038) is one step: one request, one reply, one decision. Four live
MiniMax-M3 requests showed the cost of that. A proposal the validator refuses is simply lost, even
when the refusal names exactly what to fix (`analogy_limit_missing`, a side without evidence). The
target runtime's answer is a bounded repair: a new Step with its own Attempt, in the same
conversation, with M3's thinking blocks kept where they were (§8, §9).

An inquiry may also offer up to three pairs at once, and the model can only answer for one. Child
Jobs let each pair be asked on its own, but only if they cannot multiply the budget.

Finally, only a new place asks for a look. A source correction that revokes a connection between two
of the reader's places, or a change in what the reader seems to be doing there, is as good a reason.

## Decision

### 1. Native continuation is a bounded repair

1. **Only after a validator refusal.** When `bridge-validator-v1` refuses a proposal from a background
   inquiry (`submitBridgeProposal` decides `rejected`, which is stored as before), the Job may take one
   continuation step. The route declares `max_continuation_steps` (default 1, at most 2). A shape
   rejection, `none`, a truncated reply, a provider error or an unknown outcome never continues.
2. **Same conversation, thinking blocks in place.** The continuation request is the first request's
   messages, then the prior assistant turn exactly as the provider returned it (every native content
   block, M3 `thinking` blocks included, in their original order), then one user turn naming the
   validator's reason codes and asking again for one JSON object as specified. System, model, output
   bound and thinking mode are the route's, as before. The request must still fit the route's bounds
   (at most 16 KB, at most 4,096 output tokens); if it would not, there is no continuation and the
   refusal stands.
3. **Protected runtime data.** The prior assistant turn is kept in `background_inquiry_continuation`,
   one row per continuation Step: never exposed to a client, never exported, never evidence, never in a
   receipt. It goes with its Step (Clear, Reset, deletion and ADR-0019 retirement erase it).
4. **Recorded, then scheduled fairly; nothing is sent from the applying transaction.** Under the Job's
   fence and after the context recheck, the applying transaction records the refusal, supersedes the
   refused Step (its output withdrawn), creates the next Step on the same sealed context, stores the
   continuation row with the exact request hash and size, releases the lease (the Job is `queued`
   again) and enqueues the new Step fairly in the same class. The scheduler admits it later as a fresh
   Attempt with a fresh reservation vector drawn from the same budgets.
5. **Everything else is unchanged.** Before the continuation is sent the provider quota is checked
   again (§3 below); the reserved bytes are rebuilt from the sealed context and the protected turn and
   sent exactly once through `invokeReasoningOnce`; an unknown outcome is held and never resent; the
   sealed context is rechecked at admission, before sending and before applying, and any change
   discards it (never sent, never re-sent). Its reply is decided exactly like the first: a shape
   rejection, `none`, or the validator's decision, and a second refusal continues only within the
   route's bound. The inquiry's outcome names its final Attempt and proposal.

### 2. Truncation is its own outcome

A reply whose stop reason is `max_tokens` did not finish its turn (with adaptive thinking, the
thinking can consume the whole output budget). Its text is not parsed. The inquiry fails with reason
`truncated`, and it never continues. The transport reports the stop reason with its observation.

### 3. A dispatch spends the quota check

ADR-0033 §2 requires the quota preflight before every request. The worker's readiness gate still
trusts a success for a short window while work waits to be admitted. Any pass that dispatched a
request now spends that window, so the next request, a continuation included, is preceded by a fresh
preflight.

### 4. Optional bounded child inquiries

1. **The route decides.** `max_children` is 0 (the default: never), 2 or 3.
2. **Created when the inquiry opens, with its fresh authority.** When a due inquiry has at least two
   candidate pairs and the route allows children, the inquiry becomes a parent. In the same
   transaction as ADR-0038 §4:
   - the parent's Job is created `waiting`, with no Step, and holds the family's Job budget;
   - up to `max_children` child inquiries are created, one pair each. Each has its own Job (`queued`),
     sealed context, Step and request bytes, and each is enqueued fairly.
3. **Children never open a budget.** Each child inherits the parent's budget owner (the universe), class
   (`background_inquiry`), epoch, deadline, `through_sequence` and route (its request cap and quotas),
   and binds the parent's Job bucket. Continuations of a child draw from it too.
4. **Each child is an ordinary inquiry.** It runs as §1 describes, and its reply becomes state only
   through `submitBridgeProposal` in its own applying transaction. Each child holds one pair, and each
   pair's disconnection is a sealed fact, so the family admits at most one bridge per pair.
5. **The parent settles with its last child.** When the transaction that closes a child leaves no open
   sibling, it settles the parent: the parent inquiry becomes `settled`, and its Job `completed`.
6. **Withdrawal reaches the whole family.** Turning consent off or pausing withdraws the parent and every
   child not yet sent. A child in flight is not cancelled remotely, but its reply is discarded at
   apply. Clear and Reset erase the parent, its children and all their rows.
7. **What the reader sees.** The daily limit counts inquiries the mailbox opened, never children. The
   reader's list shows each child (its pair, status and outcome) and never the parent. "While you were
   away" and Relics read the children's outcomes exactly as before.

### 5. Triggers beyond place formation

1. **Typed causes.** Each mail records `cause_kind`: `place_formed` (ADR-0038 §3), `bridge_revoked` or
   `hypothesis_changed`, with a reference to its cause. Every kind is coalesced exactly as ADR-0038 §3:
   it joins the pending inquiry, at most 16 causes. It needs consent in the current epoch while
   recording, and the schema refuses a cause the rules below do not allow.
2. **A personal hypothesis changed.** `refreshPersonalModel` runs under the universe lock. In the same
   transaction it mails when a rule hypothesis is created, or changes its status, about the anchor of
   one of the reader's live planets or regions. The mail names that hypothesis and its new revision.
3. **A source correction revoked a bridge between two of the reader's live places.** A correction holds
   the exclusive substrate lock. Universe locks come before it (ADR-0031 §7), so its transaction cannot
   mail. The worker mails instead, each pass, under each universe's lock with fresh checks. It takes
   revoked bridges, shared or the reader's own, between two of their live planets or regions, revoked
   after their consent was last turned on and after recording last resumed. Each revocation is mailed
   at most once per universe. The connection may then be looked for again from current evidence.
   A reader whose pending inquiry already holds its 16 causes is passed over until that inquiry opens
   (#182), so their revocations never fill a pass and hold up another reader's.
4. **No backfill.** Nothing earlier than the current consent (or the last resume) becomes paid work, and
   old recorded-only Asks stay untouched.

### 6. The #153 follow-ups

1. **A stale head never stalls the scheduler.** Fair admission skips a head whose sealed context is
   refused (`context_*`), like any other ineligible head. The sweep withdraws it (never sent). The
   passes no longer depend on that sweep to make progress.
2. **An answers-only worker.** When the inquiry route shares the answer route's scheduler, the answer
   pass schedules nothing unless it can also run an inquiry, and it asks the inquiry transport's
   readiness (its quota preflight) as well as its own.
3. **Each offered claim belongs to one side.** A claim that bears on both sides (a shared ancestor) is
   offered only to the side it is nearer to, ties to A. The sealed pair records the side, so the
   parser credits it where it was offered (selection `inquiry-pairs-v2`).
4. **Consent applies only its newest request.** The guard refuses a consent row that names any request
   but the newest one of its universe and epoch.
5. **"Asked" means sent.** When an inquiry closes, the database records whether any request of its Job
   was dispatched (`sent`). A pair counts as asked in this epoch only if its request was sent, and it
   counts no longer once a bridge between the pair has been revoked since.
6. **One live run at a time.** The live runners take an exclusive lock on the shared session ledger for
   the whole run, so two runs started at once cannot both pass its check. Every live tool counts through
   one module, `scripts/lib/session-ledger.ts`, under that one lock (#181): the runners and the Android
   journey (through its command line) for the whole run, `write-scrolls.ts` for each request. A missing
   ledger is refused, never created with a default cap, and each count is written durably.

## Not in this version

A continuation after a shape rejection, or after a provider error. Retries. Recompiling a
continuation on a different route. Children that open further children. Child inquiries of other
kinds. The web client's controls.

## Consequences

- Migration 0036:
  - route: `thinking`, `max_continuation_steps`, `max_children` (immutable like the rest of it);
  - `background_inquiry`: `role`, `parent_id`, `sent`, status `settled`, and a rewritten guard;
  - `background_inquiry_continuation`: the protected turn, immutable, erased with its Step;
  - `inquiry_mail`: typed causes;
  - the consent guard.
- `packages/core/src/reasoning/bridge-inquiry.ts`: continuation bytes, disjoint sides.
- `packages/db/src/reasoning-inquiries.ts`: opening a parent, typed mail, revocation mail.
- `packages/db/src/reasoning-inquiry-execution.ts`: continuation, truncation, settling the parent.
- `packages/db/src/semantic/personal-model.ts`: hypothesis mail.
- `packages/db/src/reasoning-fairness.ts`: the skip.
- The worker passes and transports: `content` and `stopReason` observed, a readiness gate a dispatch
  spends.
- The live runners' ledger lock.

## Verification

- Pure tests: continuation bytes, disjoint sides.
- SQL/worker tests over the labelled fixture transport:
  - a refused proposal, then an admitted one on continuation;
  - thinking blocks carried in place;
  - truncation;
  - continuation refused when the context changed;
  - a lost acknowledgement held as unknown, never resent;
  - competing workers (#182: deterministic, one worker holding a continuation in flight while another
    runs; two schedulers claiming one ready Job at once are covered by the fairness SQL tests; two
    polling one policy at once mostly block each other, see `docs/operations/reasoning-sql-fairness.md`);
  - consent off and Clear during a continuation call;
  - a stale continuation output discarded;
  - children on one budget, settling and withdrawal;
  - fairness with children against a direct Ask;
  - each trigger, and no backfill;
  - each #153 item, failing first.
- A process-level crash test mid-continuation.
- One bounded live continuation, run by the coordinator.
