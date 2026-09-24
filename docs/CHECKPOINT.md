# Shared delivery checkpoint

## 2026-09-24 #131 decorative Places art labelled (lane `131-illustrative-art`)

The Places layer's line now reads "Positions, orbits, moons and land art are illustrative — what's
mapped and how it connects is real.", so no decorative orbit ring, moon, continent, current or cloud
implies verified knowledge. This is #131's last open item. `PlacesScreenTest` was updated first; Android units, lint
and the emulator `places` journey pass. See the
[evidence](journeys/evidence/illustrative-art-2026-09-24/README.md).

## 2026-09-24 #136 verification harness: matched frame phases, preserved preview, #91 journey repaired (lane `136-frame-timing`)

`AtlasProfileTest` now records every frame phase and one row per frame. Every device runner that
installs the `.journey` app (the semantic, profile and #91 explain runners, the six older ones and
`android-living-preview.py` in its verification mode) now goes through
`scripts/android_preview.py`. Only `android-living-preview.py --keep`, the preview's own setup,
installs it deliberately. The guard:
- it refuses, touching nothing, if the preview cannot be backed up or holds a keystore-sealed
  signed-in session;
- it restores only if the run actually replaced the preview;
- it verifies every file by hash.

Matched profiles on a quiet host, baseline `81431cc` against main at `a9b5e1c`, interleaved (see the
[profile evidence](journeys/evidence/frame-profile-2026-09-24/README.md)): equal p95 (67.6 vs
67.4 ms) and better p50 (33.8 → 29.5 ms). One early baseline run under a different host state
matched the old 47.40 ms, so host state moves absolute numbers by about 50%.
Recomposition p95 roughly doubled (10.1 → 19.7 ms), with more draw and swap; that is the next
target. Smoothness is not accepted: almost every emulator frame is over 16.67 ms.

The #91 reader-explain journey was failing on main from harness rot. Its proxy missed
`/v1/feed?kinds=`, and it looked for saved Traces on the universe screen instead of in Keep by
title. It now passes 9/9 ([evidence](journeys/evidence/reader-explain-2026-09-24/README.md)).

## 2026-09-24 #133 "What led here" on the desktop web (lane `133-web-why`)

This reaches parity with Android's journey G on the web reader. "Why this appeared" now loads the
recorded explanation for the Scroll being read (`GET /v1/decisions/:id/why`). It shows the family
that chose it, one line per recorded step, and the corrections that path supports: "Less like
this", and "Wrong connection" where a connection was crossed. Each correction says what it does
before and after, is idempotent under its request id across retries and reopening, and goes
through the CSRF-aware client. A path that was never recorded (404, or a saved Trace) is shown
honestly. Parsing is strict, and the web's zod schemas are guarded against the contracts by
`contractsDrift`. Web units 199 (15 → 18 files). A new journey, `run-web-why-journey.ts`, uses a
real cookie sign-in and a disposable database with the substrate, and checks lineage in SQL (the
v3 decision, the cited keep, exactly one `less_like_this` under the page's request id, bridges
unchanged). The reader journey passes 50/50. CI's web-journey job now also runs the owner (#135)
and why journeys. [Evidence](journeys/evidence/web-why/last-run-receipt.json).

## 2026-09-24 #131/#134 foundation Stars (lane `131-foundation-stars`)

ADR-0037, migration 0031, `cartographer-v2`. A live planet or region whose anchor explains, or
comes before, at least three things across at least two of the reader's other live places, each
connection sourced, is recognised as a foundation. Attention plays no part. Recognition and
withdrawal are deltas (`foundation_recognised`/`substrate_neighbourhood`; `foundation_withdrawn`
with `source_correction` or `reader_correction`), and setting a place aside re-evaluates in the
same transaction. The schema refuses the flag on a sighting and any flag change without a delta.
The atlas returns `foundation: {holdsUp, relations}` per place. Android parses it strictly, draws
the marker brighter and says "Foundation", adds "· Foundation" in the list, shows what it holds up
with each connection's claim in the sheet, and explains both deltas' evidence.

Verification on `d51af5b` (main merged, review fixes in): pure 7 (a kind mutant killed), HTTP 5,
backend 844+13, Android 194 + lint (web 87 on `6f8a910`, untouched since), and the emulator `foundation` journey with SQL lineage,
plus the places journey again. A fresh review found stale foundation connections, a rejection that
re-ran the whole Cartographer, and an unsupported screenshot claim; all fixed test-first. Gravity formed from the device's reading and was recognised in the same transaction;
setting Tides aside withdrew it. Tides, Orbit and Star formation were placed from supplied accounts
(labelled; the library cannot anchor the last two from reading). The first device run showed each
connection twice on the sheet, fixed test-first. See the
[evidence](journeys/evidence/foundation-2026-09-24/README.md). Preview restored; no provider call.
Merge after #147 (0030 before 0031).

## 2026-09-24 #135 owner access, privacy and release clients (lane `135-owner-access`)

ADR-0034, ADR-0035, migration 0030. Server: a desktop session cookie (HttpOnly, Secure,
SameSite=Strict) minted from a magic link, whose page never sees a token. Every change needs an
HMAC CSRF token and a same origin, and there is one credential per request. The emailed link is
`<origin>/sign-in#token=…`. Account deletion erases, in one transaction, what Reset erases plus
sessions, sign-in tokens, dated privacy receipts and the account, leaving an address-free
tombstone; schema guards allow those deletions only inside it. A read-only snapshot of the owner
database was restored into a disposable clone, and only the clone was migrated and verified (re-run after the review with 0029 and 0030: 9 → 27 migrations, every row and checksum kept). Web:
a signed-out screen, the `/sign-in` page, CSRF in the client, sign-out and deletion, and a
cookie-mode proxy. Android: magic-link sign-in with a Keystore-encrypted session, and a Privacy &
account screen (pause/resume, export, Reset, delete, sign out) at parity with web.

