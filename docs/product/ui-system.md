# The agreed interface, written down

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

## 6. What the interface may show today

Only these have data: the honest empty universe, saved Traces, entering a Scroll, reading with
sources and truth state, why this appeared, deliberate next discovery, finite-library rest, Keep,
Trace revisit, Clear History, sign out, magic-link sign-in, and Reel playback for an eligible Reel.

**Not available, therefore not drawn**: semantic world geography, branches and continuations, Ask
answers, rooms, inhabitants, friends and Blend. Cosmos's map and Living Observatory's room are
references for a later contract, not licence to draw a pretty map that means nothing — the design
direction is explicit that background specks carry no semantic identity. A decorative star ground is
allowed and must be marked decorative in code; a node that implies meaning is not.

## 7. How fidelity is judged

Screenshots at 1440×900 and 1024×768 sit beside the reference rendered at the same size. On a phone,
the comparable sizes are the emulator's own resolution at font scale 1.0 and 840×1680 at font scale 1.3,
which are the two the Android journeys already exercise. Palette,
type scale, pill geometry, rail proportions, head band and focus treatment must match. Differences
are recorded with a reason, not discovered later.
