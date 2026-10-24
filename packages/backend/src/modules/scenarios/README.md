# Scenarios: What if, Another perspective and the shared Scenario Planner

In a content thread a member can ask "What if…" (change a premise of the explanation) or for "Another
perspective" (the same facts through another lens), from the whole thread, a message or a shared snippet.
A Planner proposes a few directions. The member chooses one, or writes a complete request of their own.
Only that choice makes a branch: Quartermaster commissions one Scroll for it, the thread shows the branch
as a card that turns from preparing to ready, and every member opens it at their own pace.
Blueprint §14, §16 and §17; decisions D-006, D-037, D-046 and **D-049**. Nothing here is consumption
evidence: asking, choosing, being shown a card and opening a branch's Scroll are not a Keep, a position or
real-world coverage for anyone.

Status marks: **implemented** means merged with tests against real PostgreSQL. **Runtime-verified** means
used on a running system. This module is **implemented**. It is not yet runtime-verified and is not running on dev.

## What a member can do

| Action | Use case (`SCENARIO_USE_CASES`) | What it does | Status |
| --- | --- | --- | --- |
| Ask for directions | `draft` | Stores a private draft, sends one job. Starts no production. At most 20 a day. | Implemented |
| See the directions | `readDraft` | `thinking`, `ready` (one clear idea, or two to three options), `failed` or `chosen`. Private to the asker. | Implemented |
| Choose | `choose` | Picks an option, or sends the member's own complete request. The only command that commissions. Idempotent. | Implemented |
| See the thread's branches | `list` | Cards, oldest first, removed ones as notes. Polled and hinted, never a position of anyone. | Implemented |
| Remove a branch they started | `remove` | The card becomes a note; its Scroll closes. | Implemented |

Not built: Reel branches, a retry command for a failed branch (remove it and ask again), the sequence view
and history map (X03, X04), idea rooms (#245).

## The model: a tree of branches

`scenarios.nodes` holds the branches of one thread; each has one parent (the thread's root revision, or
another node at a revision). The rules are pure, in `domain/`:

- **What if**: one or two explicit changes and up to three things that stay the same. The premises that
  hold are the parent's plus these, at most four; a change to a subject the parent already assumes replaces
  it. Hypothetical status is inherited by every descendant.
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
2. The worker runs the Planner (`scenarios.planner`, `planner.1`, policy `scenario-planner.v1`) on the
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

## Who may open a branch's Scroll

Only members of its thread, checked at read time (`READ_ORDER_AUDIENCE` through Content's
`CHECK_ASSET_AUDIENCE`, used by open and document reads). A member who leaves loses the Scroll. A removed
branch's Scroll is closed to everyone. The Scroll is in no discovery lane, cannot be a share-link card, has
no topic attribution and adds no coverage.

## Tables, jobs and lock order

| Store | Role | Clear | Account deletion |
| --- | --- | --- | --- |
| `scenarios.nodes` | The shared exploration of a thread: parent, kind, premises, lens, status, revision, bound asset | kept (a contribution, like a message) | author link and the member's words cleared; branch, premises and Scroll stay |
| `scenarios.drafts` | A member's private request and the directions proposed | deleted | deleted |
| `supply.scenario_orders` (Supply) | The ledger the two caps count; names no person | kept | kept (no person) |
| `content.made_to_order_scrolls` (Content) | The code-built order of a branch's Scroll: recipe, brief, pages, kicker, framing | kept | kept (no person) |
| `receipts.shared_commands` | Receipts of the thread's commands (`scenarios.draft`, `.choose`, `.remove`) | kept | kept |
| `pgboss/scenarios.suggest-draft` | Draft IDs; 4 at a time, 670 s expiry, three retries | payloads deleted | payloads deleted |
| `pgboss/scenarios.resolve-branches` | Cron, every minute | nothing personal | nothing personal |

Lock order: personal root, the caller's own account gate (`fenceOwn`), the thread's root (`social_thread`),
the draft and node rows, and last the commissioning lock of Quartermaster. The personal harness's close of a
run takes the account gate itself, so applying a draft closes the run first and then checks standing with a
read that takes no lock. No model call or network wait happens inside a transaction or on the HTTP path.

## Entry points

`apps/api/src/http/scenarios.controller.ts` serves `POST /v1/social/scenarios/{draft,draft/read,choose,list,remove}`
through the same session, `Origin` and `X-KS-Scope` pipeline as the other Social routes. The worker runs
the two consumers (`apps/worker/src/jobs.ts`). Spend is bounded by `KS_SUPPLY_SCENARIO_DAILY_CAP` and
`KS_SUPPLY_SCENARIO_THREAD_CAP` (API only; dev values are in Ansible), and by the reasoning harness's own
budgets for the Planner.

## Failure and recovery

- A lost answer: retry with the same command ID; the receipt returns the first answer.
- The Planner fails, answers badly twice, or its budget is spent: the draft is `failed` and the member can
  write their own request. A member whose recording is paused gets no directions from the Planner (the
  personal harness refuses), and can still write their own.
- An unknown outcome of a model attempt is never resent; its run stays open for reconciliation.
- A rejected production take: the sweep sends the next, up to three, then the branch is `failed`.
- A lost hint: the cards poll every 20 seconds, every 5 while one is preparing.

## Verification

- Unit: `domain/*.test.ts` (exploration, progress, brief), `application/planner-role.test.ts`.
- Integration, real PostgreSQL: `tests/integration/modules/scenarios.test.ts` (26 tests: a draft starts no
  production; choose is idempotent and commissions exactly one demand, also under concurrency; a removed
  or left member blocks a late result; hypothetical inheritance; a perspective keeps its assumptions;
  hypothetical Scrolls carry no coverage; audience; caps; the sweep; the Planner never sees a name),
  `account-deletion.test.ts` (erasure).
- All of the above use a labelled fixture model and production worker. Runtime evidence with the real model
  is in the pull request for #244, not here.
