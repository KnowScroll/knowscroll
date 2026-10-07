# Product: real generated Reels on stage and dev

Gate 1 — no technical language. Status: re-presented for approval on 2026-10-07. The content was
approved in substance on 2026-10-06 ("looks great"). This version moves it from a separate test
universe to the stage and dev worlds that now run on the server.

## Problem

KnowScroll promises two things to read and watch: Scrolls and Reels. A Reel is a short narrated
video made from something you can trust. Today, every Reel anyone has watched in KnowScroll is a
test clip someone supplied by hand. The video engine, Cutroom, can now make real reels with
narration and captions, but KnowScroll has never asked it for one. Even if it did, the video would
sit in storage and never reach the feed, because nothing has been allowed to say it is fit to show.

There is a second problem. Stage and dev now exist (app.stage.knowscroll.space and
app.dev.knowscroll.space), but they are nearly empty: a couple of dozen Scrolls and a map with a
few places. That doesn't feel like using KnowScroll, so trying anything there proves little.

## What you will be able to do

- **Open stage and find a full universe.** It holds about a hundred sourced Scrolls across many
  topics and a map with many planets, regions, unexplored sightings and Foundation Stars. A test
  reader formed the map by actually reading, so it grew the way yours would. Your real universe is
  never touched.
- **Scroll a feed that mixes Scrolls and Reels.** Most Reels there are simulated (plain test
  footage, always marked "Simulated media"), so the feed has plenty to swipe through.
- **Watch real Reels on stage.** Up to three were made by Cutroom from three Scrolls you chose. For
  each, you read and approved its script before any money was spent: the sentences it says and
  what each shot must and must never show.
- **See the same real Reels on dev, paid for once.** Stage and dev share one pool of Reels. A Reel
  made for stage also appears on dev without being made or paid for again. Dev never orders a paid
  Reel. It is where every change is tried first, for free, with simulated Reels, and it can be
  reset at any time.
- **See exactly what you are looking at.** Every real Reel says it is generated and that the video
  engine checked it. "Why this Reel appeared" explains how it was checked, including that the check
  was done by the engine that made it, not by an independent reviewer.

## What it is not

- Not your real universe yet. The live world (app.knowscroll.space) is a later step, with its own
  Cutroom and its own spending.
- Not an independent visual check. The label says the engine checked its own work. An independent
  check can replace it later without remaking any Reel.
- Not "ask for a Reel" from inside the app. These Reels come from scripts we approve, not from
  your questions.
- No black holes, solar systems, galaxies or nebulae on the map. Those need their own meaning first
  and are a later feature.
- No changes to Cutroom itself.

## How success is measured

| Measure | Target |
|---|---|
| Real Reels that play in the stage feed, on the web and on a stage Android build (made on your Mac when you ask) | 3 (at least 1, or the feature is not done) |
| The same real Reels playing on dev | all of them, at no extra cost |
| Total real money spent, including any automatic re-tries | **≤ $2.00** |
| Money spent that KnowScroll's own spending record doesn't know about | **0¢** |
| Paid Reels ordered from dev | **none** |
| Changes to your real universe | **none** |
| Sourced Scrolls on stage and dev | about 100+ (from 23 today) |
| Map on stage | at least 12 planets across at least 6 topics, with regions, sightings and at least 2 Foundation Stars (these figures are targets and may move once the reading run shows what is realistic) |
| Simulated Reels in the feed | about 15–20, every one marked |

**Order is part of the promise.** The whole journey runs end to end on dev with simulated Reels
first, for free. Then the same version moves to stage. Only then is money spent, one real Reel at a
time, each waiting for your go-ahead.

## Announcement — the blog post before the feature

> **KnowScroll makes its own Reels now.**
> Pick a Scroll and KnowScroll writes a short script from it: a few sentences, each tied to the
> Scroll's sources, and what every shot must and must never show. You approve the script. The video
> engine makes the Reel, narrates it, captions it and checks every shot. Then KnowScroll checks it
> again before it can reach your feed. Every Reel tells you what it is. It's generated, it was
> checked by the engine that made it, and here is why it appeared. It runs on our stage world
> today: a hundred Scrolls and a sky full of places to explore. Your own universe is next.

## Screens

- [`mockups/01-reel-engine-checked.html`](mockups/01-reel-engine-checked.html): a real Reel in the
  existing Reel player with the new "Engine-checked" tag, and "Why this Reel appeared" open,
  showing "How it was checked". It is shown next to a simulated Reel for contrast. This is the only
  new screen in the feature.
- The map, feed and Scroll screens are unchanged. They only have far more in them. The STAGE and
  DEV ribbons that already sit on those worlds stay as they are.

## Questions for you at this gate

1. **Label wording.** The mockup uses "Engine-checked" on the Reel and spells it out in the sheet.
   Alternatives: "Checked by Cutroom", or "Self-checked by the video engine". Which do you want?
2. **Finding the real Reels.** With about 15–20 simulated Reels around them, should the three real
   ones come first in the stage feed, or sit mixed in like any other Reel?
3. **Choosing the three Scrolls.** I propose a shortlist after the library grows (more choice), or
   you pick now from the existing 23. Which?
4. **Dev's map.** Stage gets the full reading run that grows the map. Should dev get the same run,
   so the two look alike, or keep a smaller map, because dev can be reset at any time and the run
   would have to be repeated after each reset?
