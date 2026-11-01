# modules/feedback

Reports to the safety team about a Reel or Scroll, a message or a person (P03, D-055). "Not interested" is
not here: it shapes what Experience offers, so Experience owns it (see its README).

Status: **implemented** and CI-verified against real PostgreSQL. Not yet run on dev.

## What a person can do

- Report a **content error** on the Reel or Scroll in front of them: the exact revision, a reason (Something's
  wrong, Out of date, Misleading, Other), where in it (a moment of a Reel, a block of a Scroll) and an optional note.
- Report **abuse** about a Reel or Scroll, a message in a conversation or thread, a message in an idea room or a
  person, with a reason they must pick and an optional note.
- Get a receipt (an ID and a time). Nothing else comes back, ever.

Nobody a report concerns is told, and no route returns a report. Operators read the newest reports on the Operator
screen; a room's moderators read the reports on their room's messages (`POST /v1/rooms/reports`, Rooms).

## Entry points

| Operation | Route | Authority, effects, failure |
|---|---|---|
| `reportContentError(authority, {commandId, target, category, anchor?, note?, quickAnswerId?})` | `POST /v1/feedback/content-errors` | Personal root, then the caller's own account. The asset must be admitted, reachable by the caller (audience gate) and have the named revision, one the review gate did not hold or reject (D-138). |
| `reportAbuse(authority, {commandId, target, category, note?})` | `POST /v1/feedback/abuse-reports` | Same locks. A message must be one the caller can see as a current member (Social's `READ_REPORTABLE_MESSAGE`, Rooms' `READ_REPORTABLE_ROOM_MESSAGE`); a person must have a claimed profile (`READ_PUBLIC_PEOPLE`). Not the caller's own message or profile. |
| `READ_ROOM_REPORTS` | Rooms' `reports` use case | One row per reported message of one room: reasons, how many different people reported it, the newest time (Rooms shows only its day). Leaves out reports on the asking moderator's own words; never the sender, the note or the author. |

A content error may be about a Quick answer (D-255): `quickAnswerId` names the person's own answered, still-kept answer about that Scroll revision (Supply's `READ_QUICK_ANSWER_FOR_REPORT`), and its question and answer are copied into `feedback.reports.quick_answer` when the report is sent, because the answer is erased a day later. Anything else (another person's answer, a dismissed or expired one, another revision) is `NOT_FOUND`, like a missing target. A report keeps the question and answer until the reporter's account is deleted, and Clear keeps it; the form says so before it is sent. The reporter's export lists the words with their report. *Implemented.*

Both commands share one skeleton: gate, receipt lookup (identical retry answers the first receipt; another body under
the key is `COMMAND_KEY_REUSED`), target access, the bound (25 per account per 24 hours,
`TOO_MANY_REQUESTS`), then the receipt, the row and the stored outcome in one transaction. A missing, hidden, forbidden or
own target is one `NOT_FOUND`. A refusal writes nothing. No job, no notice, no evidence.

Every command ID is its own report, also about a target the account reported before: a second report may carry
another reason, a note, or something that happened later, and the safety team must get it. Only the same command ID
replays (its first receipt). How many people reported a room message is counted in distinct reporters (`READ_ROOM_REPORTS`),
so one person reporting twice does not raise what moderators see.

## Tables, jobs, lock order, erasure

| Item | Detail |
|---|---|
| Table | `feedback.reports` (0068, 0094): account-keyed; reporter, kind, reason, target (asset and revision, message ID, room ID, reported account), anchor, note, the Quick answer's words (a content error about one), time, `retain_until`. Message IDs are soft references. |
| View | `ops.feedback_reports` (operator): ids, kind, reason, target kind, whether a note exists, time. No note, no accounts. |
| Jobs | `feedback.purge-reports` (`events.ts`, scheduled daily at 03:17 UTC, worker): deletes reports whose `retain_until` has passed, 500 per transaction, at most 20 batches a run, skipping rows another transaction holds. Logs `feedback.reports_purged` with a count. Listed under the Operator's retention jobs. |
| Notices | none |
| Lock order | personal root, then the caller's own account; no other root |
| Clear | kept: a report is a message to us, not exploration evidence (D-042) |
| Account deletion, the reporter | deletes every report the account sent |
| Account deletion, the reported person | keeps the reports about the account for 90 days from the deletion, without the person: `reported_account_id` is cleared, a person target becomes `deleted_account`, `retain_until` is set. A message ID stays: Social and Rooms tombstone the message in the same deletion. The purge job then deletes them. |
| Export | the person's own reports in words: kind, reason, what it was about (a Reel or Scroll with its title if still reachable, "a message", "a person", "a person who has since deleted their account"), their note, the time, and until when a report about a deleted person is kept. No identifier and nobody named. |

Deleting an account must not erase what other people told the safety team about it, and a report must not outlive the
need: so a report lives while its reporter's account exists, and a report about a deleted account lives 90 days more.
A content error names an asset and never an account, so the reported side of a deletion never touches it. No operator
action on a report is built.

## Failure and recovery

- A lost response: retry with the same command ID; the receipt replays it. The client queues a report that got no answer.
- A target deleted between the report and the check: the same `NOT_FOUND`.
- A reported account deleted while a report is being written: the foreign key stops the account's final delete, the
  deletion job retries and de-identifies the new row (the same pattern as messages in rooms).
- A purge that runs late or twice is harmless: it deletes only rows already past `retain_until`.

## Related

Decision D-055. Contracts: `packages/contracts/src/feedback.ts`, `rooms.ts` (`reports`), `operator.ts`. Client:
`apps/client/features/feedback/`, `packages/client-core/src/feedback-store.ts`, `feedback-flow.ts`.
