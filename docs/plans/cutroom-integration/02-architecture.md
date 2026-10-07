# Architecture: real generated Reels on stage and dev

Gate 2. Status: **awaiting approval**.

- **Builds on:** the approved Gate 1 (`01-product.md`) and the running dev and stage worlds
  (ADR-0049, `docs/operations/environments.md`).
- **Facts:** every fact below is cited in
  [`research/2026-10-07-cutroom-upstream-and-knowscroll.md`](research/2026-10-07-cutroom-upstream-and-knowscroll.md).
- **Cutroom itself is not changed** (Gate 1). Everything here is KnowScroll code, server setup, or
  the way upstream's own service is run.

## What decides the shape

| Fact (verified) | Consequence |
|---|---|
| A request sent again with the **same id and the same content** is a replay. Cutroom returns the existing run and spends nothing. Same id with different content is refused. | Two worlds can share a Reel by sending the *same request*. The receiving world only ever looks it up. |
| Cutroom has **no tenants, no auth and no total budget**. It runs one job at a time. | KnowScroll alone must stop dev from ever ordering, and must enforce the $2. |
| Real or stand-in is **fixed per Cutroom process**. The stand-in model answers only from a script, **one run per process**. | Two Cutroom services: a paid pool and a free stand-in. The stand-in is restarted with a matching script for each free run. |
| A failed run is **re-run automatically once** after 15 min. Each run reports only its own cost. Our client accepts only one run per attempt, and its strict schemas reject the new `resumedBy` field. | Settlement must follow the chain and add up every run. The client is re-vendored at the new pin. |
| Results are **file paths on the same machine**, not downloads. | The worlds that import need read access to Cutroom's artifact folder. |
| Upstream has **no build and no deployment story**. It stops on **stdin EOF** and ignores SIGTERM. | Run a pinned checkout with its stdin held open and `SIGINT` to stop. This is proven on dev first. |
| Recent real runs: **about 1 in 3 completes**. Stopped runs still cost 45–75¢. | $2 most likely buys 1–2 real Reels, not 3. Cheap rehearsals first; see question 1. |
| Model-written Scroll ids are random per database, and a place on the map needs **2+ active days** of reading. | Content travels through Git with fixed ids. The reader runs over real days on stage. |

## Fit: what runs where

```
                       Caddy (unchanged public hosts)
              ┌──────────────────┴──────────────────┐
         stage world                            dev world
   ks-api / ks-worker / ks-maintenance    ks-api / ks-worker / ks-maintenance
   ks-generation@stage  (new)             ks-generation@dev  (new)
      │ orders (paid, authorized)            │ receives only ─────┐
      │ orders (free)                        │ orders (free)      │
      ▼                                      ▼                    ▼
 ks-cutroom@pool :8797  ◄── read-only door :8798 (GET only) ◄─────┘
 real MiniMax + fal, keys here only
 ks-cutroom@standin :8796  ◄── both worlds, free, no keys
      │ writes                              
 /srv/knowscroll/cutroom-<pool|standin>/artifacts   (group ks-pool: readable by ks-stage, ks-dev)
      │ each world copies the finished MP4 into its own media folder (content-addressed)
```

All three Cutroom ports listen on 127.0.0.1 only. Live gets its own `ks-cutroom@live` in the live
slice. It is not part of this feature.

## Decisions

### 1. Two Cutroom services, run as upstream ships them
- **`ks-cutroom@pool`** has the real adapters (MiniMax, fal). It holds the paid shared pool, and
  only stage orders from it.
- **`ks-cutroom@standin`** has every adapter fake and holds no keys; it refuses to start if one is
  present. Free runs for both worlds go here.
  - A small KnowScroll **stand-in conductor** writes the matching script for each free request and
    restarts the service with it.
  - The SQLite file and artifacts persist across restarts, so a run can still be looked up later.
- **Code:** a pinned checkout of `KnowScroll/Cutroom` at `94ee04a`, `pnpm install --frozen-lockfile`,
  started with Node's type stripping.
  - Ansible fetches it with a **read-only deploy key on the private Cutroom repo** (question 3).
  - It does not come through GitHub Actions: the KnowScroll repo is public, so its logs and
    artifacts would expose private code.
  - The pin changes rarely and on purpose.
- **Unit:** its own user `ks-cutroom` and slice `ks-cutroom.slice`. That slice has low CPU weight,
  so the worlds' APIs stay responsive while a video encodes, and a memory cap.
  - stdin is a FIFO opened read-write, so it never sees EOF; `KillSignal=SIGINT`.
  - ffmpeg, plus `fonts-liberation` so captions render "Arial" as its metric twin.
  - Upstream refuses to start if any ffmpeg filter is missing, so a gap shows at once.
- **Settings:**
  - Database, artifacts and `QUESTIONS.md` under `/srv/knowscroll/cutroom-<name>/`.
  - A KnowScroll-owned `BUDGET.md` sets a 75¢ per-reel cap, as a second lock behind our own.
  - Voice `English_Graceful_Lady`, the voice upstream verified live (question 5).
  - The pool refuses to start with the `'stand-in'` voice: otherwise a run would fail at narration
    after the pictures were paid for.
