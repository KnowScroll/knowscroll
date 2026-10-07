# Status: Cutroom integration — real generated Reels in a seeded test universe

Issue: #199 (child of #9, owner-led Cutroom integration) · Branch: `claude/9-cutroom-integration` ·
Worktree: `/Volumes/Mrigesh SSD/knowscroll-worktrees/9-cutroom-integration` · Base: `dev` at `3a993b89`

Process: the four-gate workflow (Product → Architecture → Program Design → Slices). Each gate
stops for the owner's explicit approval. No implementation code before the Gate 4 slice plan is
approved.

- Gate 1 — Product: **APPROVED 2026-10-07** ("looks good approved"), after being re-presented for
  stage and dev with the shared Reel pool. The four questions were not answered, so the defaults
  recorded in `01-product.md` are adopted: label "Engine-checked"; real Reels first in the stage
  feed; a Scroll shortlist after the library grows; a smaller map on dev.
- Gate 2 — Architecture: **APPROVED 2026-10-08** ("approved"), as revised on 2026-10-07. This also
  adopts its three listed recommendations: a fal balance near $6, real-days reading on stage, and
  the voice `English_Graceful_Lady`.
- Gates 3 and 4: **skipped by the owner** ("skip program design and stage 4 and implement direct",
  2026-10-08). The build checklist below stands in for them. Each item lands as its own PR into
  `dev`, so dev shows the progress.

## Build checklist (in place of Gates 3–4)

Money is spent only in item 10, and only on scripts the owner has approved. Items 1–4: PR "#199 shared Reel pool" (ADR-0050); proven by `tests/shared-reel-pool.test.ts` and the publication-v2 case in `tests/publication-gates.test.ts`.

- [x] 1. Re-pin the Cutroom client to `94ee04a`: vendored schemas (`resumes`, `resumedBy`,
  `keptFrom`) and the pin.
- [x] 2. The shared `knowscroll_pool` record: its own migrations, claim/settle/release, the 500¢
  rule, a limited role.
- [x] 3. Generation:
  - content-derived request ids;
  - look-up-first jobs and claimed orders;
  - run chains settled as a sum;
  - live dispatch in test databases;
  - a 500¢ test-database cap.
- [x] 4. `publication-v2` and the engine-attested witness.
- [ ] 5. Engine-checked on screen: the contract, `readWhy`, web `ReelPlayer`, Android `ReelScreen`.
- [ ] 6. Content: a reel-script loader with review state; a content pack for model-written Scrolls.
- [ ] 7. The server:
  - operator commands in the release and `ks run`;
  - ffmpeg and fonts;
  - `ks-cutroom@pool` (stdin FIFO, SIGINT) and `ks cutroom-install`;
  - the pool database and `ks-generation@`;
  - artifact group, keys, budget file, voice;
  - `QUESTIONS.md` in `ks status`; no restart while an order is open.
