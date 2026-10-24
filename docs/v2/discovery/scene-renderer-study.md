# Initial Universe renderer choice

Source/design evaluation for #238, 2026-10-20. This is an implementation choice, not a measured scene-performance result.

## Design and architecture evidence

The committed v2.1 U01/U02 boards use layered stars, orbits, angular terrain and fixed hit areas. U03 explicitly specifies the same silhouette and targets in low detail, with ordinary region lists. U04 needs exact camera return and a server-picked encounter, not an independently invented offer. U05 needs a real committed transition ID, Skip/reduced motion and no interruption of an encounter. U07 explicitly describes the drawing as feasible in layered SVG/Skia without requiring 3D; common visual cues establish family resemblance while persisted personal variation distinguishes people. U08/D02 require accessible lists and ordinary controls. These authored worlds are visual examples, never activity or inventory. See [screen audit](design-screens.md#u07--same-ml-three-people-v2) and [blueprint §13](../architecture/02d-greenfield-blueprint.md#13-scene-generation-algorithm).

The accepted scene-core package already supplies strict numeric descriptors, stable targets, pinned generator versions and deterministic full 64/low 16 geometry. Existing Scroll diagrams use react-native-svg in the Expo/RN Web application and have actual hosted Android gallery interaction evidence. That proves the dependency can build/run in this application; it does not measure a populated Universe or guarantee frame rate.

| Criterion | Layered react-native-svg initially | Optional 3D renderer |
|---|---|---|
| Match initial U01–U08 depth/terrain language | Layering, outlines, light/texture and camera framing can express the authored drawing | Can express depth too, with additional camera/material work |
| Current dependency/runtime evidence | Already declared and exercised by existing web/native Scroll fixtures | No accepted v2 scene/device evaluation or dependency exists |
| Accessible controls/fallback | Keep labels, lists, buttons and large targets in ordinary RN/Web UI; same canonical geometry in low detail | Still requires a separate ordinary accessible interface |
| Stable personal world identity | Render persisted IDs/family/seed/anchors/version; never infer meaning from pixels | Must obey exactly the same descriptor/identity boundaries |
| Populated-scene performance | Unmeasured; must inspect real bounded scenes on web/native | Also unmeasured; adding 3D does not establish performance |

## Decision and implementation boundaries

Use layered react-native-svg for the initial 2D Universe renderer, with no new renderer dependency. This is a bounded first implementation choice; retain renderer-independent scene-core and reconsider only from actual scene/device evidence. Do not create a separate web product or move ordinary UI into a canvas.

The server projector persists established semantic IDs/parents/origin transitions, meaning-selected visual family/template choices, opaque seeds and layout anchors. Family resemblance precedes bounded seed variation. Existing descriptors keep their generator/family/anchors across arrivals and app updates; sibling array order is never a layout authority. Current family/palette vocabulary is finite and must not be silently relabelled to imitate additional authored worlds. Materials/light/landmarks remain decoration, never evidence amount, mastery or a claim about the person's beliefs.

The client constructs paths only from validated numeric vertices; no raw model SVG, scripts or URLs. It owns camera pan/zoom and selection, with keyboard controls and fixed accessible hit targets. Full/low detail share the same outline anchors and targets; reduced motion removes decorative movement. Quiet affects activity presentation only, never existence, size, layout or meaning. Keep the last valid scoped scene during lag/offline; label unavailable/unsupported data honestly and never make placeholder planets.

A private scoped return locator restores camera/focus independently of the parked paused Reel/Scroll position/sound. Map visits do not qualify content evidence. Region encounter cards require an authorized Composer result and deliberate Open; no client-made offer. Once-only formation presentation requires its own durable per-account transition shown/skipped acknowledgement and epoch fencing; a descriptor origin or client memory alone does not meet the cross-device requirement. That acknowledgement is not implemented by the current scene library/read-contract prerequisite.

## Acceptance still required

Implement and review the persistent scene projector, its atomic required jobs/erasure, scoped read adapters, actual renderer/camera/accessible outline and exact encounter return. Compare at least two stable personal variations with the same semantic family, grayscale/shape identity, low-detail/reduced-motion target equality, keyboard/touch/Back and stale/reset purge. Exercise bounded populated real-service scenes in browser and hosted native; record actual frame/gesture behavior and any fallback. Signed-out/gallery fixtures, deterministic geometry tests and green CI remain separate from that evidence. Physical-device acceptance remains explicit.