Verification (after the review fixes): web-session 6, account-deletion 6 (3 mutants), backend suite, web units, Android
units + lint, the web owner journey (Playwright, cookie mode) and the emulator owner journey with
SQL checks; see the [evidence](journeys/evidence/owner-access-2026-09-24/README.md). Four initial
device failures are recorded there, including a launch crash that the JVM tests had missed.
Preview restored; the owner database was only read.

## 2026-09-24 #134 first slice — the reader's places (lane `134-living-worlds`)

ADR-0036; migration 0029 (`atlas_place`/`atlas_delta`). A pure
Cartographer (`cartographer-v1`) runs in the personal-model refresh, never while paused: an
anchored concept becomes a free planet or a region of the nearest anchored ancestor (two parent
hops). Planets and regions offer up to five sightings: never-shown concepts one active typed
relation or admitted bridge away. A revoked relation retires its sighting, and the reader can set a
place aside for good. Every change is an immutable delta with a causal class and evidence; a
deferred constraint trigger refuses a place change without one. `GET /v1/atlas`,
`GET /v1/atlas/deltas/:id` and `POST /v1/atlas/places/:id/reject` go through a strict contract.
Android: a Places | Sources choice on the System screen (Sources unchanged). Places shows the live
planets, regions and sightings on the accepted Atlas visuals, and a place sheet with its account,
Scroll counts, sightings with their claims, chronicle lines that open their evidence, and "Set
aside". Authored geography stays for Sources and the labelled preview.

A fresh-context review found 1 blocking defect (a sighting whose subject the reader then read stayed
live with attention; Android refused the atlas) and 4 important ones; all fixed test-first. A
second, verification review found nothing blocking; its important findings (a false empty Places
while loading or after a failure, claim-backed sightings first overall, an anchored sighting
promoted before a revoked basis retires it, honest wording) were fixed test-first as well.
Verification on `bfd9843` (main merged at `95f7481`): pure 12 (4 mutants), HTTP 6, backend 832+13,
web 87, Android 183 units + lint, and the emulator places journey with SQL lineage; see the
[evidence](journeys/evidence/places-2026-09-24/README.md). Preview restored; no provider call.

## 2026-09-24 #132 authorized Scroll Ask answers (lane `132-product-reasoning`)

Branch `claude/132-product-reasoning` on main `6a56b24`. ADR-0033 (with the validator-v2
amendment); migration 0028 appended to `RELEASED.txt`. A recorded Ask becomes an answer only on a
fresh reader action (`POST /v1/asks/:askId/answer`) from the Ask's own session, when recording is
not paused and an answer route is enabled. The API only records the request; the worker schedules
it fairly (ADR-0019 plane: fairness, admission, one invocation, reconciliation), sends exactly the
reserved bytes once through the worker-only transport (fixture or MiniMax-M3 subscription route
with quota preflight), and applies provider text only through the answer validator (v2): one JSON
object, every basis quote verbatim in the sealed Scroll, bounded, nothing about the reader.
Otherwise the answer is `rejected` with content-free reason codes. Unknown outcomes hold their
remote slot and are never retried. Clear/Reset erase requests and answers; export carries them.
Android: Ask sheet with "Get an answer", answered/not-in-source/rejected/failed states, cancel.

Live, bounded (28 of 40 authorized requests): v1 rejected every reply to the Android journey's
yes/no question because MiniMax wrapped basis quotes differently; v2 projects items to their quote
and keeps every other rule; 0/5 → 5/5 answered with verified quotes, then answered on the emulator.
A fresh-context review found 2 blocking defects (all-space quotes passed; an attempt admitted but
never sent left the Job and its remote slot stuck) and 8 important ones; a verification review of
those fixes found 3 more (a signed-out reader broke the recovery sweep; a reply recorded but never
applied stayed open; the reader check let "you are curious" through). All were fixed test-first and
the evidence regenerated from clean commits. Verification: core 10, lifecycle 12, recovery 3,
signed-out 1, crash 1, transport 7, backend 814+13, Android 130 units, fixture and live emulator
journeys with DB lineage; see the
[evidence](journeys/evidence/ask-answers-2026-09-24/README.md). Preview restored after every run;
owner database untouched.

## 2026-09-24 #97 reader sheets survive recreation (lane `97-reader-sheet-restore`)

The Sources, Why and Connections sheet flags are hoisted to `ScrollScreen`, above the state `when`
that briefly unmounted them while `onForeground()` restored the stored Scroll after recreation (a
second mount cannot consume a Bundle-restored value). Verified on the real stack with the emulator:
`OK (3 tests)`, all three sheets restored; Android 112 units and lint. The first device run failed
2 of 3 on test isolation (recorded in the [evidence](journeys/evidence/reader-sheets-2026-09-24/README.md)).
Preview restored and verified.

## 2026-09-24 #133 Composer v3 + #131 attention accounts and hypotheses (lane `133-semantic-composer`)

Branch `claude/133-semantic-composer` on main `b0281db`. ADR-0032; migration 0027 appended to
`RELEASED.txt`. `composer-semantic-v3` is the feed's default policy (`composer-signals-v2` stays
registered, immutable and selectable). It records every considered candidate (`decision_candidate`)
and its served window/quotas (`decision_context`); commit-time triggers refuse a self-contradicting
decision. Attention accounts (`attention-v1`) and rule hypotheses (`hypothesis-rules-v1`: direction,
open question) are recomputed in the transaction that records a keep, exposure, branch, Ask or
correction; Clear/Reset erase them and export carries them. `GET /v1/decisions/:id/why` and
`POST /v1/encounters/feedback` (journey G). Android: **What led here** and **Less like this** /
**Wrong connection** in the Scroll reader's why sheet.

Ruling recorded in ADR-0032 §3: a *seen* encounter is reranked below every unseen one, never gated.
Seen-gating broke the established exhaustion contract (7 of 48 web-journey specs failed), and a
soft penalty made readers run out early in the offline comparison. Verification: pure 15+9,
HTTP 11 with 6 mutation checks, backend 778+13, Android 107 units, the web journey and the emulator
why journey with DB lineage checked, and an offline v2-vs-v3 comparison (behaviour, not
usefulness). Feed latency is ~20 ms at 500 Scrolls (was ~225 ms). See the
[evidence](journeys/evidence/composer-v3-2026-09-24/README.md). No provider call; MiniMax 0/40.

