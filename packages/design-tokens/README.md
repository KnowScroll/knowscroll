# @knowscroll/design-tokens

The semantic design tokens of the v2.1 export (`docs/v2/design/KnowScroll-design-v2.1/`,
`Tokens.html` and `Components.html` first) as typed TypeScript objects, plus the three bundled
fonts. The values are plain numbers and strings, so React Native `StyleSheet`, React Native Web
and plain web code can all read them. **The token set, not individual artboards, is the source**
(D-006 p): a value the frames draw without a name is either named here or listed under "Dropped".

Rule from Tokens.html: content screens use `content.*`; the universe uses `space.*`; a component
never mixes raw hexes from both.

| File | Exports |
|---|---|
| `src/color.ts` | `content`, `status`, `overlay`, `space`, `spaceOpacity`, `family`, `dormant`, `toggle`, `avatar`, `color` |
| `src/typography.ts` | `fontFamily`, `fontFallback`, `fontWeightRange`, `typeScale`, `typeScaling`, `resolveType()`, `letterSpacing()` |
| `src/layout.ts` | `spacing`, `target`, `layout`, `dimension`, `breakpoints`, `breakpointFor()`, `frames` |
| `src/shape.ts` | `radius`, `borderWidth`, `borderStyle`, `elevation`, `pressOffset`, `opacity`, `icon`, `iconStroke()` |
| `src/motion.ts` | `easing`, `motion`, `sheetRise`, `motionDuration()` |
| `src/layers.ts` | `layer` (z-order), `focusRing`, `highlightRing` |
| `fonts/` | Bricolage Grotesque, Instrument Sans, DM Mono with their OFL licences (byte-for-byte, see `fonts/README.md`) |

The package exports its TypeScript sources (`"."` → `src/index.ts`, `"./fonts/*"`). Its only
consumers are the Expo app and the UI package, whose bundler (Metro) and test runner (jest-expo)
compile workspace sources themselves, so there is no `dist/`. `src/tokens.test.ts` (Vitest)
checks contrast, the spacing base, breakpoints, type scaling and motion.

## Colour

### Content register (`content`)

| Token | Value | Role |
|---|---|---|
| `paper` | `#FFFBF0` | Ground |
| `paper2` | `#F4EDD8` | Sunken surfaces, inputs |
| `ink` | `#111111` | Text, the 2 px outline (18.3:1 on paper) |
| `ink2` | `#4A463D` | Secondary text (9.1:1) |
| `accent` | `#2C46E8` | Primary action; cream on it 6.5:1 |
| `accentDeep` | `#1B2FB8` | Accent as text, hover (named; was unnamed) |
| `onAccent` | `#FFFBF0` | Text on accent |
| `continue` / `onContinue` | `#FFE44D` / `#111111` | Horizontal continuation and Part cue only (D-006 b) |
| `fresh` | `#14C79B` | Ready / sent |
| `freshInk` | `#0B7A5F` | Teal as text (5.1:1) |
| `freshTint` | `#E3F6EF` | Success receipt ground (named; was unnamed, D05) |
| `rule` | `#D9D1BC` | Hairline divider, decoration only |
| `muted` | `#7D7563` | Quiet component edges (4.4:1, above the 3:1 non-text floor) |
| `nav` | `#111111` | Floating nav pill, rails |
| `highlight` | `#FFF4C2` | Restored-anchor flash, row hover |

### Status (`status`) — only Hypothetical and Corrected are status labels (D-006 a)

| Token | Background / foreground / edge |
|---|---|
| `hypothetical` | `#E6EAFF` / `#1B2FB8` / `#2C46E8` dashed |
| `corrected` | `#FFE9DE` / `#8A2C07` / `#8A2C07` |
| `danger` | fill `#B23A0B` (cream on it 5.8:1) · as text `#8A2C07` · edge `#B23A0B` |
| `preparing` | 135° stripes of `#FFFBF0` and `#F4EDD8`, 6 px (5 px in chips) |

### Overlays (`overlay`)

