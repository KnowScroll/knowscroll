# Architecture: real generated Reels shared by stage and dev

Gate 2. Status: **APPROVED 2026-10-08** (revised 2026-10-07 after the owner's review of the first draft). Gates 3–4 skipped by the owner; see 00-status.md.

- **Builds on:** the approved Gate 1 (`01-product.md`, with the 2026-10-07 amendments) and the
  running dev and stage worlds (ADR-0049, `docs/operations/environments.md`).
- **Facts:** every fact is cited in
  [`research/2026-10-07-cutroom-upstream-and-knowscroll.md`](research/2026-10-07-cutroom-upstream-and-knowscroll.md).

**The owner's rule for this design:** KnowScroll gives Cutroom the script and takes the finished
Reel back. Cutroom's code, settings model and repository are not changed. We run it the way
upstream ships it, only pointing its documented settings at our folders.

## What changed in this revision

| First draft | Now (owner, 2026-10-07) |
|---|---|
| Only stage orders; dev only receives, behind three locks | **Both worlds order**, and every Reel is common to both |
| $2, enforced by stage's database | **$5 total in one shared spend record** that both worlds draw from |
| Your go-ahead before each paid order | **You approve each script.** Ordering it then needs no further go-ahead; the $5 record stops it. |
| A free stand-in Cutroom on the server, plus a conductor scripting its answers | **Removed.** Real Reels only. Cutroom's free test mode is used only by an automated test on the Mac. |
| A read-only deploy key on the Cutroom repository | **Removed.** The pinned version is copied from the Mac, so nothing in the Cutroom repo changes. |

## What decides the shape

| Fact (verified) | Consequence |
|---|---|
| A request sent again with the **same id and the same content** is a replay. Cutroom returns the existing run and spends nothing. | A Reel can be made once and fetched by any world that knows its request id. |
| Cutroom has **no tenants, no auth and no total budget**. It runs one job at a time. | KnowScroll must hold the $5 and decide which world orders a Reel. |
| A failed run is **re-run automatically once** after 15 min, and each run reports only its own cost. Our client accepts one run per attempt, and its strict schemas reject the new `resumedBy` field. | Settlement follows the chain and adds up every run. The client is re-vendored at the new pin. |
| Results are **file paths on the same machine**. | Both worlds need read access to Cutroom's artifact folder. |
| Upstream has **no build and no deployment story**. It stops on **stdin EOF** and ignores SIGTERM. | Run the pinned checkout with stdin held open, and stop it with `SIGINT`. Both are settings of how we start it, not code changes. |
| Recent real runs: **about 1 in 3 completes**. A stopped run still costs 45–75¢. | $5 is about 9 attempts, so **about 3 Reels is likely**. Cheap rehearsals come first. |
| Model-written Scroll ids are random per database. A place on the map needs **2+ active days** of reading. | Content travels through Git with fixed ids. The reader runs over real days. |

## Fit: what runs where

```
                        Caddy (public hosts unchanged)
               ┌──────────────────┴──────────────────┐
          stage world                            dev world
   ks-api / ks-worker / ks-maintenance    ks-api / ks-worker / ks-maintenance
   ks-generation@stage  (new)             ks-generation@dev  (new)
               │      ┌───────────────────────┐      │
               ├─────►│ knowscroll_pool (new) │◄─────┤   the shared $5 record: who ordered
               │      │ one tiny database     │      │   each Reel, what it cost
               │      └───────────────────────┘      │
               │   order or look up, by request id   │
               └──────────────►┌───────────────┐◄────┘
                               │ ks-cutroom@pool│  127.0.0.1:8797, real MiniMax + fal,
                               │  (upstream)    │  provider keys here only
                               └───────┬───────┘
          /srv/knowscroll/cutroom-pool/artifacts   (group ks-pool: readable by ks-stage and ks-dev)
          each world copies the finished MP4 into its own media folder (content-addressed)
```

Live gets its own `ks-cutroom@live` and its own money in the live slice. It is not part of this
feature.

## Decisions

### 1. One Cutroom service, run as upstream ships it
- **`ks-cutroom@pool`:** upstream's `apps/service` with the real adapters (MiniMax, fal), on
  127.0.0.1:8797.
- **Code:** the pinned commit `94ee04a` is exported from the Mac's clone and copied to the server by
  a new `ks cutroom-install <commit>` (the tarball is sent on stdin, like a release). Then
  `pnpm install --frozen-lockfile` runs; every dependency is a public npm package. The pin changes
  rarely and on purpose.
- **Unit:**
  - its own user `ks-cutroom` and slice `ks-cutroom.slice` (low CPU weight and a memory cap), so
    the worlds stay responsive while a video encodes;
  - stdin is a FIFO opened read-write, so it never sees EOF; `KillSignal=SIGINT`;
  - Ansible installs ffmpeg and `fonts-liberation` (captions ask for "Arial", which Liberation Sans
    stands in for);
  - upstream refuses to start if any ffmpeg filter is missing, so a gap shows at once.
- **Settings:** only upstream's documented ones.
  - Database, artifacts and `QUESTIONS.md` under `/srv/knowscroll/cutroom-pool/`.
  - `CUTROOM_BUDGET_PATH` points to a one-line file setting a 75¢ per-reel cap.
  - Voice `English_Graceful_Lady`, the voice upstream verified live.
  - `ks` refuses to start the pool with the `'stand-in'` voice; otherwise a run would fail at
    narration after its pictures were paid for.
- **Keys:** `/etc/knowscroll/cutroom-pool.env` holds `MINIMAX_API_KEY` and `FAL_KEY`, readable only
  by `ks-cutroom`.
  - They are copied from the Mac's `.env` without printing.
  - `FAL_KEY` takes the value of the existing `FAL_AI_KEY`, which is never renamed.
  - No world's own env file holds a provider key.
- **Restarts:** `ks` refuses to restart or stop the pool while the shared record shows an order
  still in progress. A crash mid-run re-runs the job after a 4 h lease and could pay again for
  in-flight work.

### 2. The generation worker and operator commands join the worlds
- `ks-generation@stage` and `ks-generation@dev` run the bundle already built (`generation`).
- The operator commands (order, evaluate and mint, write Scrolls) are added to the release bundle.
  They run on the server as the world's own user, through `ks run <world> <command>`.
- Under disk pressure the disk guard already pauses `ks-generation@*` and `ks-cutroom@pool`.

### 3. Common Reels: one request id per script, one order, fetched by every world
- **A script's request id comes from its content:** `ks-reel-<first 32 hex of sha256(the script's
  wire fields)>`. The fields are narration, claims, criteria, style, the stage and the variation;
  the ceiling is not included. Both worlds hold the same script from Git, so both know the same id.
- **Each world keeps one job per approved script.** The job looks the id up on the pool:
  - if the Reel exists, the world follows it, imports the file, evaluates and mints it at 0¢;
  - if it doesn't exist yet, the job waits and checks again every few minutes.
- **Ordering is a separate step:** `ks run <world> generation order <script>`. It first claims the
  request id in the shared record, which reserves the ceiling. Only the world holding the claim
  ever sends the request.
  - A second world that tries finds the claim and simply waits for the Reel.
  - Even if it did send the request, Cutroom would replay it for free.
- **Result:** a Reel ordered from dev appears on stage once its script is promoted, and one ordered
  from stage appears on dev straight away. Either way it is paid for once, and a dev reset brings
  every Reel back for free.

### 4. Money: $5 total, in one shared record, counted honestly
- **The shared record is a tiny database, `knowscroll_pool`, on the same Postgres server.**
  - It has one row per ordered request id: who ordered it, its ceiling, what it cost, and the
    approval behind it.
  - A database rule refuses any claim that would take settled costs plus open ceilings above
    **500¢**.
  - Both worlds use it through a role that can only call claim, settle and release. It sits outside
    both worlds, so **resetting dev or stage cannot forget money already spent**.
- **Each world's own database keeps its existing spending guard as a second lock.**
  - The live cap trigger allows up to 500¢ in `knowscroll_test_*` databases.
  - It stays at 200¢ everywhere else, so live's $2 rule is untouched.
- **The ceiling** (75¢, or what is left) goes into the request's `budgetCents`. Cutroom checks it,
  and its per-reel cap, before every paid call.
- **Settlement follows the resume chain.**
  - An attempt can hold several runs; today it holds one.
  - The job stays open until the chain ends, then settles the **sum** of every run's cost, both in
    the world's ledger and in the shared record.
  - The client is re-vendored at `94ee04a`, so `resumes`, `resumedBy` and `keptFrom` parse.
- **Approval is per script.**
  - A script is ordered only once its review state is `approved`. Approval comes from your
    approval of that script's PR, and its reference is stored with the claim.
  - I do not merge reel-script PRs myself.
  - GitHub cannot tell us apart, so this is a rule kept and recorded, not a lock.
- **Our count is high, not low.** Cutroom reports cost at configured rates set above the providers'
  real prices (video "at least 16×"), so the real charge is lower than what we count.
- **A rehearsal before paying.** Each script first runs only to Cutroom's plan stage, which uses the
  model only (0¢; MiniMax token plan). Planner failures are caught before any picture is paid for.
- **`QUESTIONS.md` is surfaced.** Cutroom reports cap refusals only there, so `ks status` shows its
  new lines.
- **Recommended:** keep fal's prepaid balance near $6 during this feature, so nothing anywhere can
  spend much more than the $5.

### 5. "Engine-checked": a new publication policy, not a new gate
- **A new migration adds `publication-v2`.** Under it, `witness_alignment` is computed from the
  engine's record:
  - every chosen picture and every used take must carry an accepting Cutroom verdict, which gives
    `pass_with_label`;
  - the evidence says "engine-attested, not independent" and lists the observation ids;
  - anything missing or failed gives `fail`.
- **`publication-v1` and every Reel judged under it stay as they are.**
- **Real Reels become `eligible`. `test_eligible` stays stand-in only (0014).**
- **What the sheet can say:** Cutroom sends verdicts and ids, not what its witness saw. So "How it
  was checked" says which checks accepted each shot.
- **Screens:** the Reel asset contract and `readWhy` gain the label and a check summary. The web
  `ReelPlayer` and Android `ReelScreen` show the "Engine-checked" tag and the sheet. Every Reel is
  real, so no special feed ordering is needed.

### 6. Content travels through Git, so `main ⊆ stage ⊆ dev` holds for content too
- **The library grows on the Mac's SSD.** The existing ADR-0041 pipeline runs against a test
  database (MiniMax token plan, no cash).
  - The Scrolls it admits are exported, with their checks, as a **content pack** in `content/`,
    with fixed ids.
  - You can read every new Scroll in its PR.
  - The seed loads them into dev on deploy and into stage on promotion, keeping their model-written
    provenance.
- **Reel scripts** live in `content/reel-scripts/`. I draft each one from a Scroll on your
  shortlist and you approve it in its PR. The seed loads it into each world with its review state
  and creates that world's job for it.

### 7. Free proof first, on the Mac
- Before any money is spent, an automated journey on the Mac's SSD (the J005 shape, re-pinned to
  `94ee04a`) runs the whole path for free. It uses Cutroom's own test mode, a disposable database
  and a fixed test script:
  - order;
  - follow, including a re-run chain. If Cutroom's test mode can't produce a re-run, chain
    settlement is tested against recorded Cutroom responses instead;
  - import;
  - evaluate under `publication-v2`;
  - mint;
  - play.
- Nothing of this runs on the server.

### 8. The scripted reader
- It signs in the way you do: a magic link to `knowscroll@agentmail.to`, read through the AgentMail
  API.
- It uses only the public API: open, read, keep, ask.
- **On stage** it runs as scheduled sessions over at least 3 real days, because a place needs 2+
  active days.
- **On dev** it runs briefly with the existing test-only backdating helper, which gives the smaller
  map adopted at Gate 1.

## Data changes (new migrations)

| Change | Why |
|---|---|
| New database `knowscroll_pool`: one claim/spend table, a 500¢ rule, and a role limited to claim, settle and release | One shared $5 that survives resets |
| A job's request id comes from its script's content (existing rows untouched) | Every world knows a Reel's id |
| A job can receive (look up and import) without sending; an order needs a claim | Common Reels, ordered once |
| An attempt holds a chain of runs; spend is the chain's sum | Auto-resume |
| Live grant cap of 500¢ in `knowscroll_test_*` databases (200¢ elsewhere, unchanged) | The second lock fits $5 |
| `publication-v2` policy row, plus a version-aware witness gate | Engine-checked |
| A content-pack loader in the seed (model-written Scrolls, reel scripts with review state) | The same content in every world |

## Flow: one real Reel, start to finish

1. The free journey on the Mac passes.
2. I draft a script from a Scroll on your shortlist. You approve its PR, and it merges to dev.
3. Dev deploys. Its seed loads the script, and dev's job looks the id up: nothing yet, so it waits.
4. **Rehearsal:** `ks run dev generation order <script> --until plan`, which counts 0¢.
5. **Order:** `ks run dev generation order <script>`.
   - It claims the id in the shared record and reserves 75¢, or what is left.
   - Cutroom makes the Reel in 13–41 min.
   - `ks-generation@dev` follows it, including any automatic re-run.
   - It imports the file and settles the chain's total in both records.
6. Dev evaluates it under `publication-v2`, mints it, and it plays on dev with "Engine-checked".
7. The version is promoted to stage. Stage's job finds the same id on the pool, imports, evaluates
   and mints it. It plays on stage at 0¢.
8. Once less than one ceiling is left in the shared record, ordering stops.

## Risks

- **Odds.** About 1 in 3 recent real runs completed. With free plan rehearsals, and scripts written
  around Cutroom's known pitfalls (`docs/reel-pitfalls.md` upstream), $5 should give about 3 Reels,
  but that isn't certain.
- **Upstream is untested on Linux under systemd.** The first start is checked with its free test
  mode before the keys are installed.
- **One job at a time, 13–41 min per paid run.** Orders queue inside Cutroom. The shared record
  shows what is open.
- **Native module.** better-sqlite3 needs a linux-x64 prebuild, with build-essential as a fallback.
- **Stage Android build.** Gate 1 measures playback on a stage Android build, so this feature needs
  #201's Android slice (local builds on request). I'll do that slice when we reach it.

## Approving this gate also adopts

1. **fal backstop:** you keep fal's prepaid balance near $6 for this feature.
2. **Map growth on stage** over at least 3 real days; dev keeps a small backdated map.
3. **Narration voice** `English_Graceful_Lady`. Any other MiniMax voice can be swapped in later
  with one setting.
