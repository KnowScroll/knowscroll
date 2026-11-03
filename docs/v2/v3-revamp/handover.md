# Handover: the v3 revamp on dev (3 Nov 2026)

This run built the v3 revamp through **dev**: the new Universe, V3 Scrolls, R3 rooms and T3 Talk, with the backend and algorithm change behind each screen. Stage, live and the `main` PR are out of scope for this run.
Tracker: [#462](https://github.com/KnowScroll/knowscroll/issues/462). Current state: [`docs/STATUS.md`](../../STATUS.md). The v2 handover stays in [`docs/v2/handover.md`](../handover.md).

## Try it

Open **https://app.dev.knowscroll.space** and sign in with the link in the mail. A new account starts empty; read or watch a few things in Explore and your universe grows from what you actually read.

1. **Scrolls.** Open the Seasons series in Explore ("Why Summer Can Happen Farther From the Sun"). Each stop has a picture that changes as you read. Make a call, and pick wrong once: the picture turns to the January orbit with the real distances (91.4 and 94.5 million miles, from NASA). Swipe left for Part 2: it follows your finger, and a "← Part 1" tab takes you back to the same stop. At the end the picture becomes the one you built, an Earth at each month you met. The ••• sheet holds Save, Share a moment, Challenge a friend, Text version, Simpler, Small print and Report.
2. **Ask.** On a Scroll, press **Ask about this** and pick or type a question. A Scroll is written for you alone in two to five minutes, checked sentence by sentence against the library's sources. If the library does not cover your point, the answer says so. Select a few words in a stop and press **Ask** for a Quick answer (seconds, labelled "not a checked Scroll").
3. **Universe.** After a few related Scrolls a system, star and planet form. Fly in and out; open a planet and land; search; spin the orbit dial; try Simple view. Visit a friend's universe from Friends: their private parts stay private.
4. **Talk, with a friend.** Start a thread from a series. Each of you sees the other's Part ("on Part 2"), can hide it, and can make a call before reading. When both finish, the call is revealed together. Ask **What if…** for a branch with its own map.
5. **Rooms.** Join the Earth room. Nova and Halley are AI residents, always labelled. They answer when asked by name, speak up within caps, and say plainly when the library does not cover something. Play the daily Spot the flaw and a live Launch (two people with the room open; five questions; a podium for that night only). Stars light the room's sky, and the sky lists how each star was earned. Your own flair (First answer, Good question, Flaw finder, Launch regular) comes from your own acts; you can choose or hide it.
6. **Privacy.** Pause recording in Account: nothing you open while paused is recorded, and What-if asks you to resume. Clear removes your history, play and places; account deletion removes everything.

## What changed, in one paragraph per area

- **Universe:** a three.js map with planet looks, the globe and landed map, region cards, search, the orbit dial, Simple views, friend visits, first-open and fly-in animations, and landmarks as one card that folds on a planet. Browsing it writes no evidence (journey (a)).
- **Scrolls and the algorithm:** v2 Scrolls with the stage reader and its drawing kits; calls with sparks and a Final call; moving between Parts; the recap; Composer policy v1 (a pull-up leaves the topic more often), format learned per topic, `jev.2`. Play results never feed ranking, planning, evidence or formation (D-063).
- **Content:** 52 v2 library Scrolls released, 21 of them with a stage, all read before release; Seasons Part 1 regenerated with the recap, the plot twist and cited figures (revision 4). Ask orders and Quick answers.
- **Talk:** the T3 thread on phone and desktop, places, Call it together, What-if cards and branches, the new-since line, "In this chat" on desktop.
- **Rooms:** Campfire, residents with a feed and caps, Today, Spot the flaw, debates, the Launch and its replay, the sky and flair, Watch together, moderation and reports.

## Evidence

The final journey run (2 Nov, dev `09adb590`): Launch, the Call it together reveal, J1, J2, J5 and P03 pass; J4's two failures were the right behaviour with unclear words, fixed in #654. Journeys (a) to (e) passed earlier. Asks: 5 of 5 Ready (`09adb590`). The final check on `c34737e3` (3 Nov): the cap words, a paused What-if with Resume, the orbit layout at 320, 390 and 1440, the 320 landmark line and the note after an article pass; the reveal opened by itself for the second finisher only (#659). The final check on `c34737e3` (3 Nov): the cap words, a paused What-if with Resume, the orbit layout at 320, 390 and 1440, the 320 landmark line and the note after an article pass; the reveal opened by itself for the second finisher only (#659). The fidelity table: [`docs/v2/design/fidelity-v3.md`](../design/fidelity-v3.md). Screenshots and run notes are on the session runner's machine (`C:/Users/XZNON/knowscroll-dev/tmp/`), not in the repository.

## Known gaps

- **Asks are honest but not always useful.** When the library does not cover a question, the answer says so and gives nearby facts. Three of five test answers opened with "The pages do not explain…"; the words should say "the library". Four of five titles were the code-made "Your question about <Scroll>". The closing line is the same on every answer.
- **Seasons figures** come only from what a cited page states. NASA states the distances in miles and no daylight hours, so the design's kilometres and day-length bands do not show yet.
- **A native build older than #651** reads the new Seasons Part 1 as invalid (no capability gate; D-384). The web reader is current. Release native builds before anyone uses an old one.
- **Tides** (the first Tides Scroll) is held after two rejected takes; one take is left.
- **Explore's Reel request sheet** always ends "can't be made" while Reel supply is closed (no new Cutroom spend in this run).
- **Not seen on dev:** "while you were away" (needs 12 hours away and 15 messages), scouts (off; see below), the 1440 live Launch, and drawing kits other than Earth & sky.
- **The reveal for the first finisher** does not open by itself when they come back to the thread later; Series shows it as revealed (#659).
- **Fidelity:** 17 owner calls and a set of accepted differences, each with its decision, in the fidelity table.

## Recovery and rollback

- **Roll dev back:** revert the promotion commit on `dev` by PR (the push deploys). Migrations only add; a rollback leaves the new tables unused. The dev database may be dumped and recreated (D-030, `docs/v2/operations/backups.md`).
- **Turn a feature off on dev** in `/etc/knowscroll/dev.v2.env` (back it up first: `cp -p` to `/root/dev.v2.env.bak-<UTC time>`), then restart `ks2-api@dev` and `ks2-worker@dev`:
  - ask orders: `KS_SUPPLY_ASK_DAILY_CAP=0`; Quick answers: `KS_SUPPLY_QUICK_ANSWER_DAILY_CAP=0`;
  - room AI: `KS_REASONING_ROOM_ENABLED=0`; the residents' feed: `KS_ROOMS_FEED_ENABLED=0`;
  - the Composer: `KS_COMPOSER_POLICY` back to its default.
- **A bad library Scroll:** `content reject` (or release the previous revision) and `content admit-continuity`; see `docs/v2/operations/scroll-production.md`.
- **A bad room ritual:** `rooms ritual-review --reject`. A bad backdrop: `rooms backdrop-review --reject`.
- Env backups made in this run: `/root/dev.v2.env.bak-20261030T115551Z` … `-20261102T122934Z` (eight files).

## Waiting for owner

The decisions the session took for you are listed on [#462](https://github.com/KnowScroll/knowscroll/issues/462) under "Waiting for owner"; each stands until you overrule it there. New since that list was written:

1. **Fidelity owner calls (17):** in [`fidelity-v3.md`](../design/fidelity-v3.md) "Owner calls", each with the decision it touches (for example the landmark on the planet map, a mouse drag between Parts, AI faces in the room's live band, the chat beside the live Launch question on a phone).
2. **Scouts:** built and off on dev. Turn them on after 8 Nov if you want them seen (`rooms scout`).
3. **Reel supply:** open it (new Cutroom spend needs your approval on the tracker) or hide the Reel request sheet.
4. **Ask words:** say "the library" instead of "the pages", and whether code-made titles are acceptable or the writer should be asked again for a title.
5. **Native release:** ship a native build with the #651 reader before Seasons Part 1 reaches any phone.
6. **Flair:** blocks hide flair one way (D-345, as D-051); an author learns their answer earned a star but never who marked it (D-341, D-346, amending D-168).