- [ ] 8. The free journey on the Mac, using Cutroom's test mode.
- [ ] 9. Library growth (23 → 100+) as a content-pack PR.
- [ ] 10. Shortlist → owner-approved scripts → plan rehearsal → paid orders → Reels in both worlds.
- [ ] 11. The scripted reader: real days on stage, a small backdated map on dev.
- [ ] 12. A stage Android build (#201's Android slice), made locally on request.

## Depends on #201 (environments)

On 2026-10-06 the owner bought a Hostinger VPS and the domain `knowscroll.space`, and asked for
dev, stage and prod environments (#201, draft PR #202, `docs/plans/environments/`). This feature
now runs there:

- the "test universe" in Gate 1 becomes **stage**: seeded, with real reels within the $2 cap;
- **dev** is the free proving ground, with stand-in reels only;
- each environment has its own Cutroom.

Decision 3 below (a new test database) is answered by stage's own database.

**Shared Reel pool (owner, 2026-10-06, #201 Gate 3 review).** Stage and dev share one Cutroom
service, `cutroom-pool`, and one pool of Reels; live has its own `cutroom-live`. Only stage orders
paid runs. Dev has no paid grant: it receives the pool's Reels and tests for free with a temporary
stand-in Cutroom. This plan's Gate 2 must design:

- how one pooled run is imported into both databases;
- a request identity that both worlds can reconcile (so a replay never pays twice);
- counting spend once against the $2 cap.

## Owner amendments, 2026-10-07 (Gate 2 review)

In chat: "in Pool, dev can also use for testing and both dev and stage should use common reels as
it would help the world grow more we can raise cost to total of 5$, and we only give cutroom the
brief dont change any cutroom code or anything let cutroom work and give us back reel". Then three
choices, each the recommended option:

- **Both worlds order from the pool; every Reel is common.** This replaces the "Shared Reel pool"
  paragraph above. Dev is no longer receive-only.
- **$5 total in one shared spend record.** This replaces decision 5's $2.00 for this feature.
  Live's own $2 rule (ADR-0021 §6) is untouched.
- **You approve scripts, not orders.** An approved script may be ordered from either world without a
  further go-ahead.
- **Real Reels only.** There is no stand-in Cutroom on the server. Cutroom's free test mode is used
  only by an automated test on the Mac.
- **Nothing in Cutroom changes, its repository included.** There is no deploy key; the pinned
  version is copied from the Mac's clone.

## Notes for a fresh session

Decisions the owner made in chat on 2026-10-05. They are recorded here so none lives only in chat:

1. **Finish line: all the way to in-app playback.** A real Cutroom reel must play in the Reel
   player, not only exist as a file on disk.
2. **Witness gate: trust Cutroom's own checks.** The required `witness_alignment` gate
   (ADR-0024: structurally unavailable) is satisfied by Cutroom's own per-shot observation and
   reconciliation, under a new publication policy version and a new ADR. The verdict is always
   `pass_with_label`; its evidence says "engine-attested, not independent". Claude argued against
   this (Cutroom sees shot criteria, never claims or truth state) and the owner chose it knowingly.
   A later independent Witness replaces it through a new policy version.
3. **Where it plays: a new test database, not the owner's live one.** The owner wants it to feel
   like a real universe, but we test in a new database.
4. **The test database is fresh and heavily seeded, not a clone of the owner's.** Many Scrolls, many
   Reels (free simulated ones, labelled), and 3–4 real Cutroom reels requested. The owner will
   supply any missing API key on request.
5. **Live spend: $2.00 total, unchanged** (ADR-0021 §6; the database caps live grants at 200¢).
   *Superseded for this feature on 2026-10-07: $5 total across dev and stage, in one shared record.
   See the owner amendments above.*
   Recent real reels cost 49–58¢, so plan for **3 real reels at most**, with a stop rule if a failure
   or automatic re-run uses up the margin. Each paid run waits for the owner's go-ahead.
6. **Gate docs: in the repo on this branch, with a draft PR** and a child issue under #9.
7. **Rich map: grow it honestly.** Enlarge the library (23 sourced Scrolls → about 100+) through the
   existing model-written Scroll pipeline (ADR-0041, MiniMax token plan, no cash). Then a scripted
   test reader reads and keeps through the real API, so the real Cartographer forms planets,
   regions, sightings and Foundation Stars. **Black holes, solar systems, galaxies and nebulae are
   NOT built in this feature**. They become a later feature with its own gates, because the product
   definition requires each celestial object to be a typed semantic change with lineage.

Facts verified on 2026-10-05 that the later gates build on:

- KnowScroll's client pins Cutroom `86d6e2c8` (ADR-0021). Upstream main is `94ee04a1`, 221
  commits later. The wire drift is additive: `version`, `request`, `events` and `errors` are
  byte-identical; `responses` gains optional `resumes`/`resumedBy`; `record` gains optional
  `keptFrom`; and there are new `GET /v1/ready` and `POST /v1/runs/:runId/resume` routes.
- Upstream now ships its own service (`apps/service`: one process, API plus worker, real
  MiniMax/fal adapters), SDK tarballs and a paid example command. ADR-0021 said to supersede
  `ops/cutroom-host` when this happened.
- The upstream service **always** re-runs a provider-failed run once, after
  `CUTROOM_RESUME_DELAY_MS` (default 15 min). This can be delayed but not disabled. A lookup by
  the original request id then returns the newest run. ADR-0023 settles on the first run's result,
  so that spend would be missed unless the chain is followed.
- The `test_eligible` state is DB-restricted to `standin` provenance in `knowscroll_test_*`
  databases (migration 0014). A live reel can therefore never pass `imported` today.
- The old Cutroom clone `/Volumes/Mrigesh SSD/cutroom` and the pinned runtime worktree are gone. A
  fresh clone on the SSD is needed.
- The product `.env` names the fal key `FAL_AI_KEY`; Cutroom reads `FAL_KEY`. The existing key is
  never renamed or overwritten.

API keys (checked 2026-10-07, names only, no values printed): the product `.env` on the owner's Mac
already holds `MINIMAX_API_KEY` and `FAL_AI_KEY`, the only two provider keys Cutroom needs. No new
key is needed. They go to the server only for the Cutroom that stage orders from, copied without
printing (as `agentmail.env` was for #201). Dev's world never holds a paid provider key. Before the
first paid run the owner confirms the fal account has at least $2 of credit.
