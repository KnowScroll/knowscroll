# Cross-platform Cosmos refinement — #72 / #4

Audit and implementation on 21–22 September 2026, branch `codex/72-ui-experience-audit`, baseline
`c9c3e72`. [Detailed findings, checklist and remaining gaps](../../../design/2026-09-21-ui-audit.md).
This records a tested refinement slice, not completion of v1 or visual equivalence to the references.

## Verified result

| Check | Result and evidence |
|---|---|
| Root typecheck and disposable PostgreSQL suite | Passed; **714 tests** (13 baseline + 701 additional), zero failures. [verification.json](verification.json) includes hashes of the privacy change and counterexample tests. |
| Web typecheck / units | Passed; **76 tests**. |
| Real browser/API/worker/PostgreSQL journey | **50 passed**, including original reader/privacy/accessibility regressions and world/Keep checks at 1440×900, 390×844, 700×560, 920×740, reduced motion and keyboard focus return. [Receipt](web-receipt.json). |
| Android assemble, lint, unit/Robolectric | Passed; **82 tests**, zero failures/errors/skips. Bounds tests scroll to 12 saved labels rather than counting off-screen semantics. |
| Android world navigation | Regular and 840×1680 / font 1.3 / motion off: world selection, Activity recreation, source action above dock, system Back, Keep. **2 scenarios passed**. [Receipt](android-world-receipt.json). |
| Android world privacy | Real Clear while world detail is backgrounded; resume purges detail and server returns `system:null`. **1 scenario passed**. [Receipt](android-world-world-privacy-receipt.json). |
| Android existing reader regressions | **4 scenarios passed**: navigation/source/rest/recreation, dropped-response retry, background privacy clear, revoked-session failure. [Receipt](android-reader-receipt.json). |

Run root commands after `. ./scripts/env.sh`. Repeat native evidence with
`python3 scripts/android-ui-refinement.py` and `python3 scripts/android-reader-journey.py`.
The web runner is `pnpm exec tsx scripts/run-web-reader-journey.ts`; it writes its established
web-reader/web-ui evidence locations. This run backed up/restored those historical tracked files
byte-for-byte and copied new evidence here. Full console logs remain in ignored `artifacts/ui-audit/`.
Each destructive runner uses its own disposable database and `com.knowscroll.mobile.journey`,
then drops its database and restores display settings. Owner application/history were not cleared.

## Visual and interaction review

Manual web interaction covered Atlas → System → world → back, Keep → original Trace, source sheet,
Escape, reader navigation and Privacy. Resizing, short windows, focus restoration, reduced motion,
empty/rest/error/authority states were additionally exercised by the real browser suite.
Manual final Android interaction covered Atlas → System → world, hardware Back, Keep → original
Trace, Sources → sheet Back, reading scroll and return. Compact/large-text, recreation and privacy
cases were tested on the emulator. Manual TalkBack traversal and frame-time profiling remain unproved.
External source launch/return is tested; loading third-party browser content is not claimed.

| View | Before / after evidence |
|---|---|
| Android clipped Atlas | [Before](before-android-loaded.png) → [Final manual capture](android-final-atlas.png) |
| Android System | [Before](before-android-system-before.png) → [System](android-regular-system-ui.png) → [World](android-final-world.png) |
| Android reader hierarchy | [Before](before-android-reader-before.png) → [Final](android-final-reader.png) |
| Android compact world/source | [Large-text action remains reachable](android-compact-reduced-world-source-ui.png) |
| Web desktop | [Atlas](atlas-1440x900.png), [World](world-1440x900.png) |
| Web phone | [Atlas](atlas-390x844.png), [World](world-390x844.png) |
| Web short / tablet | [700×560 world](world-700x560.png), [920×740 world](world-920x740.png) |

Final preview was restarted on current code/migration in disposable demo database
`knowscroll_demo_audit_3235e9a9`: web `http://127.0.0.1:4395`, API4325 and the separate journey app.
This is a local process observation, not a durable hosting guarantee. It uses marked demonstration
content with real exposure/Keep projections, not fabricated model responses. No provider ran.
The seeded demo runtime remains for visual review; automated verification databases were dropped.

## Limits and review boundary

The canonical reference sources and existing reference captures were inspected; browser policy
blocked direct local-file replay. Source-backed world detail is real; decorative geography is not
semantic region evidence. Related worlds, Star/galaxy emergence, changes-since-return explanations,
world-scoped discovery and continuous spatial scale travel are still absent. Native pause/export/full
Reset UI, production identity recovery, real Reel delivery and full journeys A–I remain open.

The final privacy test reproduced ADR-0028's existing stale-system-after-Clear defect. Migration 0025
changes its deletion guard; Clear/Reset now remove only the erased universe's derived system in the
same transaction. Tests preserve shared catalog/neighbor rows and new activity on exact Clear replay.
This migration changes no existing history itself. The draft PR requests #4 privacy-lane review
before merge; no owner schema rollout is claimed.

[Worker receipt](workers.json) distinguishes the completed MiniMax M3 source audit from the stopped
Android worker. Its partial patch was reviewed/corrected centrally; worker output alone is not proof.
