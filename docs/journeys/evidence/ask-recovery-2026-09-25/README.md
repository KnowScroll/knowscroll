# #166 Ask progress, cancel and recovery, and the live continuation runs — 2026-09-25

API36 emulator, test app `com.knowscroll.mobile.journeytest`, disposable database
`knowscroll_test_hands_8724f01fca6e` (dropped), fixture answer transport (labelled "Fixture reply;
not a live provider result"), and the owner's preview unchanged (`preview-untouched.json`).

## By hand on the emulator

The worker process was paused (SIGSTOP) so that answers stayed queued, then resumed (SIGCONT).

1. **Ask.** On "A rhythm the ocean keeps", the question was recorded and "Get an answer" requested
   (`hands-on-01-queued.png`).
2. **Close and reopen.** Closed the sheet with "Back to reading" and reopened Ask: still "queued",
   and watched again. This is the review fix in `eb1d706`: before it, progress froze here.
3. **Kill and recover.** Force-stopped the app and relaunched it. The reader was back on the same
   Scroll, and Ask showed the same answer still queued (`hands-on-02-recovered.png`).
4. **Resume.** Resumed the worker: the answer appeared in the open sheet, with its quotes from this
   Scroll and its limits (`hands-on-03-answered.png`).
5. **Cancel.** Paused the worker again, asked on the next Scroll, requested an answer, and pressed
   Cancel: "You cancelled this question's answer." (`hands-on-04-cancelled.png`).
6. **SQL lineage.**
   - The first request: Job `completed`, answer `answered`, exactly **1** Attempt, despite the kill
     and relaunch.
   - The second: Job `cancelled`, answer `cancelled`, **0** Attempts.

## Live continuation (subscription route)

The route was MiniMax-M3, with a quota preflight before each request. Two runs of
`scripts/run-live-inquiry-experiment.ts --live --continuation --thinking adaptive`, 2 requests in all
(session ledger 70 → 72 of 190). `live-inquiry-runs.json` holds statuses, reason codes, usage and
hashes only.

| Run | Outcome |
| --- | --- |
| 1 inquiry | The first proposal was admitted by bridge-validator-v1: 1 request, no continuation needed. |
| 3 inquiries | One was refused for its reply's shape (`reply_keys`). A shape refusal never continues (ADR-0042 §1). The other two had nothing to ask. 1 request. |

**The live continuation step itself was not observed.** It needs a proposal that parses and is then
refused by the validator. The fixture run proves the step's mechanics: refused, continued with the
thinking blocks in place, admitted, 2 dispatches.

## Limits

- The pause is the worker's process being stopped, not a slow provider.
- Debug API36 emulator, not a physical device.