## 2026-09-24 #131 first slice — semantic substrate, validated bridges, live Android continuations (PR140)

Worktree `131-semantic-foundations`, branch `claude/131-semantic-foundations`. ADR-0031; migration
0026 appended to `RELEASED.txt`. Delivered: immutable source-backed claims on hashed snapshots;
bridges admitted only by the pure `bridge-validator-v1` from a recorded, replayable read-set slice;
commit-time database guards; deterministic correction propagation (and seed-load revalidation);
live continuations with branch lineage (`branch` Ledger event caused by the origin exposure, a
branch decision, `branch_open`); personal "not useful / seems wrong"; pause, Clear/Reset erasure
and export. 23 editorial Scrolls and a 9-source substrate (32 concepts, 60 claims, 71/71 quotes
verified against persisted snapshots, 6 admitted bridges, 4 tempting ones refused).

Verification: backend 756/756, web 79/79, Android 102 units + lint, emulator journey `OK` with the
database lineage checked in SQL (see the
[evidence](journeys/evidence/semantic-2026-09-24/README.md)). Two fresh-context reviews: the first
found 1 blocking + 6 important defects, all fixed test-first; the verification review found 2 more
important ones, also fixed. The web journey now seeds its own three-Scroll fixture
(`apps/web/e2e/fixtures/reader-library.json`), because it proves reader mechanics over a finite
library and the product library grew. No provider call; MiniMax budget used 0/40.

Not done in #131: hypotheses, uncertainty and decay (ADR-0032, lane `133-semantic-composer`), and
evidence-backed geography semantics. Deferred minors are listed on PR140. The owner's `.journey`
preview (4322) was restored and verified after every emulator run; owner database `knowscroll`
untouched.

## 2026-09-24 six-phase personal delivery and tracker cleanup

Owner asks for all six remaining phases to be implemented with continuous verification and
maintainable code, prioritizing recommendation/reasoning/world formation connected to Android.
The complete [next-session implementation handoff](handoffs/2026-09-24-core-to-android.md) is authoritative for this wave.
Execution issues: #131 semantic foundations, #132 product reasoning, #133 full Composer, #134 living
worlds/inventory/Android, #135 owner access/privacy/release clients, #136 verification, performance and acceptance.
Phase6 starts with phase1; every slice needs runtime and visible-result evidence. This update
records scope and tracking only, not completion of any phase.

PR130 is merged as `f89e6257c8120b3b2e6aad3397dbd7be9c52530b`; the owner says the Android
result looks great. Preserve it; visual approval does not accept the documented frame regression.
Cutroom #9 remains owner-led and last. Social/Blend is a separate deferred future epic #137
under single-user ADR-0026, superseding #11's older planning entry. #57 is consolidated into
#123/#136 without claiming the original missing acknowledgement was explained. #97, #115 and
#123 remain open. Component epics retain unfinished acceptance and updated phase links.

Project1's README/statuses and #72 now carry this sequence. Future sessions must update issues,
Project1, checkpoint and PROJECT-STATE as they implement and verify, not only at the end.
#72 remains open for applicable personal, required Android/desktop and final real-video gates.
The handoff docs worktree is `72-core-delivery-handoff`; implementation starts from freshly
verified main in named SSD worktrees. Preserve existing previews and owner data.

## 2026-09-23 direct Android Atlas — #72 / PR130 continuation

Continue the SSD worktree `72-android-living-universe`, branch
`codex/72-android-living-universe`. PR130's `81431cc` implementation was preserved;
this continuation adds direct ship/planet/continent/topic/content navigation,
collision-free square touch targets, readable compact labels, secondary source
inspection, and exact content/origin restoration in an explicit authored Atlas.
The owner now authorizes merging PR130; older no-merge text below is historical.
Check PR130 for final-head CI and merge status. **#72/full-v1 remains open.**

All six current reference images and four original spatial images were inspected;
Cosmos/Living Atlas source read, denied browser replay not bypassed. Poster Scroll,
Cable mode banks, actual Media3 playback and existing privacy contracts are preserved.
See [design decisions](design/2026-09-23-android-direct-atlas.md) and
[verification, motion and captures](journeys/evidence/android-direct-2026-09-23/README.md).

Local checks: TypeScript typecheck; Android debug/test assemble, lint and **94 units**;
**22 scenario/configuration runs**, including direct/compact/reduced-motion input,
continuous two-pointer pinch, globe-rim tap, branch/read return, recreation, supplied
Reel playback/background/epoch purge, source-world privacy, reader retry/revocation,
Cable exposures, dense worlds and sky-clock lifecycle. One Robolectric Saved Traces
idling timeout was retained; isolated tests and the complete rerun passed unchanged.
This was not a native app ANR. No provider or owner-database changes.

Matched untouched `81431cc` baseline: p50 **26.30 ms**, p95 **47.40 ms**. After runs:
p50 **29.76 / 30.94 ms**, p95 **52.29 / 66.56 ms** on the same API36 host-GPU,
4096MiB/4-core emulator. **Frame timing regresses; smoothness is not accepted.**
No ANR observed during this run does not explain or resolve every prior ANR cause.

The existing API4322/worker and disposable
`knowscroll_test_native_76cf2b52091ca64c` are preserved. Original `.journey` state was
saved before the test wave; restoration with the final APK and the additional owner-route check passed. Receipts are under
ignored `artifacts/android-direct` and summarized in the dated evidence. Recheck
runtime health before use. Owner DB `knowscroll` remains at nine migrations, read-only.

Owner route: **Universe → Authored Atlas → Orbit laboratory → Orbits → tap globe →
North coast → topic → Open**. Supplied demos uses the same route to actual test MP4s.
Mac emulator's documented pinch method is Command + primary-button drag; Android
two-pointer input is verified, but the available computer-use tool could not manually
drive that desktop modifier bridge. Native trackpad pinch is not assumed.

Next: owner visual/manual-input review and performance work; separately scope live
semantic/rich/branch transport and the remaining #72/full-v1 gates. No social,
mastery, provider-generation or semantic-emergence proof is claimed.

