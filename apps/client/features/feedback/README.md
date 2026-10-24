# Feedback and report (P03; #250, D-055)

The P03 sheet: "Not interested", "Report a content error" and "Report abuse", with an acknowledgement and a timed
Undo for the first and a receipt for the others. Status marks: implemented with component tests over labelled
fixtures, and screenshots at 390 and 1440 px; not run on dev.

| File | What it does |
| --- | --- |
| `feedback-content.tsx` | The sheet's content for a target: the menu (a Reel or Scroll), the content error form, the abuse form, sending, the receipt with "Also block", "Will send when online" and a failure with Retry. Its state is client-core's `createReportFlow` |
| `feedback-sheet.tsx` | `FeedbackSheetBody` (sits inside a container's sheet; signed-out people are asked to sign in) and `FeedbackSheet`, a bottom sheet for the screens that report a message or a person |
| `not-interested-notice.tsx` | The dark acknowledgement "Got it — we won’t show this for a while." with Undo for 8 s, and the saving, undoing and failed states. It sits among the encounter's notices, so it survives the move to the next subject |
| `feedback-parts.tsx` | A menu row, the "Not interested" row and its failure, the reason chips (radios) and the note field |
| `feedback-copy.ts` | The labels of the reasons and the words of the receipt. A receipt names the reason, what it is about and when; it never names a person |
| `use-feedback.ts` | The scope's feedback store (waking it sends reports kept from an earlier run), its state, and the busy/failed state of the "Not interested" row |

Entries: the encounter's ⋯ (More) has "Not interested", "Report a content error" and "Report abuse"; a long-press on a Reel, a
right-click, Shift+F10 or the menu key opens the P03 menu (`session.openFeedback`); the conversation's ⋯ has "Report {name}",
and a long-press or screen-reader action on another person's message reports it (the browser's right-click stays the browser's, so the text can be copied); a room's message options have
"Report this message"; the friend visit bar has "Report". A Scroll's reading surface keeps text selection and the browser's
menu, so its only entry is ⋯. Moderators of a room see the reported messages under Moderator tools
(`features/rooms/reported-messages.tsx`).

How it takes part in the journey: "Not interested" saves, then moves to the next subject (`session.notInterested`); Undo removes
the constraint and returns to the Reel left behind (`session.undoNotInterested`). A report is saved on the device, sent with
one command ID, and kept for a connection if there was no answer. Nothing here is consumption: opening the sheet, choosing
and sending create no exposure, observation or Keep, and a report is never shown back to anyone.

Tests: component tests beside each file, the encounter session's Not interested flow (`encounter/encounter-session.test.ts`), and the web
smoke `apps/client/e2e/feedback-smoke.spec.ts` over the production export (Not interested and Undo, a content error with its receipt, an
abuse report kept offline and sent again with the same command ID, and the Reel's right-click and Shift+F10 menu).

