# Handoff — Android-first continuation of the six phases (2026-09-24, late)

This file continues [`2026-09-24-core-to-android.md`](2026-09-24-core-to-android.md), which stays
authoritative for scope and boundaries. It records what the first coordinator session delivered, the
owner decisions it collected, the work that remains as component issues, and the workflow the next
(ultracode) session must follow.

## 1. Delivered (main = `485faf7`)

Merged on 2026-09-24:

| PR | Phase | What |
| --- | --- | --- |
| #140, #142, #146, #148, #152 | #131 (closed), #133, #134 | semantic substrate and validated bridges with corrections; Composer v3 with attention accounts and hypotheses; the reader's places (ADR-0036); foundation Stars (ADR-0037); live Android continuations |
| #143, #151 | #132 | authorized Scroll Ask answers; background bridge inquiries (ADR-0038, migration 0032), with one bounded live MiniMax run |
| #150 | #133 | "What led here" on the desktop web |
| #147, #154 | #135 | owner sign-in, privacy and account deletion on Android and web (ADR-0034/0035; desktop cookie + CSRF); web Reset retry |
| #141, #144, #145, #149, #155, #157 | #136, #97, #115, #123 | web journey in CI; reader sheets survive recreation; Keep no longer dropped; matched frame phases; a watchdog for tests that hang; device tests install `com.knowscroll.mobile.journeytest` |
| #158 | #134 | "While you were away" and connection Relics (ADR-0039, migration 0033), proven on the emulator |

For detail, read the dated entries at the top of `docs/CHECKPOINT.md` and `docs/PROJECT-STATE.md`.

## 2. Owner decisions (standing; do not widen)

1. **Merging.** The coordinator may merge its own phase PRs after green CI on the exact head and a
   fresh-context review with no blocking findings. Merge with `gh pr merge N --squash
   --match-head-commit <full sha>`, and report on the PR and #72.
2. **MiniMax.** 155 requests are available: 5 left of the original 40, plus 150 added on
   2026-09-24 for writing Scrolls.
   - Subscription route only: the sk-cp key, no PAYG, no endpoint override.
   - Before each request, a quota preflight of at least 25% of interval and weekly.
   - At most 16 KB per request and 4,096 output tokens.
   - Disposable DBs and the test app only.
   - No model text in Git.
   - Receipts without prompts, outputs or keys.
   - Ledger: `$KS_DEV_ROOT/minimax-answer-session-ledger.json`.
3. **Sources are hidden from readers.** They are kept internally for checking: claims, validator,
   corrections and Relic provenance are unchanged. A model writes Scrolls in its own words from
   material fetched for it, and that material is stored privately. **OpenStax is excluded** (its
   pages say CC BY-NC-SA). Do not remove the internal source list.