| Token | Value | Role |
|---|---|---|
| `scrim` | `rgba(17,17,17,.45)` | Modal scrim |
| `caption` | `rgba(17,17,17,.82)` | Caption backdrop over media |
| `onMediaControl` | `rgba(255,251,240,.94)` | Icon-button fill over media and the map |
| `onMediaTrack` | `rgba(255,251,240,.35)` | Progress track over media |
| `onDarkMuted` | `rgba(255,251,240,.78)` | Inactive nav items on ink (11.2:1) |
| `onDarkEdge` | `rgba(255,251,240,.6)` | Ghost borders and tag edges on dark |

### Pressed toggles (`toggle`) — never yellow (D-006 b, amended on #255)

Yellow means continuation only, so a pressed two-state control (Like, Save, a selected filter)
is never yellow. Components.html draws pressed toggles yellow; this set replaces that.

| Token | Background / glyph / edge | Where |
|---|---|---|
| `pressedOnLight` | `#2C46E8` cobalt / `#FFFBF0` filled / `#111111` | Paper (poster register) |
| `pressedOnDark` | `#FFFBF0` opaque cream / `#111111` filled / `#FFFBF0` | Over media, ink and the map (the resting control is cream 94 %) |

The filled glyph is the cue that does not rely on colour. Large-text grid toggles use the
primary (cobalt) button when pressed.

### Spatial register (`space`, `spaceOpacity`)

`s0 #040A17` ground · `s1 #0B1A2E` raised / space nav pill · `s2 #14273F` pressed ·
`control #FFFBF0` with `onControl #111111` · `label #FFFBF0` · `label2` cream 72 % (9.9:1) ·
`orbit` cream 18 % · `edge` cream 22 % · `route` cream 40 % · `star #FFE9A8` · `focus #FFE44D` ·
`labelChip rgba(4,10,23,.86)` · `regionPin` fill `#E7F7E9` / selected `#FFE44D` / stroke ink.
Decorative opacities: star glow .16 / .08, background stars .3–.7, dormant orbit .10.

### Topic families (`family`) — hue plus pattern, never hue alone

| Family | Base | Pattern | Motif |
|---|---|---|---|
| `learningMachines` | `#2BC4B4` | `#5BCB72` (stroke `#0E3B2E`) | angular land |
| `systems` | `#6E86FF` | `#C9D3FF` | banded strata |
| `past` | `#F2B84B` | `#8A5A10` | ridged dunes |
| `play` | `#FF8A5B` | `#FFD2BE` | round islands |
| `worlds` | `#E7E1CF` | `#7D7563` | fault lines |

Dormant: saturation −35 %, orbit at 10 %, no glow, no twinkle; the body stays where it was.
Planet size never encodes consumption (D-006 m).

## Typography

Families (registered with expo-font under these names): `display` = `BricolageGrotesque`
(variable, wght 200–800), `text` = `InstrumentSans` (variable, wght 400–700), `mono` = `DMMono`
(static 500). Sizes are phone sizes; desktop (≥ 1024) multiplies the six authored roles by 1.15,
and also the control and copy roles that sit beside body text (`ui`, `uiS`, `meta`, `metaS`,
`notice`), so a button grows with the paragraph above it (`ui` 15 → 17.5 next to `body`
18 → 20.5). Navigation and map labels (`uiLabel`, `monoXs`, `spaceLabel`, `captionMedia`) keep
their drawn size: the rails and the map are drawn at those sizes on desktop. Sizes round to the
nearest half pixel.
`resolveType(role, { desktop, textScale })` returns the React Native style, interpolating from
100 % to the 200 % value and clamping there; above 150 % caps labels become Instrument 600 in
sentence case.