- **Keys:** `/etc/knowscroll/cutroom-pool.env` holds `MINIMAX_API_KEY` and `FAL_KEY`, readable only
  by `ks-cutroom`.
  - They are copied from the Mac's `.env` without printing.
  - `FAL_KEY` takes the value of the existing `FAL_AI_KEY`, which is never renamed.
  - No world's own env file holds a provider key.
- **Restarts:** `ks` refuses to restart or stop the pool while a paid run is open. A crash mid-run
  re-runs the job after a 4 h lease and could pay twice for in-flight work.

### 2. The generation worker and operator commands join the worlds
- `ks-generation@stage` and `ks-generation@dev` run the bundle that is already built (`generation`).
- The operator commands are added to the release bundle:
  - order;
  - receive;
  - evaluate and mint;
  - write Scrolls.
- They run on the server as the world's own user, through `ks run <world> <command>`.
- Under disk pressure the disk guard already pauses `ks-generation@*` and `ks-cutroom@pool`.

### 3. The shared pool: one request identity; stage orders, dev receives
- **Request identity comes from the content:**
  - `requestId = ks-reel-<first 32 hex of sha256(the compiled request without its id)>`;
  - the wire request carries labels and criteria, never database ids, so both worlds compute the
    same id from the same script;
  - changing one word makes a new id, and so a new Reel.
- **Every generation job is either an *order* or a *receive*:**
  - An order sends the script.
  - A receive never sends anything. It looks the run up by id, follows its events, reads the result
    and record, and imports the file.
  - If the pool doesn't have that run yet, a receive waits.
- **Who may do what:**
  - Stage orders from the pool (only with an authorized grant) and from the stand-in.
  - Dev orders only from the stand-in. From the pool it can only receive.
- **Three independent locks keep dev from paying:**
  1. **Database:** a trigger in `knowscroll_test_dev`, like the 0014 fence, refuses an order job on
     a live engine and any live grant above 0¢.
  2. **Code:** the worker refuses to send to an engine for a receive job.
  3. **Network:** dev's user cannot reach port 8797 at all (an nftables rule by user id). It gets a
     read-only door on 8798, where Caddy passes only `GET`. A bug in dev cannot order a paid run.
- **Spend is counted once.** Only stage holds a live grant. Dev's copy records "paid by stage,
  request `<id>`, 0¢ here".
- **A dev reset costs nothing.** Reseeding recreates the receive jobs from the scripts in Git (6
  below), and the Reels come back from the pool for free.
- **The free proof comes first.** Before any money, stage orders a stand-in Reel and dev receives it
  by exactly the path it will use for paid Reels.

### 4. Money: at most $2, counted honestly
- **The cap:** stage's existing database cap of 200¢ of live grants. Each order reserves its ceiling
  (75¢, or whatever is left of the $2) and settles to the reported cost.
- **The ceiling** goes into the request's `budgetCents`. Cutroom checks it, and its per-reel cap,
  before every paid call.
- **Settlement follows the resume chain.**
  - An attempt can hold several runs (a schema change; it is one today).
  - The job stays open until the chain ends, then settles the **sum** of every run's cost.
  - The client is re-vendored at `94ee04a`, so `resumes`, `resumedBy` and `keptFrom` parse.
- **Your go-ahead for each paid order is recorded.** I quote it in #199, and the grant's
  `authorization_ref` points to that comment. GitHub cannot tell us apart, so this is an honest
  record, not a lock.
- **Our count is high, not low.** Cutroom reports cost at configured rates set above the providers'
  real prices (video "at least 16×"), so the real charge is lower than what we count.
- **A rehearsal before paying.** Each script first runs on the pool only to its plan stage. That
  uses the model only and counts 0¢ (MiniMax token plan). Planner failures are caught before any
  picture is paid for.
- **A backstop outside KnowScroll.** Keep fal's prepaid balance small during this feature, so no
  bug anywhere can spend much (question 2).
- **Stage's database is not reset while it holds paid spend.** `ks` refuses.
- **`QUESTIONS.md` is surfaced.** Cutroom's cap refusals go only to that file, so `ks status` shows
  its new lines.

### 5. "Engine-checked": a new publication policy, not a new gate
- **A new migration adds `publication-v2`.** Under it, `witness_alignment` is computed from the
  engine's record:
  - every chosen picture and every used take must carry an accepting verdict from Cutroom's checks,
    which gives `pass_with_label`;
  - the evidence says "engine-attested, not independent" and lists the observation ids;
  - anything missing or failed gives `fail`.
- **`publication-v1` and every Reel judged under it stay as they are.**
- **Real Reels become `eligible`. `test_eligible` stays stand-in only (0014).**
- **What the sheet can say:** Cutroom does not send what its witness *saw*, only verdicts and ids.
  So "How it was checked" says which checks accepted each shot, not what was seen.
