# Android spatial experience — #72

Successor to the 21 September audit; baseline `c9f699f`, PR129. Android-only sequencing does not
reduce v1. Shared navigation, authority, contracts and integration remain coordinator-owned.

## Baseline audit

Current app was run in the API36 emulator using the separate journey package. System/world/Back,
recreation, Keep, reader, Sources and reading interactions were exercised before implementation.
Regular and compact world scenarios passed. The first privacy scenario was invalidated by an
overlapping reader APK install (coordinator scheduling error); rerun serially, never count that
crash as a product defect or the prior receipt as current evidence. All four baseline reader scenarios passed serially.
Captures/logs: ignored `artifacts/android-spatial/baseline`.

| Priority / evidence | Observed → intended | Approach → acceptance |
|---|---|---|
| P1 reproduced / source | System is a vertical wrapping collection; no pan or pinch → continuous spatial map | Shared camera coordinates, centroid zoom, clamped bounds, visible zoom/recenter and accessible list; real gesture, selection, return and recreation tests |
| P1 source | No Reel parser/player; only Scroll feed → real video lifecycle | Existing eligible-Reel wire contract, Media3 single visible player, bounded memory buffering, no hidden exposures; authorized MP4 first-frame/error/retry/background/release checks |
| P1 source | No branch endpoint or asset relationship contract → visible continuation with preserved origin | Typed branch availability seam; demonstrate interactions only in explicit test context. Never label unrelated feed entries as branches |
| P1 source | One body string → typed rich native blocks and isolated embedded gestures | Paragraph/citation/image/interactive rendering seam; plain wire adapts without rewriting source; test-only rich document and arbitration tests |
| P2 reproduced | World entry is a crossfade to another layout → approach same body and return to original camera | Cancellation-aware native spring, restore viewport under same authority; reduced-motion/rapid reversal tests |
| P2 unmeasured | Frame delivery, memory and media reuse have no measurements → repeatable device evidence | Before/after gfxinfo, FrameMetrics and memory under labelled debug/emulator conditions; physical-device gate remains |
| P2 source risk | Main-thread SharedPreferences commit for reading/navigation → storage work may stall frames | Measure before changing retry persistence; never weaken persist-before-send |

## Design and architecture decisions

Living Atlas source: camera/world inverse transforms; zoom anchored to finger centroid; distinct
zoom rungs within one drawing; map-bounded pan; screen-sized labels and explicit recenter; cancel
travel on touch. Its authored first-week places/regions/bridges are examples, not personal evidence.
Cosmos source/captures: dark blue ground, cream floating controls, teal/coral worlds, sparse labels,
cartographic globe, persistent origin. Keep bundled Bricolage/Instrument fonts. Native motion is
interruptible and reduced-motion aware; no mandatory travel delay or continuous ambient loop.
Interactive local reference replay was blocked by browser security policy. Source timing (Atlas
300–800ms camera travel, 320ms card) is not observed motion equivalence.

Live semantic levels today: source-backed worlds within one encountered system. Regions,
relationships, foundational Stars, galaxy and universe hierarchy need evidence-backed domain
contracts; scale changes must not fabricate them. Layout is illustrative placement, never
personalized meaning. A branch needs parent asset/revision, authorized destination, relationship
provenance and privacy binding. No second Scroll recommender. Rich executable blocks remain
unsupported without a real sandbox. Generation status needs an authenticated consumer job-status
contract; never synthesize requested/ready states from a timer.

## Checklist

