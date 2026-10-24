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
| `reportContentError(authority, {commandId, target, category, anchor?, note?})` | `POST /v1/feedback/content-errors` | Personal root, then the caller's own account. The asset must be admitted, reachable by the caller (audience gate) and have the named revision. |
| `reportAbuse(authority, {commandId, target, category, note?})` | `POST /v1/feedback/abuse-reports` | Same locks. A message must be one the caller can see as a current member (Social's `READ_REPORTABLE_MESSAGE`, Rooms' `READ_REPORTABLE_ROOM_MESSAGE`); a person must have a claimed profile (`READ_PUBLIC_PEOPLE`). Not the caller's own message or profile. |
| `READ_ROOM_REPORTS` | Rooms' `reports` use case | One row per reported message of one room: reasons, count, last time. Leaves out reports on the asking moderator's own words; never the sender, the note or the author. |

Both commands share one skeleton: gate, receipt lookup (identical retry answers the first receipt; another body under
the key is `COMMAND_KEY_REUSED`), target access, the bound (25 per account per 24 hours, `TOO_MANY_REQUESTS`), then the
receipt, the row and the stored outcome in one transaction. A missing, hidden, forbidden or own target is one `NOT_FOUND`.
A refusal writes nothing. No job, no notice, no evidence.

## Tables, jobs, lock order, erasure

| Item | Detail |
|---|---|
| Table | `feedback.reports` (0065): account-keyed; reporter, kind, reason, target (asset and revision, message ID, room ID, reported account), anchor, note, time. Message IDs are soft references. |
| View | `ops.feedback_reports` (operator): ids, kind, reason, target kind, whether a note exists, time. No note, no accounts. |
| Jobs, notices | none |
| Lock order | personal root, then the caller's own account; no other root |
| Clear | kept: a report is a message to us, not exploration evidence (D-042) |
| Account deletion | deletes every report the account sent and every report about it |
| Export | the person's own reports in words: kind, reason, what it was about (a Reel or Scroll with its title if still reachable, "a message", "a person"), their note, the time. No identifier and nobody named. |

A report is kept until the sender's or the reported person's account is deleted. There is no automatic expiry, and
no operator action on a report is built.

## Failure and recovery

- A lost response: retry with the same command ID; the receipt replays it. The client queues a report that got no answer.
- A target deleted between the report and the check: the same `NOT_FOUND`.
- A reported account deleted while a report is being written: the foreign key stops the account's final delete, the
  deletion job retries and removes the new row (the same pattern as messages in rooms).

## Related

Decision D-055. Contracts: `packages/contracts/src/feedback.ts`, `rooms.ts` (`reports`), `operator.ts`. Client:
`apps/client/features/feedback/`, `packages/client-core/src/feedback-store.ts`, `feedback-flow.ts`.
