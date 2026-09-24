# #163 Idea Rooms v1 — emulator evidence, 2026-09-25

ADR-0045. Session setup:

- Stack: `scripts/android-hands-on.py up --seed scripts/rooms/seed-day-old-ask.ts`, with the correction
  catch-up every 3 s.
- Database: `knowscroll_test_hands_0d3842fa92f3`, dropped afterwards.
- App: the test app `com.knowscroll.mobile.journeytest` on the API36 emulator. The owner's preview
  was unchanged (`preview-untouched.json`).
- No model call anywhere in this slice.

The seed supplies labelled journey knowledge: one claim about Gravity that a single journey source
both supports and qualifies, so a doubter has something to hold. It also supplies a day-old keep of
"One force, many jobs" and an Ask about it, made through the real API and backdated one day.

## By hand

1. **The room opens.**
   - Day two on the device: kept "A rhythm the ocean keeps" and "The pull you can't see" (Gravity
     anchors), then asked "Why does gravity weaken with distance?" on the Gravity Scroll.
   - A room opened on Gravity in state `arguing`. Seated: the reader of record (4 claims) and the
     doubter (1 claim).
   - Deltas: `room_opened` (`personal_exploration`) and two `inhabitant_seated`
     (`substrate_neighbourhood`).
2. **The Atlas.**
   - The place sheet lists "Idea rooms" with the question and "Two readings disagree"
     (`hands-on-02-place-rooms.png`).
   - The room sheet shows the question, the state, each seat with the sentences it holds, and the
     chronicle, whose lines open their evidence (`hands-on-03-room.png`). No source anywhere.
3. **A correction while away.**
   - Pressed Home and withdrew the doubter's source. The worker's catch-up recorded
     `inhabitant_unseated` (`source_correction`) with no reader event, and the room moved to `opened`.
   - On return, "While you were away" said "The doubter left: what its claims were based on changed."
     (`hands-on-05-atlas-away.png`). The reopened room reads "One reading so far"
     (`hands-on-06-room-after.png`).
4. **An open sheet re-reads on return** (coordinator fix in this PR).
   - A room sheet left open across the return had shown its old contents.
   - It now re-reads when the Atlas refreshes. After a second correction while away (`nasa.gravity`),
     the sheet updated in place: "The reader of record changed position…" (`hands-on-07-room-reread.png`).
5. **Pause.** With recording paused, the sheet says "Recording is paused, so this room can't be set
   aside until you resume." (`hands-on-08-paused.png`).
6. **Set aside.** After resuming: confirmed; the room left the place sheet (`hands-on-09-set-aside.png`),
   recorded as `room_set_aside` (`reader_correction`).
7. **Clear.** Clear Scroll history leaves 0 rooms, inhabitants and deltas.

## Limits

- Inhabitants are seats of evidence access that hold substrate claims; no resident speaks model text
  in v1 (ADR-0045 "Not in this version").
- The doubter's claim is labelled journey knowledge: the editorial substrate has almost no
  qualifying support to seat one.
- "Away" is the app in the background for seconds. Debug API36 emulator, not a physical device.