- [x] Spatial camera, selection, accessible alternatives and origin return.
- [x] Real Reel wire/parser/player with lifecycle and visible-frame exposure.
- [x] Visible branch seam and honest unavailable state; test-only joined continuation.
- [x] Typed Scroll blocks, representative interactions and deliberate discovery threshold.
- [x] Android build/lint/unit checks and serial real journey regressions (86 units; 11 scenarios).
- [x] Interaction/performance receipts, captures, limitations and review cleanup.
- [x] Issue/PR outcome and durable checkpoint (draft PR129; #72 remains open).

Web follow-up only: compare shared interaction vocabulary and origin behavior after Android
acceptance. No Web files are in this phase.

## Native implementation and authority

- `AtlasCamera` owns display coordinates and centroid-preserving zoom (0.35–3.2); presentation
  placement is a deterministic sorted-ID spiral, stable under response reordering, **not** a
  persisted semantic position. New IDs can change placement. `SpatialAtlas` culls bodies outside
  the viewport, keeps labels screen-sized, offers zoom/recenter and a fully scrollable named list.
  `AtlasGestures` observes the Initial pointer pass and consumes movement after touch slop so
  two fingers on separate clickable markers still move the camera. Normal Universe and System
  use a full available viewport; compact/large-text Universe permits the surrounding controls to
  scroll. Privacy actions remain reachable and retain their existing confirmation/retry behavior.
- Inspection keeps the same map mounted and springs its camera toward the selected body
  (damping 0.9, stiffness 340). Touch cancels travel; animator scale zero snaps it. Closing restores
  the pre-inspection camera. Camera/selection and one current Reel pause/position state are saved; private world responses are
  fetched again after foreground/return reconciliation. Saved UI state is keyed to universe and
  epoch. The single Reel cache survives the loading phase of a same-scope authority refresh and
  is removed on replacement, scope change, sign-out or failed reconciliation. Return during an exposure invalidates the stale UI callback without changing its
  persisted request identity. Globe geometry/brushes are cached instead of rebuilt per frame.
- Media3 1.9.3 decodes real MP4 bytes. There is one resumed, visible player, no speculative player
  and no disk cache; encoded buffering targets 8 MiB / 2–8 seconds. It releases on background,
  removal and overlays, retaining pause/position for local return. The API-relative SHA media
  route is validated; the HTTP data source sends the existing development device token only to
  that exact URL and refuses redirects. Source media remains behind API authority. First rendered
  video frame triggers the existing exposure envelope; loading, failure, off-screen candidates
  and fixture branches create no exposure. Release production identity remains a separate gate.
- `ScrollItem` retains its existing persisted name and retry fields while a typed content seam
  distinguishes document/video. `readingPosition` remains keyed by asset: pixels for Scroll,
  milliseconds for Reel. Old Scroll state reads unchanged. Saving a Reel uses the existing Keep
  admission, but saved-Reel revisit is **not implemented** by the Scroll-only Trace revisit
  contract; this remains a backend dependency, not a relabelled working player in Keep.
- Reel discovery swipes are owned by a Compose layer above the native video surface. Up means
  next discovery; horizontal opens the visible continuation affordance. The feed can genuinely
  exhaust: it must not loop unrelated content and call it a branch. Source/continuation sheets
  handle Back locally before origin navigation. Minimal actions use actual capabilities; no
  inert discuss/share/report controls were added.
- `ScrollDocument` is a native allowlist: exact legacy prose, headings, citations, bounded HTTPS
  images, comparison slider, horizontally scrollable diagram, and explicit unsupported content.
  Rich documents accept at most 128 blocks and diagrams 30 nodes; legacy body bytes are not
  silently truncated. Image reads are off-main, capped at 4 MiB with a 1600px decode bound, no
  redirects or credentials. Loading/failure is readable. No WebView, JS, game execution or editor
  sandbox is claimed. Native reading retains the existing deliberate next-discovery end control.
- Branch gestures belong to the visible rail, leaving vertical reading and embedded horizontal
  controls to their own owners. `EncounterBranch`/`BranchAvailability` are presentation seams,
  **not an authorization contract**. The controlled preview supplies 20 authored branches and
  saves each document viewport/interaction state separately. `SupplyStatus` defines consumer
  wording only; it is not wired to a fabricated generation timer.

### Dependencies that this Android phase does not invent

| Experience | Required shared capability | Current native behavior |
|---|---|---|
| Regions → related worlds → galaxy → universe hierarchy | Evidence-backed containment/relationship IDs, revisions and privacy scope | Continuous display zoom and source-backed System inspection; no fictional regions or inferred growth |
| World-scoped discovery | Authorized source/world candidate constraint carried into the existing composer | Explicit whole-library discovery with return to the selected world |
| Live horizontal continuations | Authorized parent/revision → target links, relationship provenance, privacy binding and origin stack | Visible unavailable explanation; real rail/Back interactions in an explicit test preview |
| Rich live Scrolls | Versioned validated block payload with source/media provenance, capability limits and scope | Exact existing body adapter; rich renderer tested with authored preview content |
| Requested/queued/generating/preview/ready/retry | Authenticated consumer projection of the existing job boundary, approved preview media | Typed status wording only; no provider success or instant-generation claim |
| Saved Reel playback | Versioned Reel Trace-revisit response preserving original lineage and current authority | Keep admission can succeed; current revisit endpoint supports Scroll only |
| Production smoothness | Physical phone, production/profileable build and repeated controlled traces | Debug emulator metrics and source review; no release-performance acceptance |

## Reproduced repairs and test-harness corrections

Runtime work found and repaired local Back escaping the Reel source sheet; return-to-world being
ignored while exposure posting was busy; and two clickable bodies cancelling a map pinch. Review
also replaced default purple map controls with Cosmos cream, isolated native player gestures,
preserved branch preview viewport state, retained Pause through authority refresh, corrected
branch/citation contrast on the cream surface and removed per-draw globe path allocation.

The initial concurrent baseline runner install invalidated one privacy run. Later joined tests
incorrectly assumed NASA would always be first and that a discovery would always follow the Reel;
the real composer can return the explicit fixture source first or exhaust the library. Tests now
use the actual admitted source and distinguish next-Scroll from honest exhaustion. These are test
assumption corrections, not fake ranking or feed changes. Screenshot capture waits for a committed
Android frame; failure diagnostics cannot replace the original assertion error.

## Delegation receipt

PIO/MiniMax-M3 source review completed (`20260922-200446-read-only-bounded-androi-9281`):
69,138 tokens, $0.009255. Its claims were checked against source/runtime. Two implementation runs
and their one permitted tighter retry each returned provider 429 errors and no usable patch:
`20260922-201050-implement-bounded-reusab-3b40` 20,162 / $0.001311;
`20260922-201050-implement-bounded-typed-ab21` 17,281 / $0.001124;
`20260922-201525-retry-prior-reelplayer-a-88f8` 22,431 / $0.001683;
`20260922-201525-retry-prior-rich-scroll-cdfd` 41,254 / $0.003331.
PIO's `done`/exit-0 status did not mean successful implementation. Coordinator implemented,
reviewed and integrated the changes; no parallel worker patch is being credited. The quota
snapshot still showed 89% five-hour / 96% weekly remaining despite the provider errors.

Official references used for the Media3 lifecycle and Compose gesture implementation:
[Media3 player setup](https://developer.android.com/media/media3/exoplayer/hello-world),
[Compose gesture dispatch](https://developer.android.com/develop/ui/compose/touch-input/pointer-input/understand-gestures).

## Acceptance outcome

Build/lint/typecheck, 86 units, 11 serial emulator scenarios and both profiling runs passed.
The matched diagnostic performance pair regressed (p95 64.34 → 83.95 ms; PSS 113,660 →
126,570 KiB). No production smoothness acceptance: next measure draw/queue costs on a physical
profileable build. Stable placement as the set of IDs grows also remains a native follow-up;
current origin restoration is verified for the same admitted set. See the dated evidence README
for the exact pair and the remaining live integration boundaries.
