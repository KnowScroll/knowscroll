# Product: three places KnowScroll runs — dev, stage and live

Gate 1 — no technical language. Status: **APPROVED 2026-10-06**. The owner answered all four questions
and asked to proceed with this feature first.

## Problem

KnowScroll runs on one Mac, from an external drive, started by hand. Your phone reaches it only
through a test setup. Every experiment risks your real universe, because there is nowhere else
realistic to try things. The AI works on the same machine and the same data you do. There is no
clear line between "being built", "ready to try" and "live", so there is also no safe way to say
"this works, now ship it".

## What you will be able to do

- **Open KnowScroll from anywhere**, at three web addresses:
  - **Live** holds your universe.
  - **Stage** is a full, rich test universe where you try what is coming next.
  - **Dev** is where the AI builds and tests. It can be wiped and refilled at any time.
- **Install three apps side by side on your phone:** KnowScroll, KnowScroll Stage and KnowScroll
  Dev. Each one talks only to its own world, so a test can never reach your real universe. The
  live app comes from Google Play.
- **Keep your universe.** It moves from the Mac to live once, intact: your reading, keeps, places
  and history.
- **Changes only move one way: dev → stage → live.** The AI moves a change from dev to stage once
  it works there. **Only you move anything to live.**
- **Get your universe back if a release goes wrong.** Every change to live is preceded by a
  checked backup, and a bad release is rolled back to it.
- **Always know which world you are in and what it runs.** Stage and Dev carry a clear label on
  every screen. Each place can tell you which version it is running.
- **Let the AI keep watch.** It can watch dev and stage run at any time (what they are doing,
  errors, health) and fix them. It can see whether live is healthy, but not read your private data.
- **Keep the worlds separate.** Each world has its own settings, keys, spending limits and video
  engine:
  - Dev makes only free simulated videos.
  - Stage can make real ones within a limit.
  - Live makes real ones.

## What it is not

- Not an iPhone app. On an iPhone you use the web app.
- Not open sign-ups. It stays a personal universe with one owner, as today.
- Not a fleet of servers. It is one rented server, sized for a personal product.
- Not private on GitHub yet. The code stays public for now; going private later is a planned step
  with a monthly cost, not a surprise.

## How success is measured

| Measure | Target |
|---|---|
| Worlds reachable at their own secure addresses, each with its own data | 3 (or 2, if the server proves too small for three, and you decide) |
| Your universe after the move to live | every count matches the Mac's; **nothing lost** |
| Time from a change landing in dev to running in dev, with no hand steps | **≤ 10 minutes** |
| Changes moved to live by anyone but you | **0**. This rests on the AI's rules, a guard in its tools and a GitHub rule, because it uses your account. |
| Releases to live that had a checked backup first | **100%** |
| Ways into the server without a key | **0** (password and root login switched off) |
| Apps on your phone | 3, side by side, each signed in to its own world |
| Money spent by dev's video engine | **$0** |

## Announcement — the blog post before the feature

> **KnowScroll moved out of the laptop.**
> Your universe now lives at its own address, reachable from your phone or any browser. Behind it
> sit two more worlds you'll rarely notice. Dev is where new things get built and broken. Stage is
> where you try them with plenty of content before they reach you. A change travels dev → stage →
> live, and the last step is always yours. Before every release your universe is backed up and
> checked, so a bad release can be undone. On your phone, KnowScroll, KnowScroll Stage and
> KnowScroll Dev sit side by side, each clearly labelled, each in its own world.

## Screens

- [`mockups/01-environment-label.html`](mockups/01-environment-label.html): the label that marks
  the Stage and Dev apps and web pages, and the three app icons side by side. Live has no label.
  This is the only new UI.
- Everything else is the existing app at a new address.

## Addresses (owner decision, 2026-10-06)

No environment word in the address means live.

| World | Web app | Backend |
|---|---|---|
| Live | `app.knowscroll.space` | `backend.knowscroll.space` |
| Stage | `app.stage.knowscroll.space` | `backend.stage.knowscroll.space` |
| Dev | `app.dev.knowscroll.space` | `backend.dev.knowscroll.space` |

The bare `knowscroll.space` sends you to live. Stage and Dev each have a download page for their
phone app at `/download`, behind sign-in.

## Answers at this gate (2026-10-06)

1. **Live's addresses:** the shorter form, as in the table above.
2. **Phone installs:** a download page for **both** Stage and Dev. Live comes from Google Play.
3. **Other admins:** `XZNON` may move changes too. `Asrani-Aman` was not named and does not.
   Whether XZNON's right reaches live or stops at stage is confirmed at Gate 2.
4. **Order:** this feature goes first, as far as a working dev world. Then Cutroom runs on dev
   (free) and stage (real reels).

## What only you can do

1. Add the agent's SSH key from hPanel's browser terminal. The one-line command was given in chat
   on 2026-10-06. The password is never sent anywhere.
2. Server facts given: `srv2036699.hstgr.cloud`, KVM 2, **Ubuntu 26.04 LTS**, root login.
3. Add DNS records in hPanel. The list was given in chat on 2026-10-06 and is repeated at Gate 2.
4. Before Play: the Google Play developer account ($25, once), the release keystore and the prod
   mail credentials (release inputs 2–3).