- **Screens:** the Reel asset contract and `readWhy` gain the label and a check summary. The web
  `ReelPlayer` and Android `ReelScreen` show the "Engine-checked" tag and the sheet.
- **"Real Reels first in the stage feed"** is a test-world-only ordering rule. Live's feed is
  untouched.

### 6. Content travels through Git, so `main ⊆ stage ⊆ dev` holds for content too
- **The library grows on the Mac's SSD.** The existing ADR-0041 pipeline runs against a test
  database (MiniMax token plan, no cash).
  - The Scrolls it admits are exported, with their checks, as a **content pack** in `content/`,
    with fixed ids.
  - A PR to dev carries them, so you can read every new Scroll there.
  - The seed loads them into dev on deploy and into stage on promotion, keeping their model-written
    provenance.
- **Reel scripts** live in `content/reel-scripts/`.
  - I draft each one from a Scroll and you approve it in its PR.
  - Merging pays nothing. A paid order is a separate step with your go-ahead.
- **Simulated Reels** go through the real pipeline from the stand-in Cutroom, so the whole path is
  tested for free. They are always labelled "Simulated media".

### 7. The scripted reader
- It signs in the way you do: a magic link to `knowscroll@agentmail.to`, read through the AgentMail
  API.
- It uses only the public API: open, read, keep, ask.
- **On stage** it runs as scheduled sessions over at least 3 real days, because a place needs 2+
  active days (question 4).
- **On dev** it runs briefly with the existing test-only backdating helper, which gives the smaller
  map adopted at Gate 1.

## Data changes (new migrations)

| Change | Why |
|---|---|
| Several engines per database (pool, stand-in), each with its mode | Dev and stage use two Cutroom services |
| Job kind `order` / `receive`. A receive carries the request id and the world that paid. | The shared pool |
| An attempt holds a chain of runs; spend is the chain's sum | Auto-resume |
| Content-derived `requestId` for new jobs (old rows untouched) | Same id in both worlds; replays are free |
| Dev-only trigger: no order job on a live engine, no live grant above 0¢ | Lock 1 |
| The `publication-v2` policy row, plus a version-aware witness gate | Engine-checked |
| A content-pack loader in the seed (model-written Scrolls, reel scripts) | Same content in both worlds |

## Flow: one real Reel, start to finish

1. I draft a script from a Scroll on your shortlist. You approve it in a PR to dev.
2. **On dev, free:** dev orders it from the stand-in, then imports, evaluates and mints it. It plays
   as "Simulated media".
3. The version is promoted to stage. Stage repeats step 2 for free. Dev receives one of stage's
   stand-in Reels to prove the receive path.
4. **Rehearsal:** stage orders the script on the pool, only to its plan stage. It counts 0¢.
5. **Your go-ahead:** I quote it in #199. Stage gets a grant: a ceiling of 75¢ or what is left.
6. Stage orders the video. Cutroom makes it in 13–41 min. `ks-generation@stage` follows it,
   including any automatic re-run, then imports and settles the chain's total.
7. Stage evaluates it under `publication-v2`, then mints it. It plays on stage with "Engine-checked".
8. Dev receives it by the same id through the read-only door, then imports, evaluates and mints it.
   It plays on dev at 0¢.
9. If what is left of the $2 is below one ceiling, ordering stops.

## Risks

- **Odds.** About 1 in 3 recent real runs completed, and a stopped run still costs 45–75¢. With
  free plan rehearsals and scripts written around Cutroom's known pitfalls (`docs/reel-pitfalls.md`
  upstream), 1–2 Reels is likely and 3 is possible but not likely.
- **Upstream untested on Linux under systemd.** The stand-in service proves the lifecycle on dev
  before the pool holds a key.
- **One job at a time, 13–41 min per paid run.** Stand-in runs use their own service, so they don't
  queue behind it, but they share the CPU.
- **Native module.** better-sqlite3 needs a linux-x64 prebuild, or build-essential as a fallback.
- **Stage Android build.** Gate 1 measures playback on a stage Android build, so this feature needs
  #201's Android slice (local builds on request). I'll do that slice when we reach it.

## Questions for you at this gate

1. **Odds against the $2.** At recent odds, $2 most likely gives 1 real Reel, maybe 2, rarely 3.
   *Recommended:* keep $2 and the target "at least 1, up to 3", use free rehearsals, and stop when
   less than one ceiling is left. The alternative is to raise the cap (for example to $4) for a
   better chance of 3.
2. **fal backstop.** Keep fal's prepaid balance small (about $3) for this feature, so nothing can
   overspend. *Recommended:* yes.
3. **Cutroom code on the server.** May I add a read-only deploy key to the private
   `KnowScroll/Cutroom` repo, so the server can fetch the pinned version? *Recommended:* yes. The
   alternative is that I upload it by hand from the Mac for each pin change.
4. **Map growth on stage.** Read over at least 3 real days, which is honest and slower, or backdate
   history, which is fast but the map didn't really grow that way? *Recommended:* real days.
5. **Narration voice.** `English_Graceful_Lady` (verified live by Cutroom), or another MiniMax voice?