## 2026-09-22 Android living universe / Cable — #72 review branch

Started from verified merged PR129, `origin/main` at `91e5b72`, in SSD worktree
`/Volumes/Mrigesh SSD/knowscroll-worktrees/72-android-living-universe`, branch
`codex/72-android-living-universe`. Implementation is `9e38146`, with verification
and compact-layout/export/socket fixes `38bf753` / `cd00057` / `518c0c3`. No merge or #72 closure is
authorized. Original checkout and the pre-existing port 4320 preview are preserved.

Read the [implementation/visual audit](design/2026-09-22-android-living-universe.md)
and [current evidence](journeys/evidence/android-living-2026-09-22/README.md). The
owner's new durable priority is dark spatial Cosmos/Living Atlas + first four
images, poster/Kiosk Hybrid Set for content, and explicit rejection of image 5's
grey Worlds dialog. All five images and actual HTML source/styles were inspected;
local browser replay was denied and not bypassed.

Native work now includes orbiting moons with lifecycle/reduced-motion pause, stable
ID-derived map positions, pan/pinch camera travel into labelled authored continents
and local detail, integrated cream Worlds/Station selectors, an explicit filtered
Scroll/Reel Cable toggle, and an owner-accessible authored preview. The preview has
three supplied playable videos and three rich Scrolls with actual authored branches.
Camera, asset/revision origin, reading position, retry envelopes and privacy scope
are retained or purged as appropriate. Compact video layout reserves playback space.
No preview exposure/Keep/generation is posted; API/database counts verify that limit.

Final checks: typecheck, Android assemble/lint, 92 unit tests and 16 emulator
scenario/configuration runs passed, plus the visible owner preview setup.
All functional evidence uses `.journey` and disposable databases. The owner confirmed
**emulator only for now; physical phone later**. Read-only recheck of owner `knowscroll`
still finds only migrations 0001–0009; no owner migration/reset occurred. No raw video,
personal Reel capture, token or provider call is committed or represented as generation.
The new owner preview uses port 4322; its ignored lifecycle receipt is
`artifacts/android-living/preview/runtime.json` in the new worktree. Verify its health
and PIDs before reuse/cleanup, as with the older 4320 receipt in the original checkout.

The fresh matched debug profile baseline was p95 **67.81 ms**. Three spatial runs
measured **67.37, 67.45, 71.34 ms**, draw p95 **10.66–12.59 ms** versus 18.22, and PSS
**129,164–131,685 KiB** versus 131,278. Draw cost improved; total frame performance and
memory are not accepted improvements. Median worsened. Keep the historical previous
regression evidence, and profile on a physical device before smoothness acceptance.

Two implementation worker attempts stalled and their drafts were not integrated.
A bounded MiniMax-M3 source review completed; confirmed restoration findings and
runtime-discovered defects were fixed and tested centrally. Review/usage receipts
are in the evidence directory. Live branch/rich transport, semantic hierarchy,
source-scoped discovery, actual social presence, real Cutroom generation and full-v1
acceptance remain open. No Web or shared contract changes were made.


## 2026-09-22 owner-authorized merge and interactive preview

The owner explicitly requested restarting the emulator and merging the delivered code. This
supersedes the earlier no-merge instruction for PR #129 only; #72/full-v1 acceptance remains open.
Implementation revision is `b14fd38`. Merge completion is recorded on PR129 and #72; verify their
live Git state rather than treating the older draft snapshots below as current.

The visible API36 emulator now runs the latest separate `.journey` app against a fresh disposable
`knowscroll_test_native_*` database on API port 4320. The preview has two kept editorial encounters
admitted through real exposure/Keep routes, plus the explicitly labelled supplied TEST MEDIA Reel.
API/worker are intentionally left running for owner inspection. Ignored local lifecycle receipt:
`artifacts/android-spatial/preview/runtime.json` (process IDs/database); startup log:
`artifacts/android-spatial/preview-start.log`. Owner app/data/schema were not cleared or migrated.

Merge review rechecked migration0025 and Clear/Reset: deletion remains inside the authenticated
transaction, after exposure erasure, scoped to the caller; exact replay precedes deletion; shared
catalog and other universes are preserved. This was coordinator self-review, not an independent
privacy-lane sign-off. Both Android CI runs and the PR backend run passed at `b14fd38`; the other
backend run hit a random test-fixture origin collision in `publication-http.test.ts` and was rerun.
Check final-head CI before merging. The rendering regression and missing live integration contracts
remain as documented below; merging is not production performance or full-v1 acceptance.

## 2026-09-22 Android spatial delivery — #72 / draft PR #129

Owner sequencing decision: Android only (native canvas, Reel playback, branching seams, rich
Scrolls, motion and performance). Do not improve Web in this phase; full v1 still requires both
clients and journeys A–I. Continue the actual unmerged PR129 branch from `c9f699f`; no merge or
issue closure authorized. See [native audit/checklist](design/2026-09-22-android-spatial.md).

Live start: Git clean at the handoff revision, PR open/draft and historical CI green. PostgreSQL
was down and emulator absent; restarted dedicated SSD cluster and API36 emulator. Owner schema
read-only observation remains 0001–0009 with stale worker heartbeat; no owner migration/reset.
Runtime checks use disposable databases and `.journey` only. User authorized local Google-Drive
videos for playback tests. Physical phone availability remains unknown. Browser policy blocked
local reference replay; inspect reference source/captures without claiming observed motion.

Native implementation now includes a full available Atlas viewport with pan/pinch, cancellable
inspection travel and scope-bound camera return; real Media3 playback with first-frame exposure,
strict media URL/redirect handling and authority-aware paused state; and typed rich/branch seams.
Runtime work repaired sheet Back, return during in-flight exposure, two-marker pinch cancellation
and pause lost across authority refresh. Fixtures remain labelled tests and use actual authorized
MP4 bytes. Live region/relationship hierarchy, world-filtered discovery, branch/rich transport,
consumer generation status and saved-Reel revisit still need the contracts listed in the audit.

