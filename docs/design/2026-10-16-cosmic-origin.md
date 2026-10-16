# Cosmic origin — the opening and the star sky

Date: 2026-10-16. Branch `claude/220-cosmic-origin`. Semantics: [ADR-0049](../decisions/0049-stars-are-topics-worlds-form-from-their-material.md)
(proposed). Derivation contract: [universe star view](../contracts/universe-star-view.md).

## What the owner asked for

KnowScroll helps a person discover themselves through the evolving way they understand the world.
The owner asked for a central, cinematic opening told as the formation of the physical universe —
emptiness, expansion, gathering clouds, first stars, one star's transformation, released material,
a disk where new worlds take shape — that ends inside the real, interactive Universe. The same
language must continue in everyday use: a star is a topic with personal relevance, a quiet star
holds possibilities that have not unfolded, a meaningful transformation releases material that
gathers into worlds (perspectives, questions, other ways of understanding), and the reader can
always see why their universe changed. No score for consumption, no pressure to keep reading, no
claim that viewing changed a belief.

## What existed before this branch

- The web Universe (`UniverseScreen`) drew **saved Traces as planets** on a seeded starfield, with a
  ship that flew to a planet and landed on an illustrated globe before a Scroll opened. A new
  reader saw three honest invitation bodies ("A first possibility", "A different angle", "A little
  surprise").
- The reader's places existed only on the cream **Atlas** list: ADR-0036 places (`planet`,
  `region`, `sighting`) formed by the Cartographer from anchored attention, ADR-0037 foundations
  ("a place that holds others up") and ADR-0045 Idea Rooms.
- The product definition's cosmic grammar called a foundational concept a **Star** and a domain a
  **Planet**; ADR-0037 kept "star" as a property, not an object. `attention-v1` has a `dormant`
  state for faded attention, and target design 07 would archive places after long absence.

So the owner's metaphor — topics as stars, worlds born from their material — inverts the current
words, and "dormant" already meant absence. ADR-0049 reconciles this explicitly: stars are topics
(top-level places), worlds are regions and rooms, sightings are possibilities, the foundation
property becomes a **luminous** star, and "quiet" is structural, never a consequence of time away.

## How it is made, and why

**Browser-native WebGL2, written as a pure function of time.** `timeline.ts` turns a time into
camera, light, matter, gas and captions; `OriginRenderer` draws that frame. Matter is generated
once from a fixed seed and moved on the GPU, so any frame is reproducible: the reduced-motion
stills, the preview scrubber and live playback are the same renderer. The same star, world and gas
shaders paint the live Universe (`SkyRenderer`), so the star the opening ends on and the stars a
reader taps are one visual object. No new runtime dependency.