| Role | Font / weight | Size / line | Tracking | At 200 % | Source |
|---|---|---|---|---|---|
| `displayXl` | Bricolage 800 | 44/46 | −2 % | 44/48 | Tokens; V01 draws 200 % |
| `displayL` | Bricolage 800 | 32/36 | −2 % | 36/40 | Tokens (also empty-state titles, sheet titles) |
| `title` | Bricolage 700 | 22/28 | −2 % | 28/34 | Tokens |
| `body` | Instrument 400 | 18/28 | 0 | 26/38 | Tokens ("26 px at 200 %") |
| `bodyS` | Instrument 500 | 15/22 | 0 | 21/30 | Tokens |
| `label` | DM Mono 500 caps | 11/14 | +6 % | Instrument 600 18/24 | Tokens |
| `page` | Bricolage 800 | 36/40 | −2 % | 40/44 | named: tab-root titles (S01, C01) |
| `heading` | Bricolage 800 | 26/30 | −1 % | 32/36 | named: panel h2, U01 header |
| `ui` | Instrument 600 | 15/20 | 0 | 20/26 | named: `.btn`; V01 draws 20 at 200 % |
| `uiS` | Instrument 600 | 14/18 | 0 | 18/24 | named: `.btn.sm`, `.seg`, `.chip`; V01 segment 18 |
| `uiLabel` | Instrument 600 | 11/13 | +1 % | 15/18 | named: nav items, action rail words |
| `meta` | Instrument 400 | 13/18 | 0 | 18/25 | named; V01 meta 18 |
| `metaS` | Instrument 600 | 12/16 | 0 | 17/22 | named: sender names, presence |
| `notice` | Instrument 400 | 14/20 | 0 | 19/27 | named: `.banner` 14/1.4 |
| `captionMedia` | Instrument 500 | 16/22 | 0 | 22/30 | named: Reel captions |
| `monoXs` | DM Mono 500 caps | 10/12 | +6 % | 15/18 | named: edge tab, episode part |
| `spaceLabel` | Instrument 600 | 13/16 | 0 | 18/22 | named: map labels |

200 % values not drawn in the export (`displayL`, `title`, `bodyS`, `page`, `heading`,
`uiLabel`, `metaS`, `notice`, `captionMedia`, `monoXs`, `spaceLabel`) follow the ratio of the
nearest drawn role; they are bench values until a larger-text review.

## Spacing, targets and layout

Spacing (4 px base): `0 · 1=4 · 2=8 · 3=12 · 4=16 · 5=20 · 6=24 · 7=28 · 8=32 · 9=36 · 12=48 ·
14=56 · 18=72 · 24=96`, with the half steps `'0.5'=2 · '1.5'=6 · '2.5'=10 · '3.5'=14` that the
shared library classes use (segment gap, tag gap, banner gap, panel and rail gaps).
Targets: `comfortable` 48, `minimum` 44 (D-006 n). Layout: phone gutter 20, top controls inset
16, reading measure 500 (tablet) / 680 (desktop), blocks 880, swipe edge inset 24, tab-bar slot
96, rails 76 (tablet) / 88 (desktop), side panels 212 / 368, desktop entry card 480.
Breakpoints (V01): `compact` ≤ 360 · `phone` 361–599 · `tablet` 600–1023 · `desktop` ≥ 1024.

Component dimensions (`dimension`, so no component carries a raw number): tag height 26,
segment inset 3, nav item 74 × 56 (compact 56 × 48, radius 18) with the compact pill padding 5,
rail items 60 × 60 (tablet) and 72 × 64 (desktop), unread dot 10, grab handle 44 × 5 (radius 9),
empty-state tile 72, and `stateOffsetPhone` (`keep` 106, `talk` 116): where a phone empty state
starts below the header, as S01-02 and C01-02 draw it. The frames have no status bar but leave a
44 px region for one (the header sits at y 56, 12 below it, as the app puts it 12 below the safe
area), so positions are matched inside the safe area, not from the frame's top edge.

## Shape, elevation, motion, layers, focus

- Radius, by the roles Tokens.html authors (`6 tag · 14 card · 20 panel · 28 sheet · pill
  control`) plus the drawn component radii: `xs 4 · tag 6 · thumb 8 · md 12 · card 14 · lg 16 ·
  edgeTab 18 · panel 20 · navItem 20 · navPillCompact 24 · navPill 26 · sheet 28 (top corners) ·
  pill 999`. Banners, skeleton cards and inline cards use `card`; empty-state tiles, gallery and
  diagnostics panels use `panel`. Conflict: Tokens.html says "tag 6" but Components.html draws
  `.tag` as a pill; the `Tag` component follows Components.html (`pill`) and `radius.tag` stays
  for square-cornered tags drawn elsewhere.
- Border width: `hairline 1 · light 1.5 · regular 2 · current 3`; style by relationship: Part
  solid, Related dashed, What-if dashed cobalt, AI dotted, Preparing dashed.
