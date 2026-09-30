# Web encounter player decision for #171

Status: implementation decision in progress, 2026-09-29. The measured prototype is evidence from emulated Chromium, not iPhone acceptance.

## What exists and what the browser needs

The current feed returns a finite set of selected Scrolls and, when requested with `kinds=Scroll,Reel`, eligible Reels. An exposure is a separate write after an encounter becomes visible. A Reel is an authenticated MP4 served through `/v1/media/:sha256` with Range handling. A Scroll has text and a saved Trace may be reopened. No API call should be made for a swipe preview that is cancelled.

The browser owns one active encounter at a time. The API and database own selection, exposure, Keep, privacy epochs and event lineage. A gesture can propose movement; the reader store requests another encounter only after it commits. Video playback begins muted after the Reel is settled and visibly dwelled; a play control remains when browser policy rejects it. Pausing and unloading the old video is mandatory on deactivation.

## Prototype comparison

The three prototypes used the same Reel, long Scroll, range controls, Canvas block and horizontal related view at 390 × 844 in Chromium touch emulation. Bundle totals are HTML, CSS and JS for separate React/Vite entries, gzip at the Node default level. They include React and exclude fonts and video. They are comparative, not production bundle measurements.

| Candidate | Role | License | Bundle, raw / gzip | Nested axes | iOS | Accessibility | Verdict |
|---|---|---|---:|---|---|---|---|
| Native CSS snap + `<video>` | Browser-owned scrolling and media | Web platform | 234,517 / 73,447 B | Vertical and horizontal movement passed in Chromium; boundary transfer needs code | Real iPhone untested | Native scroll and controls; explicit focus and labels still required | **Select native platform APIs**; the integrated finite-feed player uses one controlled pointer transition rather than a multi-item snap strip |
| Embla React 8.6.0 | JavaScript paging API | MIT | 253,859 / 80,639 B | Same prototype results; nested axis arbitration still ours | Real iPhone untested | Keyboard, buttons and announcements still ours | Reserve if native snap cannot meet settle behavior |
| Swiper React 14.3.0 | Full carousel | MIT | 318,368 / 97,716 B | Same prototype results; `nested` option exists | Real iPhone untested | Optional Keyboard and A11y modules | Reject for this slice: more code without a measured benefit |
| Motion for React 13.4.0 | Optional drag physics, not pager authority | MIT | Not prototyped | Direction locking exists; child ownership still ours | Real iPhone untested | Reduced motion hook exists; controls still ours | Do not add until a measured animation need exists |
| Media Chrome 4.19.2 | Optional video control shell | MIT | Not prototyped | Does not page encounters | Real iPhone untested | Media controls are composable custom elements | Keep native video and focused controls for this slice |

The scratch prototypes and measurements are under `/Volumes/Mrigesh SSD/knowscroll-dev/tmp/pager-prototypes-171/REPORT.md`; that directory is not product code. The deliberate swipe at the long Scroll's bottom remained in the Scroll for all three approaches. The integrated reader uses one mounted encounter and a small pointer controller around native Scroll scrolling and native video. That choice keeps the API's finite selection and exposure boundary explicit. A CSS snap strip would require adjacent selected items that the current one-at-a-time feed API does not provide. Browser back-edge behavior, physical phones, repeated media transitions, and frame timing still need device measurements. A labelled MP4 fixture did pass protected Range and playback checks in Chromium at 390 × 844; see `docs/journeys/evidence/web-171`.

## Gesture ownership

The selected pager is the only authority for encounter position. A pointer starts undecided, locks to one axis after a named threshold, and cannot switch axes mid-gesture. A horizontal child such as a slider, diagram or video seek control retains its pointer; a left-edge start yields to Safari navigation. A long Scroll keeps ordinary vertical movement. Only deliberate continued movement after reaching an edge may ask the pager to advance. Visible buttons and keyboard actions provide the same journey. The store records exposure after active settle and visible dwell, never during preview. These rules are the implementation and test targets; the initial prototypes did not yet prove the boundary transfer.

The live web reader presents explicit Connections after the origin has a recorded exposure. The opt-in branch list and open responses omit source identifiers; opening preserves one retry key and the origin reading position. A horizontal swipe left follows the first currently listed branch, while the visible list lets a reader choose any offered branch; a swipe right or the Return button follows the saved trail. A cancelled swipe has no branch write. The existing substrate currently offers **Scroll targets only**, so Reel-to-Reel and Scroll-to-Reel continuations remain outside this contract. Physical iPhone axis and back-edge behavior are not yet accepted.

