# Scenarios: What if, Another perspective and the shared Scenario Planner

In a content thread a member can ask "What if…" (change a premise of the explanation) or for "Another
perspective" (the same facts through another lens), from the whole thread, a message or a shared snippet.
A Planner proposes a few directions. The member chooses one, or writes a complete request of their own.
Only that choice makes a branch: Quartermaster commissions one Scroll for it, the thread shows the branch
as a card that turns from preparing to ready, and every member opens it at their own pace. A what-if also gets a
**short answer card** about 30 seconds later (D-211), written by a worker and checked before it is shown.
Blueprint §14, §16 and §17; decisions D-006, D-037, D-046 and **D-049**. Nothing here is consumption
evidence: asking, choosing, being shown a card and opening a branch's Scroll are not a Keep, a position or
real-world coverage for anyone.

Status marks: **implemented** means merged with tests against real PostgreSQL. **Runtime-verified** means
used on a running system. This module is **implemented** and, for the flow, **runtime-verified locally**: on 24 Oct, in a
browser over a local PostgreSQL, API and worker with the real `MiniMax-M3.1-Flash` model, two people in a thread on a
generated Scroll made a What if, an Another perspective (from a message) and a What if on top of the first. Each became an
admitted Scroll both people opened, with no coverage and no topic. The review changes that followed (the audience on every
way in, reading on the caller's transaction, the premise rules) are covered by the integration tests below and were not
driven in a browser. It is not running on dev.

## What a member can do

| Action                       | Use case (`SCENARIO_USE_CASES`) | What it does                                                                                                                                                                                                                                                                                                                                                                                                                            | Status      |
| ---------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Ask for directions           | `draft`                         | Stores a private draft, sends one job. Starts no production. At most 20 a day.                                                                                                                                                                                                                                                                                                                                                          | Implemented |
| See the directions           | `readDraft`                     | `thinking`, `ready` (one clear idea, or two to three options), `failed` or `chosen`. Private to the asker.                                                                                                                                                                                                                                                                                                                              | Implemented |
| Choose                       | `choose`                        | Picks an option, or sends the member's own complete request. The only command that commissions. Idempotent.                                                                                                                                                                                                                                                                                                                             | Implemented |
| See the thread's branches    | `list`                          | Cards, oldest first, removed ones as bare placeholders, and the caller's own offers: the directions of their ready drafts that they have not chosen (at most 9; private, never another member's), and `opened`: the branches whose Scroll the caller activated ("Opened by you"), read from the caller's own exposures through experience's `ReadVisitedAssets`, never another member's. Polled and hinted, never a position of anyone. | Implemented |
| Remove a branch they started | `remove`                        | The card becomes a note; its Scroll closes, and a short answer it had is cleared.                                                                                                                                                                                                                                                                                                                                                       | Implemented |
| See a what-if's short answer | `list` (the card's `answer`)    | `making`, `ready` (assumption, answer, figures, labelled "made by KnowScroll") or `unavailable`. Thread members only; never a position, a current branch or who opened it. A perspective and an old branch have none.                                                                                                                                                                                                                   | Implemented |

Not built: Reel branches, a retry command for a failed branch (remove it and ask again), a discussion scoped to one
branch (it needs a scope on messages, which Social and idea rooms (#245) own), idea rooms, "Call it first" on a branch,
and a short answer for a perspective (D-213).

The branch view and the map of a thread (X03, X04) read only what `list` returns. A branch is one Scroll, so the view has
one item; nothing is invented to fill a sequence.

## The model: a tree of branches

`scenarios.nodes` holds the branches of one thread; each has one parent (the thread's root revision, or
another node at a revision). The rules are pure, in `domain/`:

- **What if**: one or two explicit changes and up to three things that stay the same. The premises that
  hold are the parent's plus these, at most four; a change to a subject the parent already assumes replaces
  it. A kept line may not name a subject an earlier branch assumes in other words
  (`kept_contradicts_premise`); one that restates it in the same words is listed once, among the
  assumptions. The client lists what already holds and lets a changed line add a premise or say which one it
  replaces; an edited suggestion keeps its subjects. Hypothetical status is inherited by every descendant.
- **Speculative** is its own fact, apart from "unclear". The Planner marks a direction `speculative` only when its
  premise contradicts established knowledge, and `needsConfirmation` when it is unclear or speculative (a speculative
  direction always asks to be confirmed). A branch is `speculative` when the member confirmed a speculative direction,
  or when it continues one that is. An edit of a direction names it (`fromOptionId`), and the server resolves the flag
  from the member's own draft and keeps it: changing a word of a speculative idea does not make it established. A
  request typed from scratch is never speculative. The flag is part of a branch's meaning (`meaningOf`), so an ordinary
  branch is never reused for a speculative twin or the reverse. It is a flag on the card that the client says in words
  ("Speculative scenario · not established science"), not a second status label beside Hypothetical (D-006 a). A
  speculative branch is hypothetical (a check on the table).
- **Replacing a premise.** A what-if's change may name the premise of an earlier branch it takes the place of
  (`replaces`, the Planner's `replaces: <subject> | null`). Code checks the name against the premises that hold, and a
  change that names one replaces it whatever its own subject says, in its place; a change that names none replaces only a
  premise of its own subject, as before. A change that says a held premise again in other words without naming it is not
  accepted from the Planner (it goes to the one repair): both would reach the writer. A change that names a premise under
  another subject must also share a content word with it, or it goes to the repair too: a premise is never dropped by a
  change that has nothing to do with it. The client shows each premise an option would take out, in its own words
  ("Replaces: …"), on the card, the summary and the confirm step, so the member agrees to what goes before choosing.
- **Another perspective**: a named lens, no change; the parent's premises and status are kept. A perspective
  on the unchanged root is not hypothetical.
- `planStep` is the one rule that checks a proposed or a hand-written step, so anything the Planner proposes
  can be chosen. `meaningOf` is the semantic key: the same parent, kind and change (or lens) is one live
  branch, so two members who ask for the same idea share one Scroll. `branchProgress` decides bind, send the
  next take, wait or fail, and gives a branch 30 minutes.

## Flow

1. `draft`: under the personal root, the caller's own gate and the thread's lock, checks that the person
   takes part and that the parent's revision is current, stores the draft and its receipt and sends
   `scenarios.suggest-draft` (IDs only) in the same transaction.
2. The worker runs the Planner (`scenarios.planner`, `planner.2`, policy `scenario-planner.v1`) on the
   personal reasoning harness, outside any transaction. The run is the draft's ID, so a redelivery never
   pays twice. It sees the member's words, the subject, the premises that hold and the last 12 messages,
   clipped, with authors as "you" or "member": no names, no IDs, no other thread. A late result is applied
   only if the asker still takes part in the thread; otherwise it is dropped.
3. `choose` (one transaction, thread lock held): rechecks standing and the parent's revision, builds the
   step with `planStep`, makes the node (or reuses the live one with the same meaning and says so),
   commissions the order through Quartermaster, and answers the receipt. Retrying, or two identical
   commands at once, make one node, one order and one job. A refusal writes nothing.
4. Quartermaster (`supply`, `COMMISSION_SCENARIO_ORDER`) applies two caps from its own ledger, records the
   order in Content and sends the production job for take 1. Content produces a made-to-order Scroll with
   the hypothetical or perspective writer rules (see `../content/production/README.md`).
5. `scenarios.resolve-branches` (every minute, idempotent) binds a preparing branch to its admitted Scroll,
   sends the next take of a rejected recipe (at most three), closes a branch that cannot be produced or is
   older than 30 minutes, and hints the thread's members.

## The short answer card (D-158, D-159, D-211, D-212)

Status: **implemented**, tested against real PostgreSQL with a labelled fixture model and in a browser at 390 by 844 and
1440 by 900. **Not yet run with the real model**: the coordinator runs it on dev and checks the served `model`.

- **Made by a worker, in the asker's allowance.** `choose` sends `scenarios.write-answer` (IDs only) in the transaction that
  makes a what-if's node. The step (`application/write-answer.ts`) runs on the asker's own scope, reads the branch's checked
  premise, the public subject and the claims the thread root's Scroll cites (`READ_SCROLL_EVIDENCE`, content), asks the role
  `scenarios.answer-card` (`answer-card.1`, one call and one repair, interactive) and stores the checked card in the node's
  row (`answer_state`, `answer`, `answer_settled_at`). The run is the node's ID, so a redelivery never pays twice and an attempt of
  unknown outcome is never resent. It sees the branch's premise (which may be a member's own typed sentences, as for the Scroll writer), the public subject and the cited claims, never the request text, a message or a name; with fewer than two claims to cite it asks no model.
- **Checked before it is shown** (`domain/answer-card.ts`, pure): every claim cites passages the code offered, every digit is a
  figure a cited passage or the branch's own premise states (a figure is a label in words and one number with its unit, written as a cited passage writes it), the assumption line is mandatory, no nine words in a row are copied, and
  at least one claim reads as reasoning ("would", "could", "likely"). What the branch changes and keeps is the checked premise
  itself, never the writer's words. A card that fails after the one repair is `unavailable`, never a lesser card.
- **The wait is honest.** `making` until the worker settles it. The minute sweep gives up after 12 minutes (`ANSWER_WAIT_LIMIT_MS`: a paid attempt and its repair can take 10) and
  the card says there is no short answer; a late answer finds the wait ended and is dropped. A removed branch, or a starter who left
  the thread, gets nothing stored. The answer arriving never moves the branch's `revision`.
- **Five a day.** Quartermaster counts a thread's orders since 00:00 UTC against `KS_SUPPLY_SCENARIO_THREAD_DAILY_CAP` (default 5).
  The sixth is `budget_unavailable` and writes nothing.
- **Privacy.** The card is read through `list`, so only members of the thread read it; the card has no field for where anyone is, what
  they have open or whether anyone read it. Citations are stored as claim IDs of the Scroll's provenance and never served.

## Who may reach a branch's Scroll

Only members of its thread, checked at read time: `READ_ORDER_AUDIENCE` through Content's
`CHECK_ASSET_AUDIENCE`, which Experience and Social ask wherever an ID could reach a Scroll or quote it: open,
document read, save, like and hide (`findAsset`), navigation (a `return` to it, an offer of it, activating an
offer, an exposure's context: one gate on the exact-encounter read), the saved list and the saved page, a
snippet that names it (sent or opened), and the data export. For anyone else the Scroll is as missing as an
unknown ID (a `return` to it is "exhausted"), a saved entry reads as withdrawn with no title or summary (it can
still be removed), and the export keeps no title for it ("Withdrawn"). IDs compare in lower case. A member who
leaves loses it everywhere. A removed branch's Scroll is closed to everyone, and the branch itself is a bare placeholder in the list: where it stood in the
tree and when it was made, with no title, premises, lens or starter (`cardOf`). It is nothing a member could have read from it. The
Scroll is in no discovery lane, cannot be a share-link card, has no topic attribution and adds no coverage.

Every one of these asks reads on `ReadOn`: inside a personal write it is that scope's own transaction, so
a check never takes a second connection (the pool is 10 in the API and 5 in the worker; a second one per
concurrent open would exhaust it). Only the lock-free document read, which holds no connection, asks on
the pool. The data export asks as the person it is for (`ExportPerson.reach`), on its own transaction; the
worker, which builds the export, composes `READ_ORDER_AUDIENCE` (`orderAudienceProviders`) for it.

## Tables, jobs and lock order

| Store                                     | Role                                                                                                                                                                                                | Clear            | Account deletion                                                                                                                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scenarios.nodes`                         | The shared exploration of a thread: parent, kind, title, premises, lens, `speculative`, status, revision, bound asset, and a what-if's short answer (`answer_state`, `answer`, `answer_settled_at`) | kept             | the link to the person (`started_by_account_id`) cleared. Title, premises (a premise may be the member's own typed sentence), the short answer, order and Scroll stay, with no account ID |
| `scenarios.drafts`                        | A member's private request text and the directions proposed; a ready, unexpired draft's directions are the caller's offers in `list`                                                                | deleted          | deleted                                                                                                                                                                                   |
| `supply.scenario_orders` (Supply)         | The ledger the two caps count; names no person                                                                                                                                                      | kept             | kept (no person)                                                                                                                                                                          |
| `content.made_to_order_scrolls` (Content) | The code-built order of a branch's Scroll: recipe, brief (with the premises), pages, kicker, framing                                                                                                | kept             | kept (no account ID)                                                                                                                                                                      |
| `receipts.shared_commands`                | Receipts of the thread's commands (`scenarios.draft`, `.choose`, `.remove`)                                                                                                                         | kept             | the person's own are deleted (`receiptsErasure`)                                                                                                                                          |
| `pgboss/scenarios.suggest-draft`          | Draft IDs; 4 at a time, 670 s expiry, three retries                                                                                                                                                 | payloads deleted | payloads deleted                                                                                                                                                                          |
| `pgboss/scenarios.write-answer`           | Branch IDs of short answers, with the starter's universe; 4 at a time, 670 s expiry, two retries                                                                                                    | payloads deleted | payloads deleted                                                                                                                                                                          |
| `pgboss/scenarios.resolve-branches`       | Cron, every minute: binds Scrolls, retries takes, and ends a short answer's wait after 12 minutes                                                                                                   | nothing personal | nothing personal                                                                                                                                                                          |

Lock order: personal root, the caller's own account gate (`fenceOwn`), the thread's root (`social_thread`),
the draft and node rows, and last the commissioning lock of Quartermaster. The personal harness's close of a
run takes the account gate itself, so applying a draft closes the run first and then checks standing with a
read that takes no lock, on the same transaction. No model call or network wait happens inside a transaction or on the HTTP path.

## Entry points

`apps/api/src/http/scenarios.controller.ts` serves `POST /v1/social/scenarios/{draft,draft/read,choose,list,remove}`
through the same session, `Origin` and `X-KS-Scope` pipeline as the other Social routes. The worker runs
the three consumers (`apps/worker/src/jobs.ts`). Spend is bounded by `KS_SUPPLY_SCENARIO_DAILY_CAP` and
`KS_SUPPLY_SCENARIO_THREAD_DAILY_CAP` (API only; dev values are in Ansible), and by the reasoning harness's own
budgets for the Planner and the card's writer.

## Recording generation (D-270)

The planner's `suggest` and the writer's `answer` run on the recording-aware personal harness, so a person who paused and resumed
recording gets directions and short answers. Neither a draft nor a branch records a generation (their commands name none), so the
step reads the generation recording is at in its first transaction and stamps its run with it. The claim is the draft or branch
ID. Every private read and write of the run is fenced to that generation, and Scenarios' owner check
(`application/check-recording-run.ts`, installed by `scenariosRecordingOwnerProviders`) finds the draft still `thinking`, or the
what-if branch standing with its short answer still being made.

| Capability | Where | Status |
|---|---|---|
| The run is stamped with the generation at step start, and the result is stored in the transaction that closes the run, under the fence | `application/suggest.ts`, `application/write-answer.ts` | implemented, CI-verified on real PostgreSQL with labelled fixture models |
| A reply that comes back after a pause, a resume or a Clear is dropped: the draft fails as `could_not_suggest`, the card ends with no short answer, and after a Clear nothing is written | the same | implemented, CI-verified |
| While recording is paused no run and no call is made; the draft fails and the card has no short answer, as before | the same | implemented, CI-verified |

## Failure and recovery

- A lost answer: retry with the same command ID; the receipt returns the first answer.
- The Planner fails, answers badly twice, or its budget is spent: the draft is `failed` and the member can
  write their own request. A member whose recording is paused gets no directions from the Planner (the
  personal harness refuses), and can still write their own.
- An unknown outcome of a model attempt is never resent; its run stays open for reconciliation.
- A rejected production take: the sweep sends the next, up to three, then the branch is `failed`.
- A lost hint: the cards poll every 20 seconds, every 5 while one is preparing or its short answer is being made.
- The card's writer fails, answers badly twice, or its budget is spent: the card says there is no short answer; the branch and its
  Scroll carry on.

## Verification

- Unit: `domain/*.test.ts` (exploration, premises that come down, progress, brief), `application/planner-role.test.ts`.
- Integration, real PostgreSQL: `tests/integration/modules/scenarios.test.ts`: a draft starts no production; choose
  is idempotent and commissions exactly one demand, also under concurrency; a removed or left member blocks a late
  result (and the check ran on the applying transaction); hypothetical inheritance; a perspective keeps its
  assumptions; a kept line that contradicts a premise is refused and a replaced premise holds in its new words;
  hypothetical Scrolls carry no coverage; the audience on open, document read, save, like, the saved lists,
  navigation (return, offer, activation), a snippet that names it and the data export (a member who left, a
  stranger, an upper-case ID); a pool of one still opens, acts and lists; twenty drafts a day; both
  caps; the sweep; the Planner never sees a name; speculative only for what contradicts knowledge (an unclear idea is not
  marked), an edit keeps its direction's flag and a request from scratch has none, a speculative and an ordinary twin are
  never reused for each other, a direction replaces the premise it names and one that restates a premise goes to the
  repair (and fails the draft if the repair does not fix it), a removed branch is a bare placeholder for every member and
  in a replayed answer, and the migration's backfill on rows seeded as part 1 wrote them (a branch from a confirmed
  direction, its what-if and perspective below it, an ordinary branch and an edited one left alone, a draft gone by Clear
  left unmarked, run twice, and the check that a branch is hypothetical if speculative). `account-deletion.test.ts` (erasure).
- The short answer card (D-211): `domain/answer-card.test.ts` (each rule broken once), `domain/progress.test.ts` (the wait),
  and `tests/integration/modules/scenario-answers.test.ts` against real PostgreSQL: choosing a what-if sends one job in its own
  transaction and a perspective sends none; the card the writer's checked answer makes, its citations stored as claim IDs and never
  served; the request holds the premise and the public claims and never what members said; a repaired card, a card that stays
  refused and an attempt of unknown outcome; no model call with fewer than two claims; only the starter's scope pays; members only
  (a stranger and a member who left read nothing) and no field for where anyone is; removal clears the answer and a late answer
  is dropped; the sweep ends a wait after four minutes; five a day, the sixth refused with nothing written, the next day
  counted afresh.
- All of the above use a labelled fixture model and production worker.
- Runtime, real model, the flag and the replacement (24 Oct, a local PostgreSQL, API and worker, two people): 6 requests
  (one for the root Scroll; three for the Planner, two asks and one repair after `OUTPUT_SCHEMA_MISMATCH`; two for
  writers, one published and one aborted when the worker was stopped). The Planner marked "gravity pushes Earth away from
  the Sun every summer" as `speculative` and `needsConfirmation`, and the branch carried the flag. Asked below it for a
  push half as strong, it answered with `replaces: "gravity"`, and the new branch held that one premise, not two.
- Runtime, real model, branch view and map (24 Oct, a local PostgreSQL, API and worker, two people): 21 requests (one for
  the root Scroll; 10 for the Planner, seven asks and three repairs after `OUTPUT_SCHEMA_MISMATCH`; 10 for writers, six
  branches and four retried takes). Six branches were made, one removed, one still preparing was shown, one offer was
  left unmade, and a branch under a speculative one inherited `speculative`. Screenshots are in the pull request.
- Runtime, real model, the first part: 9 requests in all (one for the root Scroll, three for the Planner, five for writers: one branch's
  first take was rejected as `OUTPUT_SCHEMA_MISMATCH` and the sweep sent take 2, which published). Screenshots and numbers
  are in the pull request for #244.
