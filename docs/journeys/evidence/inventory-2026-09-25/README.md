# #164 inventory v1 — emulator evidence, 2026-09-25

ADR-0046. Setup:

- Stack: `scripts/android-hands-on.py up --seed scripts/atlas/seed-day-old-history.ts`, with the worker
  started with `KS_SCROLL_TRANSPORT=fixture` and the correction catch-up every 3 s.
- Database: `knowscroll_test_hands_ec6e0584b114`, dropped afterwards.
- Writing route: `scripts/scrolls/install-supply.ts --transport fixture --request-cap 3`, with one
  allowlisted material candidate for Gravity (NASA's "What Is Gravity?" page).
- App: the test app `com.knowscroll.mobile.journeytest` on the API36 emulator. The owner's preview
  was unchanged (`preview-untouched.json`).

## By hand

1. **Demand from real reading.** Read in the Cable and kept "A rhythm the ocean keeps" and "The pull
   you can't see", after the seeded day-old keep. Gravity formed with all three of its Scrolls read.
   The next Cable step recorded the need: `content_demand` for `physics.gravity`, decision `fund`,
   status `waiting`, and one shared `supply_request` opened.
2. **Shared supply, private binding.**
   - The worker's writing loop fetched the page and wrote with the labelled fixture transport.
   - ADR-0041's checks admitted the Scroll; the supply request moved to `fulfilled`.
   - The Quartermaster decided `reuse`, and the demand became `bound`.
   - The place sheet showed "New for you: Fixture: Gravity" and "3 of 4 Scrolls read"
     (`hands-on-01-place-need.png`).
3. **Opening it.** "New for you" opened the bound Scroll in the reader, headed "More about Gravity: you
   had already seen everything here." (`hands-on-02-bound-scroll.png`). Why it appeared: "You had
   already seen everything here" (`hands-on-03-bound-why.png`). No source anywhere.
4. **A correction withdraws it.**
   - Pressed Home and withdrew the page's source (`correct-source.ts --action revoked`). The binding
     became `withdrawn` and the demand reopened.
   - The Quartermaster decided `cannot_meet` (`no_material`): the one candidate was already used.
   - On return:
     - the place sheet reads "Nothing more about Gravity for now" and "Withdrawn: what it was based
       on changed" (`hands-on-04-away-withdrawn.png`);
     - "While you were away" says "A Scroll about Gravity you were waiting for was withdrawn: what it
       was based on changed." (`hands-on-05-atlas-away.png`).

## One bounded live request (coordinator, after the review and the rebase onto #165)

Stack `knowscroll_test_hands_f8725d38aea1`, dropped afterwards. The route was `minimax`, with a request cap of 1, installed by `install-supply.ts`. The only material was NASA's "What Is Gravity?" page, for `physics.gravity`.

1. **Reading.** Read and kept "A rhythm the ocean keeps" and "The pull you can't see", and Gravity formed as a planet.
2. **The need is funded.** The next Cable step recorded the need: `waiting`, `fund`, one `open` request.
   - The place sheet read "Being written: more about Gravity", with "Keep" on the same sheet.
3. **One pass of the worker's writing loop** (`runSupplyPass`) ran with the MiniMax transport.
   - The quota preflight passed (at least 25%). The session ledger counted the request before anything was sent (72 → 73 of 190).
   - The request was admitted as `sending` and sent once.
   - The written Scroll was refused by `scroll-checks-v2`, with `quote_not_in_material` and `copied_passage`: the same refusals as #162's batch (#181).
   - Nothing was retried. The demand became `cannot_meet` (`no_budget`: the route's one request was spent).
4. **What the reader sees.** On re-entering the system view, the place sheet read "Nothing more about Gravity for now" and "Writing more has reached its limit for now."
   - An Atlas already open keeps the earlier line until it is read again.

The pass ran from a coordinator script outside Git. It read the key from `.env` without printing it, and printed only statuses and reason codes. No model text is in this directory.

## Limits

- **The earlier walk-through used the fixture writer.** The live request above was refused, so no Scroll written by MiniMax was bound and served in this slice. The fixture run shows the bound path.
- **"Being written…"** was too quick to screenshot with the fixture writer. It was seen in the live run above. The state progression (`fund` → `waiting` → `bound` → `withdrawn` → `cannot_meet`) is in the database.
- **Place count.** After the withdrawal the place still counts the withdrawn Scroll ("4 of 4").
- Debug API36 emulator, not a physical device.