**HyperFrames — evaluated, not adopted as runtime.** It is HeyGen's Apache-2.0 framework that
renders seekable HTML/canvas/WebGL compositions to MP4 through headless Chrome and FFmpeg. A test
render on this Mac worked (3 s, 640×360, frame-accurate). Live playback runs a composition in a
sandboxed iframe with its own runtime (a CDN script by default), so its scene cannot continue into
the React Universe without a cut; it is pre-1.0 and changes daily. Because the opening is already a
deterministic `frameAt(t)`, HyperFrames (or the repo's own Playwright + FFmpeg) can render a
trailer or a fallback MP4 later without changing the product. Evidence: the research notes in the
session scratchpad (not tracked).

**MiniMax "H3" — verified, not used.** The MiniMax Token Plan key in the owner's Keychain lists
only text models; MiniMax's own `video_generation` with H3 needs a pay-as-you-go key that is not
configured. H3 is reachable through fal (`fal-ai/minimax-h3-turbo`, `minimax/h3-max-turbo`, …;
768P/1080P, 5–15 s, text-to-video 16:9 or 9:16, no seed returned). Cutroom only wires
`fal-ai/minimax-h3-turbo` for narrated vertical Reels. No job was submitted. A generated plate
could only sit behind the scene as a background layer: it cannot hand its objects to the live
Universe, needs a separate crop for every aspect ratio and adds a media-failure path. If the owner
wants one, the honest route is a one-off, approved fal call (~$0.12–0.40 per 8 s plate at today's
list prices) kept outside the repo's provider rules, with the procedural scene as the fallback.

## The opening (≈ 28 s)

| Act | Time | What happens |
|---|---|---|
| Before form | 0–3.6 s | near darkness; one concentrated presence breathing at the centre |
| Expansion | 3.6–8.6 s | a restrained flash; hot matter streams past the viewer and cools into a filamentary web (seeded nodes and filaments, not a stock explosion) |
| The first stars | 8.6–13.6 s | the camera follows matter into five clouds; they compress and ignite one by one; the gathered matter is consumed |
| Transformation | 13.6–19.6 s | the central, sun-like star swells into a giant, pulses as energy builds, and sheds its envelope as a bipolar shell — teal inside, pink outside, the emission colours of real planetary nebulae, which are also the app's palette. A small hot remnant stays. Other stars do not explode. |
| New worlds | 19.6–25.2 s | part of the enriched material streams to a new cloud, which collapses into a rotating disk; gaps open and four worlds grow gradually inside them. A few motes carry KnowScroll's own marks — a Reel frame, a Scroll sheet, a question — while the copy appears: "Your world began before you knew it." / "Every idea can change its shape." |
| Your universe | 25.2–28.4 s | the camera pulls back; the scene settles onto the same far stars the Universe draws (`farStars.ts` reproduces `CosmosBackground`'s seeded field point for point) and onto the unformed cloud where the first discovery sits; the overlay dissolves into the live Universe |

Copy stays in the live DOM (captions, Skip, Sound, Next). The Universe is mounted beneath the
opening from the start (`inert` until the handoff), so its data loads while the story plays and
the last frame is measured against the real seed body (`[data-origin-target]`).

**Who sees it.** A first visit only: the browser has not finished or skipped it, is not restoring
into a Scroll, and has never observed a universe. Until the bootstrap and the sky say whether the
reader already has history (kept Traces or places), the opening holds a dark frame with no story and
no controls (at most 2.5 s); a returning reader then reaches the Universe within about 0.2 s, a new
one sees the story begin. If the Universe is unavailable the opening steps aside so the error and
retry are visible. A story started in a hidden tab waits until the tab is visible. A
"↺ Opening" control on the Universe replays it.

**Cinematic treatment** (2026-10-16, second pass at the owner's request). The story is framed in
2.39:1 cinema bars on wide screens (none in portrait), which open into the Universe as it ends; the
two lines are subtitles in the lower bar and sharpen as they appear. Lens and film: a five-level
bloom, restrained anamorphic streaks on the brightest light, light shafts from the swelling star,
a refractive shockwave at the expansion, slight chromatic aberration, a split-tone grade and
luma-aware grain. Depth of field: out-of-focus matter turns into bokeh discs and focus follows the
subject. The camera drifts as if held, with a short decaying shake at the expansion, and exposure
adapts after the flash. All of it is part of `frameAt(t)`, so stills and replays match.

**Sound.** Synthesised with Web Audio (`originSound.ts`), so there is nothing to download or fail:
a riser into a sub boom exactly at the expansion, a D minor pad opening with the light, five glass
bells as the first stars ignite, a heartbeat as the star swells, a whoosh and a choir-like F major
swell at the release, a warm progression with one plucked note for each world as it forms, and a
soft chord that fades with the bars. A generated stereo reverb, a compressor and per-voice panning;
it measures −18 LUFS with a −3.1 dBTP peak, and every hit is tested against the picture's own
timeline. Turning sound on mid-story joins the score where the picture is. Browsers require a
gesture before audio, so sound starts off; "Tap anywhere for sound" invites it in the first
seconds, and tapping the scene or the Sound control starts it. `apps/web/scripts/render-origin-score.mjs`
renders it offline for measurement.

**Controls and failure.** Skip (also Escape) ends it at once; focus rings appear only for keyboard
use, and only a keyboard reader's focus is moved into the Universe afterwards. Under
`prefers-reduced-motion: reduce` there is no frame loop: six still frames from the same
timeline, advanced by Next or every 3.4 s. Without WebGL2, or if the context is lost, a short CSS
version shows the same two lines over a gathering cloud and enters the Universe; nothing blocks
entry. The clock pauses while the tab is hidden. On exit the frame loop stops, every GPU object is
deleted, the context is released (`WEBGL_lose_context`), the canvas is removed and audio closes.

**Measured.** Headless Chromium (ANGLE/Metal) on the owner's Mac: 61 fps during the first-stars act
at 1440×900; the opening completed, the overlay was removed, the app shell left `inert` and the
"seen" flag was stored. Particle counts drop on small or 4-core devices (15k + 5.2k vs 30k + 9k) and
the device-pixel ratio is capped (1.5 / 1.75). Physical phones are not yet measured.

## The sky (everyday Universe)

- **Stars** are the reader's top-level places, laid out with the most developed at the centre. Each
  has one condition — quiet, taking shape, under tension, lights others — drawn by the shared
  shader (calm glow; visible surface cells; an asymmetric, warmer corona; a released teal-and-pink
  shell). Captions are words about real things ("1 world · 2 possibilities").
- **Worlds** orbit their star as small planets; **possibilities** are faint motes at its edge;
  **constellation lines** join stars related by sourced connections (dashed warm when one is a
  contradiction). **Kept lights** are the reader's saved Traces: small sparks that open the saved
  Scroll directly. A Trace is no longer drawn as a planet.
- **Before any star forms**, the centre holds the unformed cloud the opening ended on, labelled "A
  first possibility"; tapping it flies the ship and opens a Scroll. With kept Traces but no star
  yet, the subtitle says how stars form: "A star forms when a topic keeps mattering to you on
  different days."
- **Approaching a star** opens its system: the star large, worlds on their orbits, possibilities on
  a faint halo, and a cream sheet — condition, "Why it looks like this" (every reason is a recorded
  fact), worlds with their relation to the star and, for questions, the positions held side by
  side, possibilities, connections, the star's own chronicle, "Read from <star>" and the existing
  reader correction "Set this star aside".
- **Landing on a world** reuses the illustrated globe (drag to turn, tap to change the light) as the
  world's arrival scene, with its relation and "Read from <world>".
- **Reading from a star or world** uses the new place scope on `GET /v1/feed`: composition only
  within that place and its worlds, recorded on the decision (`decision.scope_place_id`, migration
  0045). The Scroll's head band says "From Gravity · read from your sky". An empty
  scope returns to the Universe with "Nothing more to read from Gravity right now." A star or world set
  aside meanwhile (a 404) ends the trip the same way. The scope excludes what this trip already
  opened, so with a small library a second "Read from Gravity" in one visit can honestly find
  nothing new.
- **A change plays once.** The newest recorded change this browser has not drawn yet animates on its
  star (ignition, a world condensing from a small cloud, a luminous shell) with its chronicle line
  under the title ("Just changed …"). Which changes were drawn is display memory inside the reader's
  own namespaced storage (purged by Clear, Reset and sign-out); a browser's first sight of a sky
  draws nothing, because it cannot know what is recent.
- The **Atlas** list keeps every detail in reading form, with the new words (Star, World,
  Possibility, Lights others).

## Real, preview, not built

| | Status |
|---|---|
| Opening, Skip, Sound, reduced-motion stills, CSS fallback, replay, returning-reader bypass | implemented in `apps/web` |
| Sky from `GET /v1/atlas`: stars, conditions, worlds, possibilities, kept lights, constellations, star system, world landing, change playback | implemented; reads existing state only |
| Reading from a star or world | implemented: `GET /v1/feed?place=`, migration 0045 |
| Luminous and tense stars in a real universe | supported by the derivation; not reachable with the current editorial library (see the preview stack notes) |
| Perspective worlds released by a transformation (ADR-0049 §6) | **proposed only**, shown in the isolated preview |
| Android | unchanged; still draws places as planets |

The **isolated preview** is `apps/web/origin-preview.html` (Vite dev only; the production build
input is `index.html`). It runs without the API on illustrative fixtures and says so on every
view: a scrubber over the opening, every star condition side by side, and the proposed
perspective-world release with what it would record and what it may never be triggered by.

## Local stacks for review

`pnpm exec tsx scripts/run-web-cosmos-preview.ts` starts a disposable PostgreSQL database, API,
worker and Vite on loopback (fresh by default; `--grow` reads a universe into shape through the
real HTTP API). Places need deliberate acts on two separate days, so `--grow` moves the first day's
reading back 24 hours inside that throwaway database, as the repository's own journeys do; with
`--same-day` no place forms. The seeded library can honestly reach two stars (Gravity, Tides), a
connection between them, two question worlds and two possibilities — no region, foundation or
argued room. Stopping the script drops its database.

## Coordination and risks

- **Migration order.** 0045 skips 0042–0044, which exist on the dev/stage branches (#199). Those
  must reach `main` before or together with this branch, or a database built from `main` cannot
  migrate forward later.
- **Owner-approved visuals changed.** Trace-as-planet bodies and the Trace → globe landing step
  (2026-10-01 refinement) are retired by ADR-0049; the globe now belongs to worlds.
- **Android parity.** The derivation contract is ready for Android; until it is adopted the two
  clients use different words for the same places.

## Questions for the owner

1. Does "quiet" read as rest rather than neglect? Would you rather it carry no label at all?
2. Should a question world (an Idea Room) be a planet, or a moon of the world it is on?
3. Is "lights others" the right everyday name for ADR-0037's foundation?
4. Perspective worlds (§6): is an objection on a kept encounter the right trigger, or should an
   explicit Ask be required as well?
5. Should the opening offer sound on by default after a first tap anywhere, or stay off until asked?
6. Do you want a rendered MP4 of the opening (HyperFrames or Playwright) for sharing, and an H3
   background plate tried as an experiment?
