# Direct native Atlas — #72

This pass continues PR130 at `81431cc`, preserving the poster Scroll, Cable banks,
Media3 and privacy envelopes. The September23 owner message permits merging PR130;
older no-merge wording in prior handoffs is historical. #72 remains open.

Reference priority: all six PNGs in `artifacts/android-living/next-session` were
inspected. Images1–3 govern topic cards and spacious Universe/system composition;
image4 preserves rich poster Scrolls; images5–6 show rejected clutter and sheet-first
navigation. Original four spatial PNGs and the actual Cosmos/Living Atlas sources
were also inspected. Browser replay remains denied; source reading is not observed
reference motion. No Web changes or new live semantic contract.

## Navigation and evidence boundary

The live Universe shows its source-backed system as a compact orbital target.
Source worlds use the existing worlds response; tapping enters a planet with visible
ship travel. Info is secondary source/count inspection. The global Cable dock opens
the feed; a world no longer carries an unrelated Open discovery action.

The separate debug journey app exposes **Authored Atlas** from Universe. Its
versioned Orbit laboratory contains Orbits, Models and Supplied demos. Explicit
local planet/region/topic identifiers map to `preview-scroll-0..2@1`, or exact
simulated asset/revision keys returned under the current universe and epoch. These
are authored examples, not live topic inference or source-world relationships.
The existing rich Scroll/player and branch origins remain reusable. Authored preview
never posts exposure, Keep, generation or model events. The root saveable holder is
scoped to universe+epoch, hidden while revalidating, and purged on scope failure,
Clear or sign-out. Real media is private and stays in ignored artifacts.

System → planet → continents → region → topic card → Scroll/Reel is directly
operable by touch. Planet tap or selected-planet spread enters geography. Region tap
frames local topics. The context card names kind, title, authored/simulated truth
and sources. Back closes card, restores continent camera, restores planet camera,
then restores the prior system camera. Content return retains selected topic,
reading/playback and branch state in per-target saveable holders.

## Camera and composition decisions

A single world-space transform remains authoritative. First system entry has a short
camera approach, while returning to an existing system retains its saved camera. Explicit level state separates
planet close-up from the system. Pinch retains the world point under its gesture
focus. No nearest-planet auto-selection. Geography zoom can enter a region only
when the focus is within its local target radius; level-specific entry/exit thresholds
avoid oscillation. Zoom-out frames the parent; zoom-in with no owned target zooms
the current view, while the continent level offers an explicit region chooser.

Ship coordinates survive content/recreation with the camera. Selection moves it
along a short curved path while the camera approaches; input remains enabled.
Pan, Back and retarget cancel the active flight. Visible planets retain their hit
targets during travel, so direct retargeting does not require the secondary List. Reduced motion snaps state and
pauses the ambient sky clock. The orbital ship and globe crossfade together into
the surface map; Back restores the ship in orbital space. The flight and moon clock update draw/placement reads;
star positions, globe paths and text measurements are cached.

Universe and system use different compositions. System bodies are small and vary
slightly by ID; selected planet is isolated. Stable FNV addresses are independent of
insertion/order. Deterministic culling prevents overlapping 48dp body targets without
moving identities, with all worlds reachable in the secondary List. World targets
take priority over the optional station; an overlapping station is culled and remains
reachable through List. Culling also accounts for the square 48dp target bounds. Label AABBs
avoid other labels/bodies, shortened names yield to full inspection/list names.
Globe land and flat map use the same cached polygon definition at different scales.
Moons and station are illustrative and claim no learning, interests or social state.

## Runtime verification

Results and limitations belong in the [dated evidence](../journeys/evidence/android-direct-2026-09-23/README.md).
Baseline uses an untouched archive of `81431cc` on the same API36 host-GPU emulator,
4096MiB/4 cores, 1080×2400/font1/motion1. The first attempt crashed in the host JDK17
compiler thread before instrumentation; its log is preserved, not counted as a profile.
No owner `knowscroll` migration/reset: read-only startup found nine migration rows.
The existing preview database and API4322 are preserved throughout isolated checks.

For manual emulator multitouch: hold **Command** on macOS, then primary-button drag
the two mirrored touch points. Toolbar magnification is a different feature; native
trackpad pinch is not assumed to forward two Android pointers. Source:
[Android emulator gestures](https://developer.android.com/studio/run/emulator#common-actions).