- Elevation (CSS `box-shadow` strings): `press 3px 3px 0 ink` (removed when pressed or disabled;
  the button travels by `pressOffset` 3) · `hero 6px 6px 0 cobalt` · `heroInk 6px 6px 0 ink` ·
  `raised 4px 4px 0 ink` · `hint 4px 4px 0 yellow` · `current 3px 3px 0 cobalt` · `spacePanel` ·
  `navPaper` · `navSpace`.
- Opacity: disabled .45 · sending .6 · unavailable .8 · grab handle .25.
- Motion (default → reduced): `press` 120 ms → same without travel · `sheet` 240 ms ease-out,
  rise 24 → 140 ms fade · `subject` 320 ms → 160 ms crossfade · `thread` 360 ms → 160 ms
  crossfade · `camera` 750 ms (600–900) → cut with 200 ms fade · `formation` 2.4 s once →
  final still · `ambient` ≤ 1 cycle / 20 s → off. Only the sheet's easing is authored; the
  others use the standard deceleration `cubic-bezier(.2, 0, 0, 1)` until a motion study names one.
- Layers (the export has none; stacking was DOM order): content 0 · media overlay 10 · action
  rail 20 · top bar 30 · navigation / mini player 40 · scrim 50 · sheet 60 · toast 70 (reserved).
- Focus ring (D-006 n): 3 px, 3 px offset; cobalt `#2C46E8` on paper, yellow `#FFE44D` on ink,
  space and cobalt media (cobalt on cobalt is 1:1). Selection highlight (`highlightRing`, 3 px
  yellow) is separate and never stands in for focus.
- Icons: 24 × 24 viewBox; sizes 22 (nav, icon buttons) · 20 (strips, banners) · 18 (chips) ·
  16 · 14 (segment) · 12 (tags); stroke 2 at ≥ 20 px, 2.4 at 14–18, 2.6 below.

## Mapping notes (D-006 p)

Named here (drawn without a token): `#1B2FB8` → `content.accentDeep`; `#E3F6EF` →
`content.freshTint`; `#7D7563`, `#9A9382` (upcoming episode) and `#8F887A` (suggested branch
node) → `content.muted`, the darkest of the three (the lighter two are near the 3:1 floor for
component edges on paper; all three draw quiet, non-current edges); `rgba(17,17,17,.82)` →
`overlay.caption`; `rgba(255,251,240,.94/.35/.78/.6)` → `overlay.*`; the `.tag.sp` edge
`rgba(255,251,240,.55)` → `overlay.onDarkEdge` (.6); `rgba(255,251,240,.22)` → `space.edge`;
the mini-bar ground `#070A14` → `space.s0`; type sizes 36, 26, 14 (banner), 13, 12, 10 and the
control sizes → the named type roles above; spacing 2, 6, 10, 14 → half steps; radii 4, 8, 12,
16, 18, 24, 26 → named radii; the offset shadows `4px ink`, `3px cobalt`, `6px ink`, `4px yellow` →
named elevations.

Normalised to an existing token: scrims `.35 / .4 / .5 / .55` → `.45` (the most used, five
files); empty-state titles drawn at 30–32 → `displayL`; empty-state body drawn at 17/1.5 →
`body` 18/28; U01's body at cream 80 % → `space.label2` (72 %); spacing 18 and 22 → 16 / 20 / 24
by context; radii 9 (dots) → `pill`, 10 (outline rows) → `md`, 22 → `panel`; Reel titles
drawn at 20–30 → `displayL` / `title` when the encounter is built.

Dropped, with reason:
- The "Speculative" label and its amber trio `#FFF4C2 / #8A5A10 / #6B4508` and `#3E2A06`:
  D-006 a (status labels are only Hypothetical and Corrected).
- `#3A55F0`, `#0B0F1F`, `#141B3D`, `#000000`: illustration and thumbnail art inside media, not UI.
- Per-person terrain colours in U03/U07 (about 40 hexes): seed-generated scene data, not tokens.
- Person avatar fills reusing family hues (`#6E86FF`, `#F2B84B`, `#FF8A5B`): authored example
  people; only the signed-in person's own avatar (`avatar.self`, yellow) is a token. Other
  people's avatars are designed with the conversation surfaces.
- `#DCD5C2` (keyboard placeholder stripe in C04) and `canvas.board #E8E2D2`: documentation canvas.
- The operator register (Operator.html greys): not consumer UI; it is defined with the operator
  page.