Receipts, captures, commands and diagnostic before/after frame/memory measurements are in
[Android spatial evidence](journeys/evidence/android-spatial-2026-09-22/README.md). All tests use
`.journey` and disposable databases; only an API36 emulator is available. Debug/emulator metrics
are not production-smoothness acceptance. Final checks: typecheck, assemble/lint, 86 units and
11 emulator scenarios passed. The matched profile regressed: p95 64.34 → 83.95 ms and PSS
113,660 → 126,570 KiB; investigate draw/queue costs on a physical profileable build. Review the draft and captures, then prioritize the
listed shared-contract dependencies and physical-device profiling. Do not merge/close #72 or
claim full v1 from this delivery. Web follow-up is recorded only; no Web edits were made.


## 2026-09-22 UI refinement successor — #72 / #4

Draft delivery: [PR #129](https://github.com/KnowScroll/knowscroll/pull/129), implementation head
`e6782b6` (plus this delivery-link update), not merged. Local verification passed: 714 backend,
76 Web units / 50 browser journeys, 82 Android units / 7 emulator scenarios.

Current local branch: `codex/72-ui-experience-audit`, started from clean `c9c3e72` on the
external SSD. The dated [audit](design/2026-09-21-ui-audit.md) supersedes earlier claims of visual
completion below. Both actual clients were inspected before changes. Shared local typography,
cartographic source-backed worlds, local world inspection, consistent navigation, real Web Keep,
responsive layouts and native reader hierarchy are implemented. Final evidence lives in
[journeys/evidence/ui-refinement-2026-09-21](journeys/evidence/ui-refinement-2026-09-21/README.md).

Native foreground/recreation retains System/Keep only after same-universe, same-epoch reconciliation.
The privacy journey reproduced the old stale-system-after-Clear defect; migration 0025 and both
Clear/Reset now erase that private projection transactionally. Shared source catalog and exact-retry
boundaries remain. Request privacy-lane review (#4) on the draft before merge. No owner migration,
owner data reset or provider run occurred. Test data/app are separate and disposable.

**Not full v1:** region/Star/galaxy evolution, relationships, world-scoped discovery, native
pause/export/Reset parity, production identity recovery, real Reels and journeys A–I remain open.
Do not render fictional growth to fill these gaps. Next action: review final captures and the draft
against the canonical references, then specify the remaining evidence-backed evolution contracts.
The older snapshot below is retained as historical evidence, not current branch/runtime truth.

Updated 2026-09-20 (Claude Code coordinator). Coordinator-owned current steering object, not a
transcript. Replace this snapshot when reality changes; preserve prior evidence and rationale through
Git, issues and [delivery history](operations/delivery-history.md).
**Live copy protocol:** during a wave the coordinator edits this file uncommitted in the main
checkout (so compaction reloads it); the committed copy lands with a wave PR. After a merge,
re-apply anything newer here before running `git checkout -- docs/CHECKPOINT.md`.

## Outcome and authority

Full v1 means all journeys A–I, polished mobile **and desktop**, real Cutroom generation through
import/publication/playback, reasoning, semantic/living/social experience and owner acceptance.
[Release contract](product/v1-release.md) and [#72](https://github.com/KnowScroll/knowscroll/issues/72)
remain authoritative and open. Owner Alpha is intermediate. Read [system navigation](operations/system-navigation.md).

## Verified source versus observed runtime

| Fact | Evidence and practical consequence |
|---|---|
| Main | **`bf9610c`** (PR #127, migration ordering); `a867aea` (#125 composer), `9f96645` (#124 privacy panel), `ef468aa` (#122 Android system level), `bd0cc3f` (#121 web system level) |
| Code migrations | `0001`–`0016`, **`0017`** (evidence-backed worlds) and **`0020`** (privacy lifecycle) on main; owner database still at 0009 |
| Owner database | `pnpm state` 2026-09-19T18:29Z: **0001–0009 only**; API false; heartbeat 2026-09-17. **No owner rollout of 0010–0016** |
| Identity | Single-user magic link (ADR-0026) + AgentMail delivery (ADR-0027) on main. **Proved with real mail 2026-09-20** (#109): sent, delivered to `knowscroll@agentmail.to`, read back over the API, link consumed, session issued `origin: magic_link`, replay refused 401. Owner database still unmigrated, so the owner cannot yet sign in to *their own* universe |
| Android | Sourced Scroll, sources, deliberate next, Keep, Trace revisit, bounded Clear, why-this sheet, device sign-out. Sheet state across recreation: #97. **Old scaffold visual language; UI slice not started** |
| Desktop | **The agreed Cosmos/Living Observatory interface is on main** (#110): head band, centred stage, truth pill adjacency, `↓` reads-then-advances, reduced motion, axe clean. Dev-only loopback auth still |
| Reasoning | SQL primitives only; Ask `recorded_only`; no paid dispatch, no mobile Ask (ADR-0016) |
| Cutroom upstream | `origin/main` `86d6e2c` (active author XZNON). Canonical clone `/Volumes/Mrigesh SSD/cutroom` at `52a62dd`, untouched |
| Cutroom runtime (ours) | Pinned detached worktree `/Volumes/Mrigesh SSD/cutroom-worktrees/runtime-86d6e2c8b742`. Use `/usr/local/bin/corepack` (nvm corepack is broken) |
| Real providers | Upstream model/image/video/voice/sensors are **stand-ins**; ffmpeg real. So no Reel can be genuinely eligible yet |

## The generated-Reel chain, and its honest blocker

Source now carries the whole chain: brief → budgeted job → Cutroom attempt (request bytes persisted
before POST, reconciled by original id) → verified import into content-addressed SSD storage →
seven publication gates at policy `publication-v1` → minted `asset` of kind Reel → authenticated
`GET|HEAD /v1/media/:sha256` with Range. Feed offers Reels only to clients sending `kinds=Scroll,Reel`,
so existing readers are unaffected.

**A generated Reel cannot become eligible in a real universe until** (a) upstream Cutroom ships real
providers, (b) a Visual Witness implementation with authorized model dispatch exists — `witness_alignment`
is required and structurally `unavailable` — and (c) gates run at policy. Stand-in media is fenced by
the database itself to disposable `knowscroll_test_*` databases. None of this is worked around.

## Delivered — #106 (PR #108 → `29c9914`)

AgentMail `MagicLinkSender`: one POST, bounded timeout, bounded response read, no retry, no redirect
following; `KS_MAIL_SENDER` selects the sink or AgentMail and production never falls back to the sink;
a send failure is one structured stderr line of `httpStatus`/`reason`/`messageId` and changes nothing
a caller can see. Independent review accepted the worker's commit; reproducing it, the coordinator
found the timeout covered only the header phase — a provider stalling mid-body would hang the
unauthenticated `POST /v1/auth/magic-link` forever — and fixed it with a red-then-green test. A second
independent review of that fix re-derived the defect and proved both new tests non-vacuous.
Lane verification 12/12 + 660/660, typecheck clean, CI green on four jobs.

## Reproduced baseline on main `431e93d` (2026-09-20, coordinator)

`pnpm test` **638/638 pass** (12 + 626), exit 0, 214s. `pnpm --filter web typecheck` clean and
`pnpm --filter web test` 5 files pass. Any lane merged from here must hold this line or explain why.

## After the SSD eject and reconnect (verified 2026-09-20, coordinator)

The drive was ejected and is back. Verified rather than assumed: repository intact at **`ff2202e`**,
only `docs/CHECKPOINT.md` modified (the live copy); three worktrees as expected. **Every runtime process
died** — the PostgreSQL cluster, the Cutroom stand-in engine (PIDs 6937/6939) and the owner preview are
all gone. Cluster restarted with `./scripts/db-start.sh` and listening on 55432. `pnpm state` re-read:
owner database still **0001–0009**, API false — unchanged by the eject. Android toolchain checked:
`adb` on PATH, AVD `KnowScroll_API36` present, no device attached.

**Not restarted yet:** the Cutroom stand-in engine, and the owner preview. Neither is needed for the
Android slice; restart on demand.

## Running processes on this Mac (not guaranteed across reboot or SSD eject)

- **Cutroom stand-in engine** from main since 2026-09-19T22:00Z: instance
  `$KS_DEV_ROOT/cutroom/instances/owner-local-standin`, **API PID 6937 on 127.0.0.1:4390**, **worker PID 6939**,
  providers `standin`, no stand-in script (a real request fails at the first model call — honest).
  `CUTROOM_BASE_URL=http://127.0.0.1:4390` is set in the owner `.env` (that line only). SIGTERM both PIDs to stop.
- **Owner-facing demo** started 2026-09-20 on throwaway database `knowscroll_demo_ui`: API on
  127.0.0.1:4310, web on **http://127.0.0.1:4392**. Owner data untouched. Kill by port when done.

## Owner decisions and unresolved gates

- **Decided:** Cutroom runs on this Mac; source, SQLite, media, caches, logs on SSD.
- **Decided:** completed/failed private prompts retire after seven days; Clear immediate.
- **Decided 2026-09-20:** KnowScroll does **not develop or modify Cutroom**; integrate only against the
  published [reel-contract](https://github.com/KnowScroll/Cutroom/blob/main/docs/features/reel-contract.md).
- **Decided 2026-09-20:** live test cap **$2 total**, only **after upstream ships real providers**; not
  authorized now, and enforced in migration 0013. H3 = fal [MiniMax H3 Max](https://fal.ai/minimax-h3-max),
  key in owner `.env`, used only by Cutroom's providers (value never read).
- **Decided 2026-09-20:** desktop surface = TypeScript web app (ADR-0022, #92).
- **Decided 2026-09-20:** sign-in is an **email magic link** and **v1 is single-user** (ADR-0026).
- **Decided 2026-09-20:** mail runs through **AgentMail**, inbox and sign-in address `knowscroll@agentmail.to`,
  key in `AGENTMAIL_API_KEY` (ADR-0027). No worker lane is given the key.
- **Decided 2026-09-20:** UI work proceeds **web first, then Android**, matching the agreed interface
  exactly, with no new steering from the owner.
- **Resolved 2026-09-20:** the owner replaced the AgentMail key; `GET /v0/inboxes` now returns
  `knowscroll@agentmail.to`. [#109](https://github.com/KnowScroll/knowscroll/issues/109) closed with the
  full loop proved on a disposable database. Two client-side gotchas recorded there: AgentMail message
  ids must be percent-encoded in a path, and the consume route is `POST /v1/auth/session` with the token
  in the body — not a POST to the GET-only confirmation URL.
- **Open:** owner rollout of migrations 0010–0016 — separate, evidence-backed, not attempted.
- **Open:** a #94 worker once echoed a lane `DATABASE_URL` (with the local PostgreSQL password) into its
  own terminal. Swept: present in no repo file, tracked content or artifact — only in three local worker
  transcripts beside the `.env` files that already hold it. Agent definition hardened (`161090f`).
  **Rotation offered to the owner; not done, no answer.**
- Historical [#57](https://github.com/KnowScroll/knowscroll/issues/57) stays open; cause unknown.

## Active lanes (2026-09-21 morning)

| Branch | Worktree | Slice | State |
|---|---|---|---|
None. All seven wave PRs are merged (#118, #120, #121, #122, #124, #125, #127).

All four wave lanes are **merged**: #118 Android Cosmos, #120 web Cosmos, #121 web system level,
#122 Android system level, #124 privacy panel, #125 composer coverage. Main is at `a867aea` plus
the privacy and composer merges.

**#126, found by restarting the demo from main and not by any test.** Privacy merged as `0020`;
the composer's migrations then merged *behind* it as `0018`/`0019`, so **every database already
carrying `0020` was permanently unable to migrate forward** -- `runMigrations` refuses, correctly,
because the applied set is no longer an ordered prefix. The owner database is unaffected (still at
`0009`, so it applies everything in order). CI could not see it: `scripts/test.sh` builds a fresh
database per run, so everything rebuilt from scratch stayed green while every long-lived database
broke. Same blind spot as #115, from a third direction.

Fixed by renumbering to `0022`/`0023`/`0024`, which is only safe while the sole databases carrying
`0018`/`0019` are disposable -- an argument for doing it immediately rather than later. Proved
against a real database: a genuine pre-composer ledger of 18 migrations ending at
`0020_privacy_lifecycle.sql` now migrates forward through all three. A committed
`packages/db/migrations/RELEASED.txt` plus a test in `tests/migrations.test.ts` makes the *class*
fail in CI instead of in a database; proved red with a fake `0018` inserted behind.

**The composer lane's remote branch was stale and the builder correctly refused to force-push over
it** (that was on its "never do" list). Resolved by pushing the rebased history under a new name,
`claude/113-composer-coverage`, rather than rewriting `claude/114-composer`.

**#113's guarantee is proved, not asserted.** Red: under the hash-only tie-break all six minor
sources went **unoffered across 15 consecutive decisions** -- deterministic, because the FNV-1a
hash separation was precomputed rather than left to chance. Green: every source offered by
**decision 3**, against an asserted bound of 6. The restructuring of `tests/worlds.test.ts` was
shown necessary too: restoring the original file reproduced #113's exact failure class, 6 of 12
failing with `seeded library must contain an orbits Scroll`. The ranking change is a **new policy
version** (`composer-signals-v2`, migration `0021`) with `v1` left immutable, per
`packages/core/AGENTS.md`'s rule that ranking changes never edit a code constant in place.

**Merge order mattered and cost a PR.** `claude/112-cosmos-ui` carried #111's *red* fidelity tests
without the restyle that turns them green, so its Android job failed (#117, closed). Android had to
land first; the web commits were then cherry-picked onto `89288d9` as #120.

Merged and removable: `claude/113-worlds`, `claude/115-privacy`, `claude/111-android-ui`,
`claude/112-web-cosmos`, `claude/116-system-view` (superseded by `-2`). `claude-handoff` (#88) and `revisit` remain from
earlier work.

## Delivered — #107 (PR #110 → `ff2202e`): why six rounds

The builder's restyle was structurally good and its evidence was real, but three defects were invisible
to every check it ran: screenshots assert nothing about behaviour and jsdom has no layout. Reproducing it
found five, including the page scrolling instead of the article, which silently emptied reading-position
persistence. Each subsequent review then rejected the **coordinator's own fixes**:

1. Round 1 (builder): stage jumped 170px on opening Sources; page scrolled, not the article; `↓` took
   reading away from the keyboard; the "intermittent flake" was that rebinding, not timing; `Kept` dimmed.
2. Round 2 (mine): the `≤700px` rail collapse was dead code (cascade order), leaving **Keep unreachable**
   at 700×560 and similar; the bounded reader clipped the why-sheet; the three-track grid was an
   undeclared invention that broke centring.
3. Round 3 (mine): the source sheet clipped the same way one element over, hiding **evidence access**
   (law 9); and the cascade bug was **recreated** while fixing it. Fixed structurally: every base rule
   now sits above the media queries that narrow it.
4. Round 4 (mine): reading position was silently inert below 700px — the JS watched an element that no
   longer scrolls. It had been masked by round 3's dead media query, which kept the article scrollable by
   accident. One bug was hiding another.
5. Round 5 (mine): rejected for a **false claim**, not a defect — the commit and evidence said dual
   listeners meant a resize across the breakpoint did not strand the reader; measured, it dropped them to
   the top and their next scroll overwrote the stored depth. Made true rather than softened: depth now
   migrates as a fraction of the scrollable range.

Lesson recorded rather than smoothed over: "the journey passes" predicted correctness poorly three times
running. Tests are now verified **red before green** — run against the pre-fix source to prove they fail —
because one earlier case (`1024×560`) turned out not to discriminate at all.

## Morning of 2026-09-21: what the owner can open, and what is still in flight

The owner asked for a morning demo on **app and web** covering identity and privacy, the complete
UI, discovery and reasoning, and living worlds -- a **tested vertical slice of each** -- and
specifically to see **two planets and one solar system**.

**Merged overnight (CI green):** PR #112 -> `974ba24` evidence-backed semantic worlds (migration
`0017`, ADR-0028); PR #114 -> `3dcb492` privacy lifecycle pause/export/reset (migration `0020`,
ADR-0030). `claude/113-worlds` and `claude/115-privacy` are therefore behind main; their worktrees
can be removed.

**In flight this morning, in dependency order** (111 must land first: `claude/112-cosmos-ui`
carries #111's red fidelity tests but not the restyle that makes them green, which is exactly why
PR #117's Android job failed):

| PR | Branch | Slice | State |
|---|---|---|---|
| [#118](https://github.com/KnowScroll/knowscroll/pull/118) | `claude/111-android-cosmos` | Android Cosmos interface + a way to prove it | CI running |
| [#117](https://github.com/KnowScroll/knowscroll/pull/117) | `claude/112-cosmos-ui` | the web Cosmos/LO rebuild, spec sec.4b/5b/5c, demo populator | waiting on #118 |
| — | `claude/116-system-view` | the system level on web: two planets, one system | verified locally, PR after #117 |
| — | `claude/117-android-system` | the system level on Android ([#116](https://github.com/KnowScroll/knowscroll/issues/116)) | worker in flight |
| — | `claude/114-composer` | real ranking (#5) | **blocked on [#113](https://github.com/KnowScroll/knowscroll/issues/113)**, an owner policy call |

**The two planets and the system are real, and were read off a running API.** On demo database
`knowscroll_demo_morning`, `GET /v1/worlds` returns `derivationMethod: shared_source_v1` and one
system of two worlds: *NASA · Orbits and Kepler's Laws · DEMO DATA* (9 Scrolls, 9 seen -> FULLY
EXPLORED) and *NASA · Stars* (8 Scrolls, 3 seen -> MORE TO EXPLORE). Two source URLs -> two worlds
-> one system, derived from recorded exposures and recomputable from the event log. Nothing is
invented; the demo library is marked so a screenshot can never pass as runtime evidence.

**Owner-facing demo running now** (kill by port when done): API **127.0.0.1:4310** and web
**http://127.0.0.1:4392** from the `116-system-view` worktree against `knowscroll_demo_morning`.
The owner database is untouched. The previous demo processes had died with the SSD eject; these
are new.

**#120 merged a completely dead web surface, and every check was green. This is the single most
important finding of the wave.** `f8efeca` shipped `apps/web`'s `.strict()` universe schema without
`recordingPausedAt`, a field ADR-0030 had already added to `GET /v1/universe` when #114 merged. Every
universe load failed against a healthy 200 server. Running the web journey against `f8efeca` fails
**12 of 12** specs that touch the app, each at ~8.6s because the universe never loads. `bd0cc3f`
(#121) carries the fix, so main is repaired -- but only because that lane happened to contain it.

Nothing would have told us: CI's `backend` and `android` jobs both passed (neither runs the
journey, #115), and `apps/web`'s unit tests use a **hand-written** `universeOf()` fixture, so when
the server grows a field the fixture does not -- fixture and schema keep agreeing with each other
while both disagree with the server. The coordinator reproduced #120's typecheck and tests and
found them clean; they were clean *and the product was dead*.

Recorded on #115 with the failing output, plus the fix that would have prevented rather than
merely detected it: derive the client fixture from `packages/contracts` so it cannot drift.

**Merged main `bd0cc3f` is now journey-verified: 40/40 passed** against a real disposable
API/worker/PostgreSQL (`knowscroll_test_5d2c5f4e998690ee`, 2026-09-21T12:13Z). The broken window
between `f8efeca` and `bd0cc3f` is closed.

**Three fidelity defects the coordinator found by looking at the running build**, none of which
any assertion in this repository was watching for: the body canvas was laid out over the whole
screen so its bottom row ran under the "Enter Scroll" block; the map's scale label read
"SYSTEM VIEW" on Android while being an inert `Text` (a claim to a depth that surface could not
reach); and the system level was missing the dock that sec.5b calls the shared frame. All three
fixed, and `apps/web/e2e/91-universe-canvas-collisions.spec.ts` now measures the collision in a
real browser at both tested widths -- jsdom has no layout, and a screenshot asserts nothing.

**Identity is not demonstrable on web, and the reason is architectural rather than missing work.**
`apps/web` has no sign-in surface at all: by ADR-0022 the client *never holds a bearer token* --
`api/client.ts` says in its own header that it must never import, construct or reference one -- and
the Vite dev/preview proxy injects `Authorization` Node-side. A real web sign-in therefore needs a
session the browser can carry (a cookie, or an equivalent), which is a change to that security
boundary and belongs to #2, not to a morning. The magic-link loop itself is proved end to end
(#109, real mail, real inbox, replay refused 401) and Android has the signed-out screen and device
sign-out. Recorded as a gap with its cause, not worked around.

**What this wave does not deliver, and the owner is told:** social (#11), rooms and inhabitants
(#10 beyond geography), real Cutroom generation (blocked upstream on real providers and a Visual
Witness), the owner-database rollout of `0010`-`0020`, and journeys B-H.

## Next work

1. **Land what is in flight**: #122 (Android system level), #119 (web privacy panel), and the #113
   composer coverage guarantee once the owner has had a chance to overrule the recommendation.
2. **[#115](https://github.com/KnowScroll/knowscroll/issues/115): wire the web journey into CI, and
   derive `apps/web`'s test fixtures from `packages/contracts`.** Today proved why -- a merge passed
   every check while the web surface was completely dead. The fixture change prevents that class of
   defect rather than merely detecting it, and it is the cheaper of the two.
3. **[#123](https://github.com/KnowScroll/knowscroll/issues/123): the three timing-sensitive backend
   tests that flaked under CI load.** Not urgent in itself; urgent because a suite that cries wolf
   trains everyone to ignore a real red run.
4. **Identity on the web surface** is blocked on an architectural decision, not on work. ADR-0022
   keeps the browser from ever holding a bearer token, so a real sign-in needs a session the browser
   can carry. That belongs to #2 and needs the owner.
5. **The owner rollout of migrations `0010`-`0020`** on the owner's own database -- separate,
   evidence-backed, still not attempted.
6. Rooms and inhabitants (#10 beyond geography), social (#11), and real Cutroom generation, which
   stays blocked upstream on real providers and a Visual Witness.

## Progress reporting

[Project](https://github.com/orgs/KnowScroll/projects/1), issues #2–#12, [Owner Alpha](https://github.com/KnowScroll/knowscroll/milestone/2), #72.
Issue counts are bookkeeping, not a v1 percentage. Workers are Sonnet (`claude-sonnet-5`, forced);
the coordinator reproduces every claim before merge.

## The repository is now PUBLIC (2026-09-21, owner decision)

GitHub Actions stopped starting jobs mid-wave: *"The job was not started because recent account
payments have failed or your spending limit needs to be increased."* Public repositories get free,
unmetered standard runners, so the owner made `KnowScroll/knowscroll` **public** to restore CI,
intending to revert later. CI resumed immediately and is markedly faster (android 46s where it had
been 3m+), which incidentally supports #123's diagnosis that those flakes were runner contention.

Two things the owner was told and decided anyway, recorded so nobody re-litigates them:

- **Reverting to private does not undo exposure.** Forks, clones and caches survive it. If anything
  sensitive is in history, the remedy is rotation, not re-privatising.
- **Reverting also restores metered billing**, so the same block returns unless the payment or
  spending limit is fixed first.

A four-surface exposure audit was run at the moment of the switch — git history blobs including
deleted files, tracked files and workflow definitions, the committed evidence artifacts
(screenshots of a running app, axe dumps, receipts), and the GitHub surface itself (issues, PR
bodies, commit messages). A preliminary check before the switch found no real `.env` ever committed
(only `.env.example`) and no secret-shaped content across the last 400 commits.

**Still outstanding from before:** the local PostgreSQL password a #94 worker once echoed into a
transcript. Rotation was offered and never done. It is not in tracked content, and the database is
loopback-only, but it is the one known credential with a recorded exposure history.