4. **UI is Android-only for now.** The web catches up afterwards (#171), together with Cutroom
   (#9, owner-led and last). Social/Blend (#137) stays deferred.
5. **Release inputs come at the end.** The domain for App Links, the production mail credentials
   and the release keystore are provided at the end of the release work. They are not blockers.
6. **Desktop identity** is an HttpOnly Secure SameSite=Strict cookie plus CSRF. Android keeps its
   bearer token.
7. **Still needed from the owner later:**
   - a few days of real use to judge the recommendations (#133);
   - a physical Android phone over USB (#136, #170).

## 3. Boundaries (from the original handoff; they still apply)

- **Secrets.** Never print, echo or cat secrets (.env values, `DATABASE_URL`, the MiniMax key); only
  prefix checks are allowed.
- **The owner DB `knowscroll` is read-only.** Never migrate, reset or mutate it. Destructive work
  runs only on `knowscroll_test_*` and `knowscroll_demo_*` databases.
- **The owner's preview.** `com.knowscroll.mobile.journey` on API port 4322 is the owner's preview.
  - Device runners install `com.knowscroll.mobile.journeytest` (`KS_APP_ID_SUFFIX=.journeytest`).
  - `PreviewWatch` proves the preview is untouched.
  - Never use ports 4310, 4320, 4322, 4325 or 4392–4395.
- **No provider credentials** in mobile code, Git, logs or evidence. Live screenshots stay in the
  ignored `artifacts/`.
- **Git.** No force-push, and no reset of anyone else's work. Worktrees come from
  `/Volumes/Mrigesh SSD/knowscroll-product` (**not** Knowscroll-v2) under
  `/Volumes/Mrigesh SSD/knowscroll-worktrees/<slug>`. Copy `.env` into each (chmod 600), then run
  `pnpm install --frozen-lockfile`.
- **Never switch the branch of the main checkout** (`knowscroll-product`); it is not yours. Read
  main with `git show origin/main:<path>`.
- **Shell.**
  - Caches and logs stay on the SSD: `. ./scripts/env.sh` (`KS_DEV_ROOT=/Volumes/Mrigesh SSD/knowscroll-dev`).
  - `ls` hangs on the SSD, so use `find` or `git ls-files`.
  - Prefix commands with `export _ZO_DOCTOR=0;`.
- **Licences and rights** are the owner's decision.

## 4. Runtime

- **Emulator:** AVD `KnowScroll_API36`, serial `emulator-5554`, API 36. Run `. ./scripts/env.sh`
  before any `adb`.
- **Gates:**
  - `pnpm typecheck`;
  - `./scripts/test.sh [files]`, which uses a fresh disposable DB, migrates and seeds;
  - web `vitest`;
  - Android `./gradlew :app:assembleDebug :app:lintDebug :app:testDebugUnitTest`.
- **Device journeys:** `KS_SEMANTIC_JOURNEY=branch|why|sheets|ask|places|foundation|inquiry|return|owner
  python3 scripts/android-semantic-journey.py`. Each one runs a disposable stack on port 4333 and
  writes its receipt and screenshots.
- **Hands-on device testing:** see §6.
- **CHECKPOINT.md merge conflicts.** `docs/CHECKPOINT.md` gets a prepended entry per PR, so it
  conflicts on every merge; keep both sides.
- **CI-only flakes:** pg-pool-end, and `tests/generation-runtime.test.ts` (#169). Rerun once and
  record it; never call a rerun a fix.

## 5. Remaining work (component issues; all on Project 1)

| Issue | Phase | Slice |
| --- | --- | --- |
| #160 | #134 | Correction refresh (ADR-0040, proposed on this branch) |
| #161 | #134 | Android: readers never see a source |
| #162 | #134 | Model-written Scrolls (fetch, write in its own words, check; no OpenStax; 155 requests) |
| #163 | #134, #10 | Idea Rooms and bounded inhabitants |
| #164 | #134, #8 | Inventory end to end (Cutroom generation stays deferred) |
| #165 | #134 | Typed Relics beyond connections, plus #159 |
| #166 | #132 | Child inquiries, native continuation, more triggers, Android Ask progress/cancel/recovery, plus #153 |
| #167 | #133 | Reel concept annotations, Reel why sheets, policy tuning |
| #168 | #135 | Android release readiness without the owner's release inputs |
| #169 | #136, #123 | Root-cause the CI-only flakes |
| #170 | #136 | Android acceptance matrix on the emulator |
| #171 | #72 | Web UI catch-up (deferred, last with Cutroom #9) |

After #160–#170 are merged, all that remains before release is Cutroom (#9), the web catch-up
(#171), the owner's release inputs, and the owner's acceptance.

## 6. Verification standard (every slice)

A slice is done only when all of the following hold:
1. Meaningful tests are added: pure, then DB/API, then worker. Watch each fail, then pass.
2. It ran against a real disposable stack (API, worker, PostgreSQL), with SQL lineage.
3. **The coordinator used it by hand on the emulator:**
   - start the disposable stack and install the `.journeytest` build;
   - drive the app with the computer-use tool if it is available, or with
     `adb shell input tap|swipe|text` plus `adb exec-out screencap -p` and
     `adb shell uiautomator dump`;
   - **read every screenshot** and confirm that the visible result is the feature working;
   - exercise failure paths: pause, Clear, Reset, a correction, killing the app and recovering.

   Scripted journeys are added as regression guards; they do not replace this hands-on pass.
4. Evidence goes to `docs/journeys/evidence/<slice>-<date>/`: README, receipt.json, the preview-untouched
   proof, and screenshots with no model text (live-text screenshots stay in `artifacts/`).
5. Green CI on the exact head, then a fresh-context review whose Critical and Important findings are
   fixed, each with a test that failed before the fix. Deferred items go to a follow-up issue.
6. Merge, then update the issue, its phase, #72, Project 1 (Status), `docs/CHECKPOINT.md` and
   `docs/PROJECT-STATE.md`. Close an issue only when its acceptance is evidenced.

`scripts/android-hands-on.py` (Wave 0) keeps a disposable stack running for hands-on use with the
test app: `up` (in the background), `shot NAME [--ui]`, `sql`, `exec --`, `restart api|worker`,
`reinstall`, `down`. `android-living-preview.py --keep` belongs to the owner-preview path, so do not
use it for this.

## 7. Orchestration for the ultracode session (strict)

**Roles.**
- **Coordinator (the main session).** Owns contracts, migration numbering, integration, every `adb`
  and emulator action, every live MiniMax request, every merge, and every tracker update (issues,
  Project 1, CHECKPOINT, PROJECT-STATE). It does all device testing itself, serially: there is one
  emulator.
- **Implementer agent.** One per slice, in its own worktree on its own branch. It writes the code
  and the tests, and runs `pnpm typecheck`, `./scripts/test.sh <its files>`, and the Android unit
  tests and lint.
  - **Never:** `adb` or the emulator; live provider calls; merges or pushes to main; edits to
    issues or the board; touching the owner DB, the owner's ports or the preview.
  - It reports in at most 300 words: what changed, the exact test commands and results, and any
    open questions.
- **Reviewer agent.** One fresh-context review per PR, on the most capable model, read-only. It
  returns findings graded Critical, Important or Minor. The coordinator fixes Critical and Important
  findings with tests that failed first, and records Minor ones in a follow-up issue. There is no
  second review round.

**Limits.**
- At most **3 implementer agents at once**, and at most **30 agent runs in the whole session**
  (12 implementers, 12 reviewers and 6 spare).
- No agents to search a file you can grep, to re-run tests, to verify another agent's claim (the
  coordinator does that from real output), or to summarise.
- At most one read-only Explore agent per slice, and only when the slice touches code the
  coordinator has not read.

**Migration numbers, assigned now** so parallel branches never collide: 0034 #160, 0035 #165,
0036 #163, 0037 #164, 0038 #162 (if it needs one), 0039 #166 (if it needs one). An unused number is
left unused.

**Waves.** Within a wave, slices run in parallel; merges are one at a time, each rebased on the
new main.

| Wave | Slices | Notes |
| --- | --- | --- |
| 0 | handoff PR (this file), `scripts/android-hands-on.py` | Coordinator alone, no agents. The helper starts a `knowscroll_test_*` DB, the API on a free port (never the owner's), and the worker; installs `.journeytest`; stays up until stopped; and writes `preview-untouched.json`. |
| 1 | #160 correction refresh, #161 hide sources (Android), #169 flakes | #161 unblocks every later screenshot. |
| 2 | #162 model-written Scrolls, #166 reasoning, #167 Reels | #162: the implementer builds with the fixture transport only; the coordinator runs the live batch within budget. |
| 3 | #165 Relics, #163 Idea Rooms, #164 inventory | #163 and #164 each start with an ADR that the coordinator accepts before code. |
| 4 | #168 release readiness, #170 acceptance matrix | Mostly device work, so mostly the coordinator's. |

**Per-slice pipeline:**
1. The coordinator writes the brief: issue, worktree, branch, migration number, files in scope,
   the required tests, and the forbidden actions.
2. The implementer works.
3. The coordinator rebases the branch, runs every gate, then does the real disposable-stack run
   and the hands-on emulator pass (§6), and writes the evidence.
4. The coordinator opens the PR.
5. The reviewer reviews it.
6. The coordinator fixes the findings.
7. Green CI on the exact head, then merge.
8. The coordinator updates the tracker.

**Stop and report to the owner** only if a boundary would be crossed, or the MiniMax budget or the
agent-run budget is exhausted. Otherwise, record on the issue anything that needs an owner decision
and continue with other slices.

**Done** means #160–#170 are merged with evidence, or honestly recorded as blocked. #72 is then
updated with exactly what remains: Cutroom #9, the web catch-up #171, the owner's release inputs,
the owner's acceptance, and physical-phone evidence.

## 8. Goal, quality bar and the end state of the tracker

**The coordinator is the orchestrator.** Its goal is to complete all of #160–#170: working
functionality a person can use on the Android app, built from clean and maintainable code that reads
like the code around it. A slice whose tests pass but whose feature does not work by hand on the
emulator is not done. Neither is a feature that works but leaves rushed code behind: no dead
branches, no copy-paste, no test-only paths in product code, no hidden retries, and no weakened
tests.

**The tracker is driven to empty.** As each slice lands, its issue is closed with evidence. At the
end, the coordinator audits **every** open issue in the repository and on Project 1, including the
older component epics (#2–#8, #10, #12, #123) and every review follow-up (#153, #159, the ones this
session opens). Each one is then:
- closed because its acceptance is evidenced, with a comment linking the PRs and evidence;
- closed as explicitly superseded, naming the issue that carries what is left; or
- left open with one line saying exactly what it is waiting for.

Every Project 1 item's Status must match its issue.

The only issues that may stay open at the end are:
- #9 (Cutroom, owner-led, last);
- #171 (the web catch-up, with #156 inside it);
- #137 (Social/Blend, deferred);
- #72 (the release umbrella, until Cutroom, the web and the owner's acceptance are done);
- anything blocked on something only the owner can provide (the release inputs, a physical phone,
  the usefulness review), labelled as such.

An issue is never closed just to reach zero; it closes because the work is done.