## 2026-10-01 visual and navigation refinement

The Universe keeps its movable starfield. A planet tap now flies the shared SVG ship to a landing
view before opening a Scroll. The landing globe has visible angular land shapes, but that
cartography is an illustration of the destination: it does not name, infer or persist a new Atlas
place. A saved planet still opens the exact saved Trace, and its revisit remains read-only. Short
landscape windows use a compact layout so planets and the landing action remain reachable.
On that landing, the globe slowly turns and carries moving cloud bands. A reader can drag it to
turn faster, or tap the globe or its small moon to cycle daylight, evening and moonlit lighting.
The Scroll action remains separate. These are camera and lighting interactions in the illustrated
arrival scene; they make no world/Atlas write, do not create a semantic moon, and do not claim a
new insight or world delta. Actual world evolution remains governed by the typed, lineage-bearing
Cartographer changes rather than an animation timer.

The Scroll and Reel header now has one explicit switch. It selects the corresponding admitted feed
kind; a Reel is a separate encounter, not a video rendering of the same Scroll. While a reader
visits a Reel, the current Scroll is parked in memory and restored with its reading position and
exposure identity on return. After a page reload the Reel session can be restored, but that
in-memory parked Scroll is gone, so switching back requests a Scroll from the feed. Explicit
switching may supersede an in-flight exposure; the same client exposure key is retained for a
parked Scroll if it is shown again. The visual system uses the Hybrid Set cream, ink, cobalt,
yellow and teal register on the reading surface while keeping the existing dark spatial canvas.

On narrow screens the Scroll stage owns vertical scrolling and the article lets content flow.
Canvas blocks measure their rendered width and redraw on resize; code samples scroll inside their
own frame. The inline swipe cue and end-of-Scroll actions replace the floating action strip that
had obscured reading text. Gesture navigation and keyboard controls remain available.

## Checked web Scrolls

Migration `0041` adds a nullable `asset.web_artifact`. When a checked model-written Scroll is admitted, the writer stores a version 1 declarative artifact in the same transaction as the Scroll and its fallback body. The artifact binds to the asset ID, revision and a hash of that body. It records checked-model provenance without revealing the internal source. The API validates the schema, byte limit, identity, body binding, integrity and diagram endpoints before returning the opt-in web response. An invalid or absent artifact becomes `null` and the existing body remains readable. Android and legacy feed callers keep their existing response shape.

The trusted React renderer supports semantic text, disclosure, comparison, timeline, SVG diagram and a small Canvas plot with a table fallback. Today the live model writer emits **text blocks only** from checked beats. The richer block examples are authored test stand-ins. No provider generates arbitrary HTML, CSS or JavaScript in this path. Version 1 rejects HTML/script/module blocks, so there is no Level B execution path or iframe sandbox to claim as implemented. A future interactive-code producer needs a separate contract and sandbox review before it can be admitted. The browser opts into source-free feed, saved Trace, Atlas and branch projections; older platform contracts remain compatible. Other existing API surfaces still need a source-visibility audit before public identity is enabled.

## A narrow web variant

Web places the truth/context panel alongside the Scroll on wide screens and behind a compact control on phones. This is a deterministic design choice, not an A/B assignment or a claim about reader behavior. No engagement metric or hidden experiment system is involved.

For a small developer comparison, a Vite development build accepts `?webVariant=context-after` on a phone viewport. It moves the Context and Why controls below the article; the default keeps them before it. The switch is local, deterministic and excluded from production builds. It assigns no readers and records no metric. It should only be used for observed comprehension and usability review, not as evidence of a live A/B test.

## Sources used for the comparison

- [CSS scroll snap, MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/scroll-snap-type)
- [Embla docs](https://www.embla-carousel.com/docs/) and [repository](https://github.com/davidjerleke/embla-carousel)
- [Swiper React](https://swiperjs.com/react) and [API](https://swiperjs.com/swiper-api)
- [Motion drag](https://motion.dev/docs/react-drag) and [reduced motion](https://motion.dev/docs/react-use-reduced-motion)
- [Media Chrome controls](https://www.media-chrome.org/docs/en/position-controls)
