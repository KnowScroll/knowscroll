# Android living universe and Cable — #72

This successor starts from merged PR129, `origin/main` at
`91e5b72a088f1d949c8b58de2b0a0d021230a517`, in the isolated SSD worktree
`72-android-living-universe`, branch `codex/72-android-living-universe`.
Android only. No Web, provider, shared contract or owner database change. No merge
or #72 closure is authorized. Historical September 22 audits remain intact.

## Reference audit and native translation

All five supplied PNGs were opened visually, and the three named original HTML
files inspected for structure, typography, palette and camera/style code. Supported
browser local replay was denied by security policy; no alternate transport was
used. Reference motion was therefore not observed. Native motion evidence is separate.

| Reference | Initial gap | Native implementation |
| --- | --- | --- |
| Planet + moon | Static body, no orbit | Cached teal globe, outlined angular land, highlight, selected rim, depth-ordered orbiting moon |
| Continent zoom | Same sphere magnified | Continuous camera into a native ocean/land/cloud layer, region selection and additional local paths/islets |
| Solar system | Loose floating cards | Elliptical rings, luminous sun, identity-stable planet positions, station landmark, readable labels |
| Station sheet | Default dialog | Cream sheet, large headline, ink copy, explicit unavailable social capability |
| Rejected Worlds dialog | Grey panel and teal text links | Cream bottom sheet, outlined full-row targets, visible close and accessible offscreen list |
| Hybrid Set poster/Kiosk | Dark generic content panels | Cream Scroll/Reel/Keep, bundled Bricolage + DM Mono, bold headlines, ink outlines, cobalt selected Cable tab, yellow branch rail/player pause |

Content and spatial registers meet at the same Cable/Atlas/Keep navigation. The
spatial ground remains dark. Long source names wrap or ellipsize on the map and
remain complete in the selector/detail. Sheets scroll; insets and minimum 48dp
controls remain native. Compact Reel footers receive a bounded fraction of the
available height so video cannot be squeezed to zero; actions precede the scrolled
caption. Preview has its own exit/origin controls, without a misleading live dock. Privacy and source/branch overlays use deliberate cream
surfaces. Actual native captures, not reference replay, are the comparison evidence.

## Semantic and coordinate ownership

There is no new semantic hierarchy contract. `GET /v1/worlds` still supplies real
source-grouped worlds and encounter counts under ADR-0028. Universe saved-Trace
markers retain event IDs and reopen the verified encounter; drawing them as spheres
does not make them semantic planets or relationship evidence. System world markers
retain backend world IDs. Sun, rings, moons and station are illustrative, visibly
labelled; no mastery, inferred interest, foundational Star, friend or live room is
asserted. The station does not open a fabricated social experience.

`AtlasCamera` alone owns world-to-screen position and scale. A fixed FNV-1a address
maps each ID to an orbital location independently of set order/cardinality. Insert,
remove and singleton growth cannot move another body. Collisions at large counts
are possible; an accessible selector remains available rather than moving stable
addresses to relax overlaps. Geometry/canvas layers use the same camera; zoom spans
0.35–12, with continent detail at 2.8 and local detail at 6.5. Native pan/pinch and
visible zoom controls share that transform, and touch cancels a running flight.

The additional hierarchy is an explicitly labelled authored geography preview:
world-local region IDs `<worldId>:authored-v1:<suffix>`, immutable parent-local
positions, coast/inland/uncharted regions. It is not inferred from activity. Ocean,
coastlines and clouds replace the globe layer through a scale fade; local islets and
paths add detail. Back returns local → prior continent camera → selected planet →
exact pre-selection system camera. State holders preserve the scene while authority
is rechecked, without rendering private content during that check. Universe/epoch
change or sign-out purges the enclosing state holder.

One Choreographer clock updates only the draw phase at a bounded cadence. Moon
geometry, brushes, paths and text measurements are cached; bodies outside the view
are culled. The clock unregisters when hidden by sheets/geography, reduced motion,
or lifecycle below RESUMED. Camera flights snap under reduced motion. No whole
scene recomposition is driven by the continuous moon clock.

## Cable, exposure and gesture contract

Scroll/Reel are explicit selected tabs. Requests use the existing admitted
`GET /v1/feed?kinds=Scroll` or `kinds=Reel`, with no parallel recommendation engine.
An empty mode names the unavailable kind honestly. The client keeps one complete
retry/session envelope per kind, with reading/playback position and active mode.
Restoring a parked mode updates the active persistent pointer as well as the UI.

Switching cancels the outstanding feed GET, disconnects its HTTP connection, and
invalidates stale delivery. An in-flight exposure/Keep write finishes using the
same persisted envelope; the last requested mode is deferred until then. Rapid
reversal back to the current tab clears the pending switch. Scope checks apply to
both banks; Clear/sign-out purges them. Late position callbacks may update only a
matching parked session in the current confirmed scope. Scroll exposure still
requires resumed visible drawing; Reel exposure still requires the first real
video frame. No preview/prefetch is counted as an encounter.

Reel's vertical gesture discovers next (preview also supports previous); horizontal
input takes an authored branch when available. Visible previous/next and branch
controls provide equivalents. Scroll's document owns vertical input. Only a
visible deliberate end action discovers the next document. Its yellow branch rail
owns horizontal navigation, leaving slider and diagram drags local. Branch Back
restores the origin's position and interaction state. Images reserve a 2:1 frame
through loading/failure/ready, preventing asynchronous image load from clamping a
restored reading offset. Source/branch sheets pause
playback; Android Back, recreation and background return retain the appropriate state.

## Owner-accessible authored preview and live integration boundary

The separate DEBUG `.journey` app exposes **Authored preview →**
above Cable. Three authored rich Scrolls exercise prose, a locally rendered image,
NASA citation, slider, horizontally scrollable diagram and a long document. An
unsupported-code block explicitly rejects executable content; no sandbox is claimed.
Three actual authorized MP4s are served through the existing guarded media path.
Only `simulated` media matching the currently confirmed universe/epoch is admitted.
The saved Reel selection and branch origin use asset/revision keys, so feed reorder
cannot change the restored video. The graph binds exact returned asset/revision targets into explicit authored demo
comparison links. It does not relabel live feed neighbors as branches.

The preview never posts exposure, Keep, generation or model events. Its branch trail
is bounded to 24 entries; per-document/asset saveable state restores reading and
playback. It disappears during authority revalidation and is discarded on scope
change or failure. Network media failure offers retry; revoked authority closes it.
Raw personal media and Reel screenshots stay in ignored SSD artifacts.

Live rich-block and parent/revision→target branch transport remains absent. The
minimum next shared contract must authorize source/target revisions, provenance,
universe/privacy epoch, relationship label/type and eligibility before clients
render navigable live branches. Rich blocks need a versioned non-executable schema
and safe media/citation policy. This phase changes neither API nor domain contracts;
its native preview proves interaction, not generation, live semantic emergence or
full-v1 delivery. World-scoped discovery remains unavailable for the same reason.

## Verification, performance and review

See [current receipts and commands](../journeys/evidence/android-living-2026-09-22/README.md).
Tests use disposable databases and `com.knowscroll.mobile.journey` only. The owner
confirmed emulator-only testing for now, with a physical device later. Debug API36
frame metrics are diagnostic and do not establish production smoothness.

The earlier preview API/worker on4320 and its database are preserved. The new
owner-visible preview uses4322 and records its lifecycle in ignored
`artifacts/android-living/preview/runtime.json`. Runners install only the separate
journey package and run serially. No owner database `knowscroll` reset/migration,
provider call, raw-media commit or production deployment occurred.
