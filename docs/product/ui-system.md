# The agreed interface, written down

> September23 refinement: direct native exploration and compact topic cards take
> precedence over the old sheet-first flow. See [direct Atlas](../design/2026-09-23-android-direct-atlas.md).

> **Android reference precedence — 2026-09-22:** Spatial screens follow the first four
> owner images and Living Atlas/Cosmos; content follows Hybrid Set poster/Kiosk.
> The fifth image's generic grey Worlds dialog is rejected. See
> [design direction](design-direction.md#which-reference-wins-owner-direction-2026-09-22)
> and the [native audit](../design/2026-09-22-android-living-universe.md).
> The older single-register specifications below remain provenance, not an override.


Status: extraction, not invention. Every value below is taken from the two references the owner
already chose in [design direction](design-direction.md): [Cosmos](references/cosmos.html) for the
visual language and [Living Observatory](references/living-observatory.html) for journey behaviour
and layout. Where the two differ, **Cosmos wins on look, Living Observatory wins on structure and
behaviour**, exactly as the design direction states. Nothing here is a new idea; if a value is not in
a reference or the [definition](definition.md), it is not in this document.

Interaction contracts for each surface come from definition §9.5; the product laws it must not break
are §3 (laws 4, 9, 11, 13, 14) and §12's truth states.

## 1. Colour (Cosmos, verbatim)

| Token | Value | Use |
|---|---|---|
| `--space` | `#03101a` | the ground everything sits on |
| `--space-2` | `#061a27` | raised ground, panels behind content |
| `--deep` | `#0b2b33` | card and stage fill |
| `--sea` / `--sea-2` | `#17505f` / `#0f3644` | rails, borders, quiet fills |
| `--ink` | `#15302a` | text on cream surfaces, solid button fill |
| `--cream` | `#fffdf2` | primary text on space; sheet and card surface |
| `--orange` | `#ff684c` | refusal, correction, "not so fast" |
| `--yellow` | `#ffd058` | Keep |
| `--teal` / `--teal-2` | `#33c4b4` / `#8fe9e4` | continue, origin, links |
| `--green` | `#64d47d` | verified / checked-out states |
| `--pink` | `#ed87b4` | reserved; unused until a surface needs it |

Living Observatory's `--muted` role maps to `--cream` at 70% for secondary text on space, and its
`--line` role maps to `--sea`. Do not import its `--bg`/`--accent` palette: Cosmos is the chosen look.

## 2. Type (Cosmos, verbatim)

- Headings: **Bricolage Grotesque**, 700–800, `letter-spacing:-.01em` to `-.02em`, `text-wrap:balance`.
- Body: **Instrument Sans**, 15px, `line-height:1.5`.
- Micro-labels: `ui-monospace, Menlo, monospace`, 10px, `letter-spacing:.08em`, uppercase, 700.
  These carry truth state, origin kind and section kickers — never body copy.
- Until font licensing and bundling exist, both families fall back to the system sans stack, as the
  design direction already records. **No network font fetch**; the app opens without one.
- Reading sizes come from Living Observatory's reader: `h2` 40px / 1.08 / `-1.6px`, body 15px / 1.8,
  measure capped at 590px. Reel title 38px / 1.03 / `-1.8px`.

## 3. Shape, depth, motion (Cosmos)

- Pills for every control: `border-radius:999px`, height 40px, padding 0 16px, weight 800, 13px.
  Variants: solid ink (default), `teal`, `yellow`, `orange` — each keeping Cosmos's foreground pairs.
- Cards and sheets: radius 22px, cream surface, `box-shadow:0 18px 40px rgba(0,0,0,.45)`.
- Truth and state pills: monospace 10px, `border-radius:999px`, 3px 8px, tinted per §12 state.
- Sheet motion: `transform .34s cubic-bezier(.2,.8,.2,1)`; toasts `.25s`; hints fade `.6s`.
- Focus is always visible: `outline:3px solid var(--teal); outline-offset:5px` (Living Observatory's
  rule, recoloured to Cosmos).
- **Everything above is suspended under `prefers-reduced-motion: reduce`**: no transform animation,
  no canvas drift; state changes still happen, instantly.

## 4. Desktop layout (definition §9.5, structured as Living Observatory)

- **Centred stage with origin context around it.** Reading uses a two-column grid — a 230px context
  rail and a 300–700px reading column, `gap:60px`, centred — never a full-width column of text.
- **A head band above the stage**: back, the origin ("where this came from"), and a monospace kind
  label. 66px tall, one hairline rule below.
- **A source rail and an actions rail** flank the stage where the surface has them; at ≤1050px the
  rails narrow, at ≤700px they collapse and the stage takes the width.
- **No permanent dashboard chrome.** No persistent sidebar, no toolbar that outlives the surface.
- Pointer and keyboard are equal: `↓` next discovery, `→` deeper when a continuation exists, `Esc`
  or back returns, and every control is reachable and visibly focused. `→` stays **unbound** while no
  continuation contract exists — an empty gesture is worse than none.
- **`↓` reads on before it advances.** §9.5 names `↓` as next discovery, and Living Observatory's reader
  scrolls a column of text; bound naively, `↓` takes both away at once — a keyboard reader can no longer
  scroll, and a press mid-paragraph loses their place *and* spends a deliberate discovery. So while text
  remains below the fold `↓` scrolls, and only at the end of the Scroll does it become next discovery.
  `↑` scrolls back. Both are suspended from smooth motion under `prefers-reduced-motion`. This is a
  refinement recorded here, not a new gesture: the two references disagreed and this is how they are
  reconciled.

## 4b. Phone layout (definition §9.5 Mobile, structured as the references' own mobile modes)

Section 4 is titled *Desktop layout* and means it. Nothing in this document extracted a phone
treatment until now, so "match the agreed UI exactly" could not be obeyed literally on Android. This
section closes that gap with the same discipline as the rest of the file: every value comes from
definition §9.5 Mobile, or from the references' own mobile CSS, or it is named as a platform rule.

**§9.5 Mobile states the surface in six lines**, and they govern: one-thumb Cable entry; vertical
full-height Reel stages; full-width Scroll reading with protected embedded controls; a drag-and-pinch
universe canvas; a bottom compass with Home, Cable, Scroll, Ask and Friends; sheets only for sources,
controls and compact branches. "Mobile is not a compressed desktop universe."

- **Full-width reading, one column.** No context rail, no two-column grid, no 66px head band, no
  1050/700px breakpoints — those are desktop resize thresholds, not phone design values. The head
  band's *job* survives even though its shape does not: back, where this came from, and the kind label
  must still be present and still orient the reader (law 14), as a single leading row above the
  reading surface rather than a fixed bar.
- **The reading surface is a cream sheet on the space ground**, as the reader already is. Radius 22dp
  on the corners that show. Body 15sp at 1.8; the 590px measure cap is a desktop constraint and does
  not apply to a phone column, which is already narrower than that.
- **Bottom compass**, taken from Living Observatory's own `.dock`: floating rather than docked to the
  edge, centred, 25px from the bottom, 18px radius, 6px padding, 5px between entries, each entry
  13px/18px padding at 12px type, with the current entry marked (`aria-current` in the reference, a
  selected state here). It honours the safe-area inset. §4's "no permanent dashboard chrome" is a
  desktop rule about sidebars and toolbars; the compass is the phone's primary navigation and §9.5
  names it explicitly.
- **The compass shows only what exists.** §9.5 lists Home, Cable, Scroll, Ask and Friends. Ask,
  Friends and Cable have no contract and no data, and §6's rule is absolute: *not available, therefore
  not drawn*. So the compass ships with **Home and Scroll**, and grows an entry when a contract does.
  A compass of dead icons would be the map problem again, in a worse place.
- **Touch targets are at least 48dp**, which is the Android platform minimum and overrides any
  smaller value inherited from a CSS reference. Cosmos's pill stays a pill — 999dp radius, weight 800,
  13sp — but its *height* is whatever satisfies 48dp, not 40px.
- **Sheets only for sources, controls and compact branches** (§9.5). Cream, 22dp radius, one at a
  time — opening one closes the other, as the desktop reader settled.
- **Gesture is primary, and no gesture is invented.** The desktop keyboard contract (`↓` reads on then
  advances, `→` unbound, `Esc` returns) has no phone equivalent to copy; the deliberate Next control
  stays an explicit, visible control. A swipe that advances a discovery would spend one by accident,
  which §3's deliberate-next law forbids.
- **Reduced motion.** Android's `Settings.Global.ANIMATOR_DURATION_SCALE` of 0 is the platform's
  version of `prefers-reduced-motion: reduce` and must suspend the same things: sheet motion, any
  canvas drift, every transition. State still changes, instantly.

**What is deliberately left open:** vertical full-height Reel stages and the drag-and-pinch universe
canvas are both §9.5 requirements with no data behind them yet — there is no eligible Reel, and the
universe has no semantic geography. They are not drawn, and this section will be extended when those
contracts exist.

## 5. Truth states are visual language, not a footnote (§12)

Each state has one pill, always adjacent to the claim it qualifies, never buried at the end:
`documented`, `synthesis`, `interpretation`, `disputed`, `modelled`, `counterfactual`, `fictional`.
A generated encounter additionally carries its generated label, and stand-in media carries a
**simulated** marker. A compelling presentation may never upgrade a weak claim, so the pill is drawn
with equal weight regardless of state.

## 5b. The product surfaces, as Cosmos actually draws them

**This section exists because the earlier draft of this document was a reduction.** It extracted
colours, type sizes and pill geometry, added a rule of its own ("not available, therefore not drawn"),
and left out everything that makes the reference a product: the navigable universe, the dock, the
labelled bodies, the chips and hints and back controls. The web surface was then built to that
reduction and reviewed six times for correctness while nobody asked the only question that mattered —
*does it read as the same product?* It did not. Fidelity from here means: **stand a screen beside the
reference and it is recognisably the same thing.**

Cosmos, driven from day 1 to day 30, shows five levels. Read it yourself before building:
`docs/product/references/cosmos.html`, the stage chips (`day 1 · one planet` → `day 30 · a system`)
and the flow chips (`universe`, `system`, `planet`, `interior`, `reel`).

### The frame every level shares

| Element | Cosmos's own values |
|---|---|
| **Dock** (`.nav`) | pinned `left/right:14px; bottom:16px`, height 62, `border-radius:22px`, `background:rgba(6,26,39,.78)`, `border:1px solid rgba(255,255,255,.12)`, `backdrop-filter:blur(12px)`, `box-shadow:0 10px 30px rgba(0,0,0,.4)`, `gap:4px`, `padding:6px` |
| **Dock entry** (`.nav button`) | `flex:1`, icon over label, 20×20 icon, Bricolage 700 at 10.5px, `border-radius:16px`, `opacity:.7`; the current one `background:rgba(255,255,255,.14); opacity:1` |
| **Context chip** (`.chip`, top-left) | cream `rgba(255,253,242,.94)` on ink, `radius:999px`, `padding:7px 12px 7px 9px`, weight 800, 12.5px, `box-shadow:0 8px 22px rgba(0,0,0,.35)` |
| **Status pill** (`.pillbtn`, top-right — "Lately") | same recipe, `top:34px; right:14px`, with a state dot |
| **Breadcrumb** (`.crumb`) | cream pill, `padding:7px 8px 7px 14px`, `max-width:250px`, truncating |
| **Back** (`.back`) | cream pill, `left:12px; bottom:96px`, height 38, `padding:0 14px 0 10px` — reads "‹ universe", "‹ orbit" |
| **Hint line** (`.hint`) | centred above the dock at `bottom:100px`, Instrument Sans 12.5px, `opacity:.75`, text-shadow — "Tap a planet · the ship flies there" |
| **Action pill** (`.btn`) | height 40, `padding:0 16px`, `radius:999px`, weight 800, 13px, Bricolage |

**The screen is a canvas with floating controls over it**, not a document with a header. Nothing is a
bar across the top; every control is a shadowed cream pill or the translucent dock.

### The levels

1. **Universe** — star ground, one or more bodies with a name and a mono sub-label ("Technology",
   `3 STOPS`), a dim nebula for what has not been explored (labelled `?????` or "LATER · A FRIEND"),
   the `DAY n ▸` pill, the hint, the dock.
2. **System** (day 30) — title and subtitle read "Technology" / "a system · 3 planets · a station";
   a glowing sun, elliptical orbit rings, textured planets each with a name and some with a mono
   status above them (`READY TO IGNITE`), a station, a tiny ship, a nebula; a `⊕ RECENTER` pill and a
   `‹ universe` back pill.
3. **Interior** — an illustrated map: coloured landmasses with uppercase names and mono sub-lists
   (`MODELS · DATA · ALIGNMENT`), dashed routes between them, cloud cover, a compass rose, an
   `UNCHARTED` chip, a `+ / 100% / −` zoom stack, `‹ orbit` back.
4. **Reel / reader** — an origin chip ("● in Machine learning ›"), a large rounded stage, a caption
   overlaid on it with a word highlighted in yellow, a mono position line (`SHOT 3 OF 6 · FOUNDATION
   MODELS`) and a thin progress bar; **below the stage**: a green state pill (`CHECKED OUT · 3
   SOURCES`), the title, a one-line summary, and a row of three coloured pills — **"Not so fast"
   (coral), "Keep this" (yellow), "keep going →" (teal)**.
5. **Planet** — between system and interior; same frame.

### What we can honestly put in it today

Drawing the interface is not the same as fabricating data. The rule against inventing stays exactly
as strict; it governs the *content*, not whether the surface exists.

| Cosmos element | What it carries for us now |
|---|---|
| Bodies in the universe | **Real kept Traces and encountered Scrolls** — one body each, its real title as the label. Never an invented topic. |
| The unexplored nebula | **The real unread remainder** of the finite library, counted, not decorated |
| `DAY n ▸` | the real age of the universe |
| Status pill | a real recency or state, or omitted |
| State pill on the reader | the real truth state — `DOCUMENTED` (owner decision 2026-09-24: readers never see a source, so no source count; sources stay internal for checking) |
| Stage | a Scroll is text, so the stage is typographic rather than video; a Reel uses the video stage once one is eligible |
| "Not so fast" | **no contract exists** — not drawn until one does |
| Dock | **Cable** (read), **Atlas** (universe), **Keep** (Traces) are real. **Ask** has no contract on web, so the dock carries three entries, not four |
| System, interior, planet levels | **no semantic geography exists**, so these levels are not built yet; the universe level is, and it must look like the reference's universe level |

An empty universe still draws the frame: ground, dock, hint, and an honest line where the bodies
would be. Emptiness is a state of the design, not an excuse to omit it.

## 5c. How the experience progresses (Living Observatory)

Cosmos gives the theme. **Living Observatory gives the experience**, and in places it is simply better
— above all it solves the problem this document previously solved by deleting things. Drive it
yourself: the stage chips run `First visit` → `Day 6` → `Day 30` → `Six months`.

**The frame never changes; the narration does.** Every stage has the same parts — a kicker or
breadcrumb, a large heading, a one-line subtitle, sometimes a yellow left-ruled note, bodies on a star
ground, a yellow call to action with helper text beneath it, zoom controls with a view label, the
dock, and a legend. What changes is the copy and how much is out there.

| Stage | Heading | Subtitle | Note | View | Call to action |
|---|---|---|---|---|---|
| First visit | "Somewhere new starts here." | "No topics to pick. Just something interesting." | — | `SYSTEM VIEW` | "Show me something ↗" / "Your world begins with what catches your curiosity." |
| Day 6 | "Your first little world." | "A few encounters are beginning to belong together." | "A trace of what you explored." | `SYSTEM VIEW` | "Watch something ↗" / "A familiar impulse. Somewhere new to go." |
| Day 30 | "A world taking shape." | "You came for technology. You found yourself asking how things come together." | "Once one planet. Now three places to get lost in." | `SYSTEM VIEW` | "Watch something ↗" |
| Six months | "Things begin to connect." | "Different worlds. A few questions running through all of them." | "Connections make the world richer." | `GALAXY VIEW` | "Watch something ↗" |

### Why this matters more than the theme

**The first-visit state is the honest empty state, drawn beautifully.** It has no topics, because the
person has none yet. Its bodies are labelled "A first possibility · See what catches your curiosity",
"A different angle", "A little surprise" — *generic, truthful names for things not yet known*, with the
unexplored ones drawn as faint dust rather than omitted. That is exactly our position with a finite
library and no inferred interests, and it needs **no invented data at all**. The earlier draft of this
document reached for a prohibition where the reference had already solved it with copy.

### The mapping to what we actually have

- **Empty universe** → the first-visit stage verbatim in spirit: "Somewhere new starts here." / "No
  topics to pick. Just something interesting.", one body for the encounter on offer, faint bodies for
  the unread remainder, and "Show me something ↗" as the primary action.
- **After some reading** → the day-6 stage: "Your first little world.", bodies for real kept Traces and
  encountered Scrolls by their real titles, the yellow note carrying the **real why-this-appeared
  reason** — which is what that line is for.
- **The legend** ("● Your paths · ◌ Still unexplored") appears once there is something to distinguish,
  and its second half is the real unread count.
- **The view label** (`SYSTEM VIEW`) is honest about the level being shown; `GALAXY VIEW` waits for
  data that does not exist.
- **Zoom controls** are real controls over a real canvas, not decoration.
- **The Idea Room card** needs rooms, which do not exist. Not drawn.
- **Watch / Room** in the dock need Reels and social, which do not exist. The dock carries the
  destinations that work.

A stage is chosen by what the reader has actually done, never by a date. The copy above is the
reference's; where a line would assert something untrue of this reader, it is rewritten to be true,
and the rewrite is recorded as a deviation.

### The frame that never changes, driven by the reader's real behaviour

Living Observatory's own frame is stable across all four of its scenario snapshots: a brand mark
top-left, an intro block (breadcrumbs, one heading, one italic-weight subtitle, an optional yellow
left-ruled growth caption), a primary call-to-action with a helper line beneath it
(`.entry`/`.primary`/`#entryNote`), map tools and a legend once there is something to key
(`.map-tools`/`.map-key`), and the dock (`.dock`, four entries: World/Watch/Room/Keep in the
reference — ours stays the three real entries from sec.5b). What changes between its snapshots is
never the frame, only the words in it: the heading, the one-line subtitle, the growth caption, the
CTA label, and the helper note. `renderMap()` in the reference computes every one of these strings
from `state.day`/`state.scale`, never from a wall-clock date — and that is the one part of its own
mechanism this product keeps: **the stage is chosen from what this reader has actually done, never
from a date.** Nothing here has "day N" scenario branches; there are exactly two real stages,
because there are exactly two real states a finite library can be in for one reader:

### The three stages this product actually has

The reference's four are authored snapshots of one demo. This product has three, and each is
chosen from what the reader has actually done — never from a date, and never from a day counter
(`stageFor(keptCount)` in `UniverseScreen.tsx`):

| Stage | Chosen when | Heading | Subtitle |
|---|---|---|---|
| `first` | no kept Traces at all | "Somewhere new starts here." | "No topics to pick. Just something interesting." |
| `few` | at least one, below the grown threshold | "Your first little world." | "A few encounters are beginning to belong together." |
| `grown` | at or above the grown threshold | "A world taking shape." | the real kept-Trace count |

The reference's "Six months" stage and its `GALAXY VIEW` label wait for data that does not exist.

### What is honestly reused, and what is not

The reference's **first-visit invitation copy is reused verbatim**, because it names no topic and
asserts nothing about this reader — "A first possibility" / "See what catches your curiosity", "A
different angle", "A little surprise", the yellow "Show me something ↗" CTA and its helper line.
This is exactly the honest description of a reader with a finite library and no inferred interests
(sec.5b/6): drawing it is required, not an invention, because it is drawn from *having nothing*,
not from having something specific. The unexplored frontier nodes are drawn as **faint dust,
never omitted** (`layoutMap()`'s `seed`/`possibility1`/`possibility2` nodes; sec.5b/6: "the mistake
to avoid is a pretty map of nothing").

What is **not** reused: the reference's returning-state vocabulary is "Watch something" because
its whole product is reel-watching. Ours is a reading Scroll, so the returning CTA keeps this
product's own honest verb ("Enter Scroll") rather than importing a verb ("Watch") that would
misdescribe what pressing it does — recorded here as a deviation from Living Observatory's literal
label, kept faithful to its *role* (one primary, prominent, always-present call to action with a
helper line) rather than its exact word. The invitation card (`#invitation`, "FROM THE IDEA ROOM")
is never drawn at any stage: it names a fictional room and fictional agents (Moss, Rook), which law
9/definition.md forbids fabricating regardless of how the reference frames it. The growth caption
(`#growthCaption`) needs a specific claim about what changed ("You tried a route from machines to
flocks."); no such cross-topic route exists yet, so it is not drawn until one does, exactly as
sec.6 already requires. The map-key legend, and Living Observatory's own real-content substitution
(a kept Trace's title standing in for a node's label, its date for its sub-label), are the two
pieces of real structure this product keeps as literal contracts, covered in sec.5b's table.

## 6. What the interface may show today

Only these have data: the honest empty universe, saved Traces, entering a Scroll, reading with
sources and truth state, why this appeared, deliberate next discovery, finite-library rest, Keep,
Trace revisit, Clear History, sign out, magic-link sign-in, and Reel playback for an eligible Reel.

**Not available, therefore not drawn** governs *content*, never whether a surface is built. No
invented topic, no fabricated branch, no Ask answer, no room, no inhabitant, no friend, no Blend, and
no node that implies a meaning nothing recorded. But a body whose label is a Scroll the reader really
kept is real, and drawing it is required, not forbidden — see §5b. The mistake to avoid is a pretty map
of nothing; the mistake just made was an honest page of nothing, and it is the worse of the two,
because it fails the reader *and* the reference.

## 7. How fidelity is judged

**First test, before any measurement:** render the reference and the build at the same size, put them
side by side, and ask whether they read as the same product. A build that matches every token and
still looks like a text page has failed. This test is first because it is the one that was skipped.

Screenshots at 1440×900 and 1024×768 sit beside the reference rendered at the same size. On a phone,
the comparable sizes are the emulator's own resolution at font scale 1.0 and 840×1680 at font scale 1.3,
which are the two the Android journeys already exercise. Palette,
type scale, pill geometry, rail proportions, head band and focus treatment must match. Differences
are recorded with a reason, not discovered later.
