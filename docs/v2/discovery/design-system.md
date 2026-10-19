# KnowScroll v2.1 design export: the visual system (discovery)

Scope: the system, not individual screens. Inputs read as source (`source/*.dc.html`, `source/canvas.json`) and rendered in Chromium (Playwright, served over a local `python3 -m http.server`, Google Fonts loaded: Bricolage Grotesque 400–800, Instrument Sans 400–700, DM Mono 400/500).

Files studied: `Main`, `Tokens`, `Components`, `NavBar`, `N01-Navigation`, `V01-Responsive`, `D01`–`D05`, `Operator`, `index.html`, `canvas.json`. Cross-file usage counts come from a scan of all 50 `source/*.dc.html` files (scripts in `/Volumes/Mrigesh SSD/knowscroll-dev/v2/agents/design-system/scan.py` and `icons.py`).

Renders (PNG): `/Volumes/Mrigesh SSD/knowscroll-dev/v2/design-reference/renders/` holds `index.png`, `Main.png`, `Tokens.png`, `Components.png`, `NavBar.png`, `N01-Navigation.png`, `V01-Responsive.png`, `D01-Desktop-Explore.png` … `D05-Desktop-Privacy.png` and `Operator.png`. The readable full-resolution slices are in `renders/system-slices/` (Components ×5, Main ×6, N01 ×4, V01 ×4, Tokens ×3). Other files in `renders/` (A01, E01–E03, `crops/`) belong to the screens agent.

Conventions in this document:
- **Authored** = a value written in `Tokens.html` or `Components.html` as a named rule.
- **Observed** = a value the frames use that the token sheet does not name. These are proposals or drift, and are flagged.
- Contrast ratios are quoted as the designer wrote them; I did not recompute them.

---

## 0. Canvas structure (canvas.json)

`canvas.json` v3, title "KnowScroll — Product design v2", launch page `start`. There are 13 pages and 50 boards. Board sizes (w×h, as the canvas lays them out):

| Page | Boards (w×h) |
|---|---|
| 00 Start · audit & coverage | Main 1440×4200 |
| 01 Foundations & components | Tokens 1440×2100 · Components 1440×4100 · NavBar 390×96 ("instance source") |
| 02 Entry & Explore (A, E) | A01 2174×1480 · E01 2174×1480 · E02/E03/E04/E05/E07/E09 1752×1480 · E06/E08 1330×1480 · N01 2596×1800 |
| 03 Keep (S) | S01 1752×1480 |
| 04 Universe (U) | U01/U02/U06/U08 1752×1480 · U03/U04 1330×1480 · U05 2174×1480 · U07 2596×1480 |
| 05 Share (H) | H01/H02/H03 2174×1480 |
| 06 Talk (C) | C01/C03 1330×1480 · C02 1752×1480 · C04 2596×1480 |
| 07 What-if (X) | X01/X02/X04 1330×1480 · X03 1752×1480 |
| 08 Rooms (R) | R01/R03 1330×1480 · R02 1752×1480 |
| 09 People & settings (F, P) | F01/P03 1752×1480 · P01 1330×1480 · P02 2174×1480 |
| 10 Desktop & responsive | D01–D05 1440×900 · V01 2640×1540 (inner content div is authored 2640×1480) |
| 11 Clickable journeys | Prototype 1440×1000 (`is_interactive`) |
| 12 Operator appendix | Operator 1440×1500 |

Board widths follow a phone-column grid. A 390 phone plus a 32 gap plus 2×48 padding gives 1330 for 3 phones, 1752 for 4, 2174 for 5 and 2596 for 6. `designSystems: []` and `notes: {}` are empty. The README says the `.dc.html` sources need the canvas runtime (`support.js`, not shipped). The `html/` exports render standalone.

Export rendering defect: in the static `html/` export, Main, Tokens and Components overflow their authored heights (rendered 5527, 2572 and 4714 px against 4200, 2100 and 4100). On Main the fixed-height flex root squeezes the 560 px dark header down to 136 px, which hides the "KnowScroll product design v2" H1 (`Main-slice01.png`). The source is intact. Treat the sources as the spec.

---

## 1. Design tokens (exactly as authored, plus observed drift)

Tokens.html states the rule: **"Semantic tokens with two registers. Content screens use content.\*; the universe uses space.\*. A component never mixes raw hexes from both."** Main adds: "tokens are semantic (content vs spatial roles), not raw hexes per screen."

### 1.1 Colour: content register ("poster": Reel, Scroll, Talk, Keep, settings and all ordinary controls)

| Token (authored) | Value | Authored role / note | Where it appears |
|---|---|---|---|
| `content.paper` | `#FFFBF0` | Ground (cream) | 49 files; every phone, card and control fill |
| `content.paper-2` | `#F4EDD8` | Sunken, input | Chat backgrounds, desktop stage (D01 `main`), receipt rows, the "Reconnecting" banner, the off switch |
| `content.ink` | `#111111` | Text, 2px outline · 18.6:1 | 50 files |
| `content.ink-2` | `#4A463D` | Secondary · 9.4:1 | Meta text, labels |
| `content.accent` | `#2C46E8` | Primary action · cream on it 6.2:1 | Primary buttons, active tab, own bubbles, switch on, Reel media ground |
| `content.continue` | `#FFE44D` | Horizontal / Part cue · ink on it | Part tags, edge tab, "Next part" rows, pressed Like/Save |
| `content.fresh` | `#14C79B` | Ready / sent · ink on it | Ready chip, presence dot |
| `content.fresh-ink` | `#0B7A5F` | Teal as text · 5.2:1 | Moderator tag, "Stays", presence ring |
| `content.hypo` | `#E6EAFF` / `#1B2FB8` | Hypothetical · dashed edge (border `#2C46E8` 2px dashed) | What-if cards, tags, composer |
| `content.corrected` | `#FFE9DE` / `#8A2C07` | Corrected / revised | Corrected tag and banner; `#8A2C07` is also used as danger text |
| `content.danger` | `#B23A0B` | Failed, destructive · 6.0:1 | Failed borders, Delete button fill (D05) |
| `content.rule` | `#D9D1BC` | Hairline divider (decor only) | 1px list and table dividers |
| `content.nav` | `#111111` | Floating nav pill | NavBar paper tone, desktop and tablet rails |
| `content.highlight` | `#FFF4C2` | Restored anchor flash | N01 step 6 end card; also the row hover fill (`.crow:hover`, `.orow:hover`, `.rt:hover`, Main table) |
| `content.pending` | `repeating-linear-gradient(135deg,#FFFBF0 0 6px,#F4EDD8 6px 12px)` | Preparing skeleton | 17 files; compact chips use a 5px/10px variant |
| `canvas.board` | `#E8E2D2` | Design canvas only | Board backgrounds (not product) |

Observed content-register values with **no token** (name them or remove them):

| Value | Use | Files |
|---|---|---|
| `#1B2FB8` (cobalt deep) | `a:hover`; hypo text; "Keep listening" mini bar ground; N01 stack chip text | 49 |
| `#3A55F0` (cobalt light) | Secondary disc in the Reel illustration | 11 (media art) |
| `#7D7563` (warm grey) | Preparing card dashed border; episode divider; `family.worlds` stroke | C04, Components, D03, Tokens, U07 |
| `#9A9382` | "Upcoming" episode border | D04, Prototype |
| `#8F887A` | Suggested branch-node dashed border | R02, X01–X04 |
| `#E3F6EF` (fresh tint) | Success receipt row ground | D05 |
| `#FFF4C2` / `#8A5A10` / `#6B4508` | `.tag.spec` "Speculative" (bg / border / text) | D03, X02, X03, X04 |
| `#3E2A06` | Speculative dark text | X01, X03 |
| `#DCD5C2` | Keyboard-placeholder stripe | C04 |
| `rgba(17,17,17,.82)` | Caption backdrop over media; "previous" left-edge tab | 10 |
| `rgba(17,17,17,.35/.4/.45/.5/.55)` | Modal scrims: five different values | `.45` in C02, E04, E07, R02, X01; `.5` in H01, N01; `.4` C03; `.55` E05; `.35` Prototype |
| `rgba(255,251,240,.94)` | On-media icon-button fill (`.ibtn.sp`) | 45 |
| `rgba(255,251,240,.35)` / `#FFFBF0` | Progress track / fill on media | 14 |
| `rgba(255,251,240,.78)` | Inactive nav item, mini-bar secondary text | 9 |
| `rgba(255,251,240,.55)` | `.tag.sp` border | 45 |
| `rgba(255,251,240,.6)` | Ghost-on-dark border ("List view", landscape "Next subject") | 12 |
| `#070A14`, `#0B0F1F`, `#141B3D`, `#000000` | Mini-bar ground and black-hole thumbnails. Near `space.0` but not equal | C04, Components, D03 |
| Avatar fills `#6E86FF` (Ravi), `#F2B84B` (Meera), `#FFE44D` or `#14C79B` (Asha: inconsistent), `#FF8A5B` | Person avatars reuse topic-family hues | D01–D05, C01, R02 … |

### 1.2 Colour: spatial register ("cosmos": universe, rooms on the map, formation)

Header note: "Unified from web #050B19/#0B1630 and Cosmos #03101A/#061A27" (Main says #050B19/#03101A become `space.0`, and #0B1630/#061A27 become `space.1`).

| Token | Value | Role |
|---|---|---|
| `space.0` | `#040A17` | Ground |
| `space.1` | `#0B1A2E` | Raised panel (also the NavBar `space` tone) |
| `space.2` | `#14273F` | Pressed / selected |
| `space.control` | `#FFFBF0` | Cream floating controls |
| `space.label-2` | `rgba(255,251,240,.72)` ("cream 72%") | Secondary label · 9.8:1 |
| `space.orbit` | `rgba(255,251,240,.18)` ("cream 18%") | Orbit hairline · decor |
| `space.star` | `#FFE9A8` | Organising star core |
| `space.focus` | `#FFE44D` | Focus ring / ship trail |
| (unnamed) panel edge | `rgba(255,251,240,.22)` | 1px hairline on space panels; part of the space elevation and the NavBar space edge |

Topic families. The rule: family = hue + surface pattern, two cues and never hue alone.

| Token | Fill | Pattern stroke / secondary | Pattern | Example |
|---|---|---|---|---|
| `family.learning-machines` | ocean `#2BC4B4` | land `#5BCB72`, stroke `#0E3B2E` 1.5–2 | Teal ocean · angular green land | Machine learning |
| `family.systems` | `#6E86FF` | strata `#C9D3FF` 3px | Cobalt · banded strata | Backend systems |
| `family.past` | `#F2B84B` | ridge `#8A5A10` 3px | Amber · ridged dunes | Predictive history |
| `family.play` | `#FF8A5B` | islands `#FFD2BE` | Coral · round islands | Football, games |
| `family.worlds` | `#E7E1CF` | fault `#7D7563` 3px | Bone · fault lines | Astronomy, physics |

Spatial state rules (authored): personal variation comes from the land-silhouette seed, orbit order, ring tilt and routes. **Planet size never encodes amount watched.** Dormant ("Calm") means saturation −35% (example: ocean `#4C8A86`, land `#5E8F68`), no glow, no twinkle, orbit at 10%, and the body stays where it was. The organising star is a core r15 `#FFE9A8` with glow rings at opacity .16 (r28) and .08 (r44); D02 uses .14 and .06. "Activity = glow ring opacity, not size." Dust ("emerging") is cream dots r1–2.2 at opacity .4–.8 plus a family-hue halo at .1; it is unlabelled and "never promises a future planet". Region pin: an octagon, default fill `#E7F7E9` stroke `#111111` 2, selected fill `#FFE44D` stroke 2.5, centre dot `#111111` r3, hit area 48. There are two states only and no seen/visited badge. Ship: a cream triangle with a trail of `#FFE44D` 2px, `stroke-dasharray 2 6`, round caps. Room station: cream outline 2.4 with a yellow core dot r3. A selected planet (D02) gets a `#FFE44D` 2px ring at dash 4 5 and r+10, and its label turns `#FFE44D`. A route is cream at .4, 1.5px, dash 6 8. Background stars are cream r.8–1.3 at opacity .45–.6.

Per-person terrain colours in U03 and U07 (about 40 extra hexes such as `#5FE0CF`, `#22A99E`, `#A6E8A8`) are seed-generated scene data, not tokens.

### 1.3 Colour: operator register (Operator.html only; separate from consumer UI)

Page `#F2F2F2`; view `#FFFFFF` with 1px `#BDBDBD`, radius 8, padding 18; panel `#FAFAFA` with 1px `#CFCFCF`, radius 4; text `#111111`, `#222222`, `#333333`, `#555555`, `#757575`; chip border `#9E9E9E`; table rule `#DDDDDD`. "Never logged" uses border `#B23A0B` and title `#8A2C07`. It reuses `#FFE44D` for the "Prototype · design data" badge. Typography is DM Mono throughout for headings: H1 40/500 −.01em, view H2 15/500 +.02em. Prose is Instrument Sans 12.5–15. The register is neutral and greyscale, with no cream or cobalt, so ops tooling cannot be mistaken for product.

### 1.4 Typography

Families (Google Fonts URL in every file): `Bricolage Grotesque:opsz,wght@12..96,400..800`, `Instrument Sans:ital,wght@0,400..700;1,400..700`, `DM Mono:wght@400;500`.

Stacks: `.disp` = `'Bricolage Grotesque','Instrument Sans',system-ui,sans-serif` with `letter-spacing:-.02em`; body = `'Instrument Sans', system-ui, sans-serif`; `.mono` = `'DM Mono',ui-monospace,Menlo,monospace` with `text-transform:uppercase; letter-spacing:.06em; font-size:11px` (12px on Main).

Authored scale ("Typography · phone sizes (desktop +15%)"):

| Token | Family / weight | Size / line | Tracking | Role |
|---|---|---|---|---|
| `display.xl` | Bricolage 800 | 44/46 | −2% | Scroll title, one per screen |
| `display.l` | Bricolage 800 | 32/36 | −2% (via `.disp`) | Reel title, sheet title |
| `title` | Bricolage 700 | 22/28 | −2% | Section, card, planet name |
| `body` | Instrument 400 | 18/28 | 0 | Article prose · measure 30–34em |
| `body.s` | Instrument 500 | 15/22 | 0 | UI copy, messages, captions |
| `label` | DM Mono 500 | 11/14 | +6%, caps | "Labels only — never sentences" |

Accessibility rules: "body scales to 26px at 200% before layouts reflow to one column"; "labels move to Instrument 600 sentence-case above 150% so caps don't become a wall". V01 at 200% draws: title 44/48, meta 18/600, segment 18px with min-height 44, actions as a 2×2 grid of text buttons (20px, min-height 56, no shadow), body 26/38.

Observed type roles the scale does not name (by frequency across 50 files: 14px ×377, 13px ×274, 11px ×216, 15px ×207, 12px ×127, 16px ×101, 11.5px ×45):

| Proposed token | Value as drawn | Used for |
|---|---|---|
| `ui` | Instrument 600 15 (`.btn`), 14 (`.btn.sm`, `.seg`, `.chip`) | Controls |
| `ui.label` | Instrument 600 11, +.01em (nav, action rail `.ra`) | Icon-plus-word controls |
| `meta` | Instrument 400 13/1.35–1.45, `ink-2` | Secondary lines in cards, rows and notes |
| `meta.s` | Instrument 600 12 | Sender name (`.who`), presence, kbd legend |
| `caption.media` | Instrument 500 16/1.4 on `rgba(17,17,17,.82)` (13/1.35 in small players) | Reel captions; keywords bold `#FFE44D` |
| `bubble` | Instrument 15/1.4 (14/1.45 in D04) | Messages |
| `mono.xs` | DM Mono 9.5–10 caps | Edge-tab "Part 2", episode "Part 1" |
| `space.label` | Instrument 600 13/16 cream (`.lab`); `.labm` DM Mono 500 10/12 +.08em cream .72 | Map labels |
| `panel.h2` | Bricolage 800 26, −.01em (Components); settings card h2 22/800 (D05) | Panel and card headings |

Reel titles are drawn at 28/30 (N01 P1), 25/27 (N01 P2), 30/32 (D01), 24/26 (V01 compact) and 20/22 (D03 player). None of these match `display.l` 32/36, and the desktop +15% rule (which would give about 37) does not appear in D01.

### 1.5 Spacing, layout measure, targets

- Spacing (authored, "4-base"): `4, 8, 12, 16, 20, 24, 32, 48`.
  - Observed off-scale values in heavy use: 14 (panel gaps, chip padding, rail gap), 10, 6, 18, 22, 28, 36, 56, 72, 96 (board padding).
- Touch target: **48** logical px, floor **44**.
  - Observed below the floor: segment buttons 38 tall (the container reaches 48); D04 player pause 36×36; D01 ghost "Next subject" min-height 36; D04 AI-suggestion buttons min-height 36; D04 snippet "Play" tag 30 tall; desktop kbd hints (non-interactive).
- Phone gutter **20**. Observed: 12–24, typically 16 for top bars and 20 for cards.
- Content measure **≤ 34em**: "500px here" on tablet and "680px on desktop". The body token says 30–34em, while Main says "~62ch measure". Interactive blocks widen to 880 on desktop (Main coverage table).
- Safe area (authored): "content starts below the platform status bar — no drawn status bars". In 390×844 frames the first bars sit at y=44 (header bars `.thead`/`.chead`/`.wbar` at `top:44px`) or y=52–56 (floating top controls). The bottom NavBar slot is 390×96. In-app horizontal swipe keeps a **24px** inset from the screen edges to avoid the OS back-edge (N01 device-test note).

### 1.6 Radii

Authored row: `6 · 14 · 20 · 28 (top only) · pill (999)` labelled "tag · card · panel · sheet · control".

Observed frequency: 999 ×372, 14 ×154, 16 ×75, 12 ×70, 9 ×66 (dots), 6 ×65, 4 ×58, 8 ×57, `28 28 0 0` ×47 (sheet), 44 ×44 (phone frame), 18 ×40, 20 ×25, 10 ×19, `18 0 0 18` ×8 (edge tab), 22 ×6, 24 ×5, 26 ×2 (nav pill), 36 (compact frame), 28 (tablet frame).

Conflicts:
- The "tag = 6" label contradicts `.tag`, which is `border-radius:999px`. 6 is actually used for the canvas badge, `kbd` and the N01 stack chip.
- Cards are drawn at 16 (content card, snippet, branch card, mini bar), not 14.
- 12 (inputs, episode cards, list rows) and 18 (desktop cards, edge tab) are unnamed.

Proposed reconciled scale: `xs 4 · sm 6 · md 12 · lg 16 · xl 20 · sheet 28 · pill 999`, plus component-specific `edgeTab 18`, `navPill 26`, `navItem 20`.

### 1.7 Borders and strokes

- `2px solid #111111` is the default outline for buttons, cards, inputs, sheets (top) and the segment control.
- `1.5px` for tags, notes, light cards, `kbd`, `.av` small, the D04 tool and collapse buttons.
- `1px #D9D1BC` for dividers.
- Dashed 2px: Related (ink), What-if (`#2C46E8`), Preparing (`#7D7563` / ink), cancelled chip, private card.
- Dotted 2px ink: AI bubble.
- 3px: the current episode card.
- Space panels: 1px `rgba(255,251,240,.22)`.

Relationship encoding by edge: solid yellow = Part; dashed cream = Related; dashed cobalt = What-if; segmented = Format.

### 1.8 Elevation and shadows

Authored: "press 3px ink · hero 6px cobalt · space panel hairline + soft drop".

| Name | Value | Use |
|---|---|---|
| `elev.press` | `3px 3px 0 #111111` | Default, primary and small buttons (46+ uses); removed when pressed (`transform:translate(3px,3px); box-shadow:none`), on ghost, ink and space buttons, and when disabled |
| `elev.hero` | `6px 6px 0 #2C46E8` | Hero card, Scroll diagram block, D02 topic card (16 uses) |
| `elev.space` | `0 0 0 1px rgba(255,251,240,.22), 0 16px 32px -12px #000` | Space panel |
| NavBar paper | `0 10px 24px -12px rgba(17,17,17,.55)` | Floating pill on paper |
| NavBar space | `0 0 0 1px rgba(255,251,240,.22), 0 12px 28px -10px #000` | Floating pill on space |
| Observed: `elev.offset4` | `4px 4px 0 #111111` | "Another perspective" card (`.pvc`), R03 |
| Observed: current episode | `3px 3px 0 #2C46E8` | Now-playing card |
| Observed: player desktop | `6px 6px 0 #111111` | D01 Reel player |
| Observed: danger button | `background #B23A0B; box-shadow 3px 3px 0 #111111` | D05 Delete account |
| Doc only | `6px 6px 0 #FFE44D / #2C46E8 / #14C79B` | Main audit cards |
| Canvas only | `0 0 0 2px #111111, 0 28px 50px -28px rgba(17,17,17,.5)` | Device frames |

### 1.9 Focus, selection and highlight rings

- Content focus-visible (authored): `outline:3px solid #2C46E8; outline-offset:3px` (`.btn.focus`). Also E03 and C04 (`rgba(44,70,232,.25)` soft variant).
- Space focus (authored): `space.focus #FFE44D`.
- Yellow ring used as selection or highlight in the content register (observed): `box-shadow:0 0 0 3px #FFE44D` on the N01 Share button just tapped, the E03 block highlight, the R02 branch highlight and the X04 current node (`outline:3px solid #FFE44D; offset 1px`). The prototype hotspot style is `0 0 0 4px #FFE44D, 0 0 0 7px #111111`.

### 1.10 Opacity

| Value | Use |
|---|---|
| .45 | Disabled button (`.btn.dis`, plus no shadow, `cursor:not-allowed`) |
| .6 | Sending bubble |
| .8 | Withdrawn or unavailable card |
| .25 | Sheet grab handle |
| .10 | Dormant orbit |
| .18 | Orbit hairline |
| .22 | Space edge |
| .72 | Space secondary label |
| .78 | Inactive nav |
| .94 | On-media icon button |
| .35 | Progress track |
| .82 | Caption backdrop |
| .7 / .55 | De-emphasised words in Reel art (illustrative) |

### 1.11 Z-layers

Not authored. No file uses `z-index`; stacking is by DOM order. The implied order, bottom to top:

1. Media or article.
2. On-media overlays: caption, title, progress.
3. Action rail and edge tabs.
4. Top bar (Back, format switch, topic tag).
5. Floating NavBar (bottom 96 slot) or mini bar.
6. Scrim.
7. Sheet or dialog (`role="dialog"`; Share, Ask, Members, Report).
8. Banners (inline, not floating).

No toast is specified in the consumer frames (Prototype has a `.toast` for canvas use).

### 1.12 Motion

Authored table (Tokens). No CSS transition or animation exists in any frame.

| Token | Use | Default | Reduced motion |
|---|---|---|---|
| `motion.press` | Button / chip press | 120ms, offset shadow → 0 | Same (no travel) |
| `motion.sheet` | Sheets, popovers | 240ms **ease-out**, rise 24px | 140ms fade |
| `motion.subject` | Vertical subject change | 320ms, page slides up | 160ms crossfade |
| `motion.thread` | Horizontal continuation | 360ms, yellow rail leads | 160ms crossfade + rail label |
| `motion.camera` | System → planet → region | 600–900ms dolly, ship travels | Cut with 200ms fade |
| `motion.form` | Formation (U05) | 2.4s once per transition ID; skippable | Final still + one-line caption |
| `motion.ambient` | Twinkle, orbit drift | Very slow, ≤ 1 cycle/20s | Off |

V01 reduced-motion rules:
- Subject and thread moves crossfade (160ms) instead of sliding.
- Camera moves become cuts with a 200ms fade.
- No star twinkle, orbit drift or glow pulse.
- Formation shows its final still with a one-line caption and no dust animation. The drawn example is "A new place: Attention" with a Visit button.
- Reduced motion follows the system setting and can also be set in Accessibility & playback (Components switch: "Reduce motion — Formation shows the final state").

Status rule: "Status is never colour alone: every state pairs a glyph and a word (✓ Sent, ↻ Retry, ⌁ Offline, ⧗ Preparing)."

Only `motion.sheet` has an easing curve. The others need curves (proposed below).

### 1.13 Breakpoints and frame sizes

Authored (V01 notes):
- **≤360** compact: icon-only nav, 44px rail.
- **361–599** phone: floating pill nav.
- **600–1023** tablet: nav rail plus one side panel (thread, outline or conversation).
- **≥1024** desktop: rail plus content plus side panel, one active player.

Frames:

| Frame | Size | Frame radius |
|---|---|---|
| Phone (primary) | 390×844 | 44 |
| Compact | 320×690 | 36 |
| Tablet portrait | 834×1112 | 28 |
| Landscape phone | 844×390 | 28 |
| Desktop | 1440×900 | — |
| Desktop documentation boards | 1440 wide | — |
| A01 desktop entry | "Centered 480px card on space ground" | — |
| H02 web landing | 1440 | — |

### 1.14 Iconography

Custom inline SVG line icons on a **24×24 viewBox**, `stroke="currentColor"`, `stroke-linecap="round"`, `stroke-linejoin="round"`, all `aria-hidden="true"`; the accessible name sits on the button.

- Stroke widths: 2 at 20–22px; 2.2–2.6 at 12–18px; 3–3.4 for check marks at 11–14px.
- Filled: play triangle, ⋯ more, pressed heart and bookmark, octagon results.
- Sizes: **22** (NavBar, 48 icon buttons, action rail); **20** (thread strip, banners, desktop strip, share options); **18** (chips, buttons, D02 zoom); **16** (small buttons); **14** (segment, compact chips); **12** (inside tags).

Icon set inventory (path signatures found across all frames):

| Group | Icons |
|---|---|
| Navigation | back chevron (×91), forward chevron, chevron up/down, arrow right / left / up / down, close ✕, menu ☰ |
| Tabs | Explore (TV: rect plus antenna), Universe (planet with tilted ring), Talk (speech bubble), Keep (bookmark) |
| Actions | Like (heart), Save (bookmark), Share (tray plus up-arrow), Ask (bubble with "?"; D01 adds a dot), Send (paper plane), Share moment (H-bar: 3 path variants), Full screen (corners), More ⋯, Play ▶, Pause ⏸, Back 10s, Captions (CC), Copy, Link, Search, Plus, Minus |
| Status | Check ✓, spinner arc (`M12 3a9 9 0 0 1 9 9`), retry ↻, clock (requested), offline (cloud slashed), info / alert circle, warning triangle |
| Semantics | Branch (what-if), Perspective (two overlapping circles; Components uses a globe instead), Lock (private / only you), Shield (moderator), Pencil (corrected), Members, Volume (listening), Pin, Organise, Branch-map (three nodes), List view, Eye, Eye-off (hide subject), Flag (report), Block, Trash, Leave |

No icon library is referenced. The set is hand-drawn and Lucide-like in geometry.

### 1.15 Grid and layout rules (from the frames)

- Phone: top controls at `left/right 16`, `top 52–56`. The action rail is at `right:12px; top:232px`, vertical, gap 14. The right edge tab is 76×76 at `top:584` (64×64 on compact). The title block is at `left:20; width 270; top:578`. Progress is at `top:712`. The NavBar slot is the bottom 96.
- Tablet (834): rail 76 (items 60×60, radius 16, labels 10/600); article padding `40 28 0 36`, text column 500; aside "This thread" 212 with a 2px left border.
- Desktop (1440×900):
  - Rail 88 (items 72×64, radius 18, labels 11/600, gap 8, "K" logomark in Bricolage 800 22 `#FFE44D`, account avatar 40 at the bottom).
  - D01: stage on `paper-2` with the Reel player at 430×720 (radius 26, `6px 6px 0 #111`), action column, aside 368, and a 44px keyboard legend footer.
  - D02: map plus a 380 outline aside.
  - D03: content column 560 plus conversation.
  - D04: room column 280, main (player 312, conversation), extras 260 (collapsible).
  - D05: settings nav 280 plus a two-column card grid (gap 20, padding 28/36).

### 1.16 Proposed `packages/design-tokens` structure

```ts
// packages/design-tokens/src/index.ts — values copied from Tokens.html / Components.html.
// "observed" = drawn in frames but not named on the token sheet; review before locking.

export const color = {
  content: {
    paper: '#FFFBF0', paper2: '#F4EDD8',
    ink: '#111111', ink2: '#4A463D',
    accent: '#2C46E8', accentDeep: '#1B2FB8' /* observed: hover, hypo text */,
    onAccent: '#FFFBF0',
    continue: '#FFE44D', onContinue: '#111111',
    fresh: '#14C79B', freshInk: '#0B7A5F', freshTint: '#E3F6EF' /* observed */,
    hypo: { bg: '#E6EAFF', fg: '#1B2FB8', edge: '#2C46E8' },
    corrected: { bg: '#FFE9DE', fg: '#8A2C07', edge: '#8A2C07' },
    speculative: { bg: '#FFF4C2', fg: '#6B4508', edge: '#8A5A10' } /* observed .tag.spec — decision needed */,
    danger: '#B23A0B', dangerInk: '#8A2C07',
    rule: '#D9D1BC', muted: '#7D7563' /* observed */, mutedEdge: '#9A9382' /* observed */,
    nav: '#111111', highlight: '#FFF4C2',
    pending: { a: '#FFFBF0', b: '#F4EDD8', stripe: 6, angle: 135 },
    overlay: {
      scrim: 'rgba(17,17,17,.45)' /* pick one of .35/.4/.45/.5/.55 */,
      caption: 'rgba(17,17,17,.82)',
      onMediaControl: 'rgba(255,251,240,.94)',
      onMediaTrack: 'rgba(255,251,240,.35)',
      onDarkMuted: 'rgba(255,251,240,.78)',
      onDarkEdge: 'rgba(255,251,240,.6)',
    },
    mediaDark: '#070A14' /* observed mini bar — or alias space.0 */,
  },
  space: {
    s0: '#040A17', s1: '#0B1A2E', s2: '#14273F',
    control: '#FFFBF0', onControl: '#111111',
    label: '#FFFBF0', label2: 'rgba(255,251,240,.72)',
    orbit: 'rgba(255,251,240,.18)', edge: 'rgba(255,251,240,.22)',
    star: '#FFE9A8', focus: '#FFE44D', trail: '#FFE44D',
    labelChip: 'rgba(4,10,23,.86)',
    regionPin: { fill: '#E7F7E9', selected: '#FFE44D', stroke: '#111111' },
  },
  family: {
    learningMachines: { base: '#2BC4B4', pattern: '#5BCB72', stroke: '#0E3B2E', motif: 'angular-land' },
    systems:          { base: '#6E86FF', pattern: '#C9D3FF', motif: 'banded-strata' },
    past:             { base: '#F2B84B', pattern: '#8A5A10', motif: 'ridged-dunes' },
    play:             { base: '#FF8A5B', pattern: '#FFD2BE', motif: 'round-islands' },
    worlds:           { base: '#E7E1CF', pattern: '#7D7563', motif: 'fault-lines' },
  },
  dormant: { saturationDelta: -0.35, orbitOpacity: 0.10, twinkle: false, glow: false },
  ops: { page: '#F2F2F2', view: '#FFFFFF', viewEdge: '#BDBDBD', panel: '#FAFAFA', panelEdge: '#CFCFCF',
         text: '#111111', text2: '#555555', text3: '#757575', chipEdge: '#9E9E9E', rule: '#DDDDDD' },
} as const;

export const font = {
  display: { family: 'Bricolage Grotesque', fallback: ['Instrument Sans', 'system-ui', 'sans-serif'] },
  text:    { family: 'Instrument Sans', fallback: ['system-ui', 'sans-serif'] },
  mono:    { family: 'DM Mono', fallback: ['ui-monospace', 'Menlo', 'monospace'] },
} as const;

// phone sizes; desktop = ×1.15 (authored rule). tracking in em.
export const type = {
  displayXl: { font: 'display', weight: 800, size: 44, line: 46, tracking: -0.02 },
  displayL:  { font: 'display', weight: 800, size: 32, line: 36, tracking: -0.02 },
  title:     { font: 'display', weight: 700, size: 22, line: 28, tracking: -0.02 },
  body:      { font: 'text', weight: 400, size: 18, line: 28 },
  bodyS:     { font: 'text', weight: 500, size: 15, line: 22 },
  label:     { font: 'mono', weight: 500, size: 11, line: 14, tracking: 0.06, caps: true },
  // observed roles (propose adding):
  ui:        { font: 'text', weight: 600, size: 15, line: 20 },
  uiS:       { font: 'text', weight: 600, size: 14, line: 18 },
  uiLabel:   { font: 'text', weight: 600, size: 11, line: 13, tracking: 0.01 },
  meta:      { font: 'text', weight: 400, size: 13, line: 18 },
  metaS:     { font: 'text', weight: 600, size: 12, line: 16 },
  captionMedia: { font: 'text', weight: 500, size: 16, line: 22 },
  monoXs:    { font: 'mono', weight: 500, size: 10, line: 12, tracking: 0.06, caps: true },
  spaceLabel:{ font: 'text', weight: 600, size: 13, line: 16 },
} as const;
export const typeScaling = { desktopFactor: 1.15, bodyAt200pct: 26, bodyLineAt200pct: 38,
  labelsSentenceCaseAbovePct: 150, labelFallback: { font: 'text', weight: 600 } } as const;

export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 12: 48 } as const; // + observed 14
export const layout = { phoneGutter: 20, measureEm: 34, measureMinEm: 30, measureTabletPx: 500,
  measureDesktopPx: 680, blockDesktopPx: 880, swipeEdgeInset: 24 } as const;
export const target = { min: 48, floor: 44 } as const;

export const radius = { xs: 4, sm: 6, md: 12, card: 14 /* authored */, lg: 16 /* observed */, xl: 20,
  sheet: 28 /* top corners only */, pill: 999, edgeTab: 18, navPill: 26, navItem: 20 } as const;

export const border = { hairline: 1, light: 1.5, default: 2, current: 3 } as const;
export const borderStyle = { part: 'solid', related: 'dashed', whatIf: 'dashed', ai: 'dotted', pending: 'dashed' } as const;

export const elevation = {
  press: { x: 3, y: 3, blur: 0, color: '#111111' },
  hero:  { x: 6, y: 6, blur: 0, color: '#2C46E8' },
  offset4: { x: 4, y: 4, blur: 0, color: '#111111' },       // observed (perspective card)
  current: { x: 3, y: 3, blur: 0, color: '#2C46E8' },       // observed (now-playing episode)
  space: [{ spread: 1, color: 'rgba(255,251,240,.22)' }, { y: 16, blur: 32, spread: -12, color: '#000' }],
  navPaper: { y: 10, blur: 24, spread: -12, color: 'rgba(17,17,17,.55)' },
  navSpace: [{ spread: 1, color: 'rgba(255,251,240,.22)' }, { y: 12, blur: 28, spread: -10, color: '#000' }],
} as const;

export const focus = {
  content: { width: 3, offset: 3, color: '#2C46E8' },
  space:   { width: 3, offset: 3, color: '#FFE44D' },
  highlight: { ring: 3, color: '#FFE44D' }, // selection/attention, not keyboard focus — see conflicts
} as const;

export const opacity = { disabled: 0.45, sending: 0.6, unavailable: 0.8, grab: 0.25,
  inactiveNav: 0.78, onMediaControl: 0.94 } as const;

export const z = { content: 0, mediaOverlay: 10, rail: 20, topBar: 30, nav: 40, miniPlayer: 40,
  scrim: 50, sheet: 60, toast: 70 } as const; // proposed — not authored

export const motion = {
  press:   { ms: 120, reduced: { ms: 120, travel: 0 } },
  sheet:   { ms: 240, easing: 'ease-out', rise: 24, reduced: { ms: 140, kind: 'fade' } },
  subject: { ms: 320, kind: 'slide-up', reduced: { ms: 160, kind: 'crossfade' } },
  thread:  { ms: 360, kind: 'slide-horizontal-rail-leads', reduced: { ms: 160, kind: 'crossfade+rail-label' } },
  camera:  { msMin: 600, msMax: 900, kind: 'dolly', reduced: { kind: 'cut', fadeMs: 200 } },
  form:    { ms: 2400, oncePerTransitionId: true, skippable: true, reduced: { kind: 'final-still+caption' } },
  ambient: { maxCyclesPer20s: 1, reduced: { kind: 'off' } },
  // easing for subject/thread/camera NOT authored — proposal: standard decel cubic-bezier(.2,0,0,1)
} as const;

export const breakpoint = { compactMax: 360, phoneMax: 599, tabletMax: 1023, desktopMin: 1024 } as const;
export const frame = { phone: [390, 844], compact: [320, 690], tablet: [834, 1112],
  landscape: [844, 390], desktop: [1440, 900] } as const;

export const icon = { viewBox: 24, sizes: { nav: 22, button: 22, strip: 20, chip: 18, sm: 16, seg: 14, tag: 12 },
  stroke: { default: 2, small: 2.4, tiny: 2.6, check: 3 }, cap: 'round', join: 'round' } as const;
```

---
## 2. Component inventory (Components.html plus recurring elements in Main, NavBar, N01, V01 and D0x)

Components.html says: "One library for React Native and React Native Web. Each component lists its variants; state frames reuse these instead of redrawing." The canonical CSS classes (`.btn`, `.ibtn`, `.tag`, `.seg`, `.banner`, `.msheet`, `.grab`, `.ra`) are **byte-identical in every file that defines them**, which is good evidence they are the shared library. Per-screen classes (`.ep`, `.snip`, `.bub`, `.av`, `.chip`, `.opt`, `.lrow`, `.mini`, `.pres`, `.rail`) are re-declared with drift (listed per component).

"Used in" lists come from scanning all 50 source files for the class or a distinctive style.

### 2.1 Actions

**Button → `Button`** (`.btn`; 237 uses in 40 files)
- Anatomy: inline-flex, gap 8, optional leading or trailing 16–18 icon, label Instrument 600 15, `white-space:nowrap`, 2px ink border, pill, `3px 3px 0 #111` offset.
- Variants (authored): `primary` (accent fill, cream text: "Request Scroll"), `default` (paper: "Save"), `ink` (ink fill, no shadow: "Resume at 0:31"), `ghost` (transparent, no shadow: "Not now"), `small` (`sm`: min-height 44, padding 0 14, 14px), `space` (`sp`: cream fill and border, no shadow, for the map).
- Variants (observed):
  - `danger` (D05 "Delete account…": fill `#B23A0B`, cream text, border `#B23A0B`, ink offset).
  - `danger-outline` (D05 "Review and confirm", "Not sent · Retry": border `#B23A0B`, text `#8A2C07`).
  - `continue` (yellow fill: End-of-Scroll "Part 2 → Attention at work", landscape "Part 2 →").
  - `related` (ghost plus dashed border with a dashed arrow).
  - `whatIf` (dashed `#2C46E8`, hypo fill, `#1B2FB8` text, no shadow: composer "What if…").
  - `ghost-on-dark` (transparent, cream text, border `rgba(255,251,240,.6)`).
- Sizes: md min-height 48, padding 0 20; sm 44, padding 0 14. Observed: compact 36 (D01 footer "Next subject", D04 AI suggestion: below the 44 floor) and large-text 56/20px.
- States (authored row): default; pressed (`translate(3px,3px)`, no shadow; `motion.press` 120ms); focus-visible (`outline 3px #2C46E8, offset 3`); disabled (`opacity .45`, no shadow, `cursor:not-allowed`, native `disabled`); busy (`aria-busy="true"`, spinner-arc icon plus a verb-ing label, "Sending").
- A11y: real `<button type="button">` or `<a>` for navigation.
- Used in: 40 files (absent only from E09, U01, U02, U03, U05, U07, Main, Tokens, NavBar, Operator).
- Platform: RN Pressable needs the offset-shadow translate on press-in (no CSS `:active`); RNW gets hover tooltips for icon buttons (V01).

**IconButton → `IconButton`** (`.ibtn`; 220 uses in 39 files)
- 48×48 circle with a 2px ink border on paper and a 22 icon.
- Variants: `paper`; `onMedia` (`sp`: no border, `rgba(255,251,240,.94)`); `onSpace` (same treatment); `plain` (border 0, transparent: Scroll top-bar Back); `accent` (send: accent fill, cream); `pressed` (yellow fill: Like/Save).
- Sizes: 48 (authored); 44 (`.ib44` compact/landscape, mini-bar buttons, `.mbtn`); 40 (D04 collapse, border 1.5); 36 (D04 pause: below the floor).
- A11y: the `aria-label` is the only name, and icons are `aria-hidden`. The Back button should be named "Back to …" (N01 rule): 37 instances do this and 31 still use plain "Back".
- Used in: 39 files.

**ActionRail → `ActionRail`** (vertical, on media; `.rail` + `.ra`; 12 files: Components, D01, E01, E04, E05, E06, E09, N01, Prototype, U04, V01, X03)
- Anatomy: a column of `IconButton(onMedia)` with an 11/600 word under each, gap 14, at `right 12, top 232` on a 390 phone.
- Order is fixed: **Like · Save · Share · Ask** ("Same order everywhere").
- States: pressed = yellow fill, filled glyph, and the word changes ("Liked", "Saved"). Save is a command with a receipt; on failure the glyph reverts and a banner offers retry.
- Responsive: compact 44px buttons with labels moved to accessible names (V01); landscape 4-column grid beside the video; larger text a 2×2 grid of text buttons; desktop (D01) a column to the right of the player using paper `IconButton`s.
- Platform: haptics on Save (RN native only, V01).

**ScrollActionStrip → `ActionStrip` variant `scroll`**
- A pill container (2px ink, padding 8, gap 8) of border-less 48 icon buttons in the same order.
- "Top + end of article; floats up on reverse scroll."
- Used in: Components, V01 tablet, E02 (screens agent).

**ThreadActionStrip → `ActionStrip` variant `thread`** (`role="toolbar"`, `aria-label="Thread actions"`)
- Icon (20) plus word (11/600), min 56×52 per item, 2px border, radius 16.
- Items: Like · Save/Saved (bookmark filled `#FFE44D`) · Share moment · Full screen · More ⋯ (`aria-label="More: keep listening, report"`). "Always visible under the player."
- Desktop variant (`.dstrip` + `.dact`, D03): a pill with 44-high icon+word buttons, where "Share moment" sits on a yellow fill.
- D04 variant (`.act`): no More item, and Saved uses an ink-filled glyph rather than yellow.
- Used in: Components, C04, D03, D04, H03.

**RelationshipEdgeTab → `ContinueTab`** (`.edge` / `.edgel`; Components, E01, E05, E09, N01, Prototype, V01)
- `part`: 76×76 at the right edge, `#FFE44D`, 2px ink border with no right border, radius `18 0 0 18`; content is DM Mono 10 "Part N" plus a 22 arrow →.
- `related`: cream, dashed 2px ink border, dashed arrow, "Related".
- `previous`: left edge, 64×64, `rgba(17,17,17,.82)`, cream, radius `0 18 18 0`, ← "Part 1".
- `compact`: 64×64, mono 9, 18 arrow.
- A11y: it is an `<a>` labelled "Continue: Part 2" or "Previous in this thread: Part 1". The arrow always points to the destination.
- Gesture: swipe left = next (→ key), swipe right = previous (← key); "Swipe left or tap".
- Platform: keep a 24px inset from the OS back edge (N01).
- Desktop replaces it with the ThreadRail (D01 has no edge tab).

**EndOfScrollCard → `ScrollEndCard`** (E02, N01)
- Ornament (48px rule, 10px rotated square, 48px rule), then a card (2px, radius 20, padding 18, gap 12): mono "End of this Scroll", a `Button(continue)` with Part tag, title and →, a `Button(related)` with Related tag and dashed →, and `Button` "↓ Next subject".
- State: `restored` uses fill `content.highlight #FFF4C2` and adds the resume time ("Attention at work · 0:20").
- Gesture: "In a Scroll, only after the end — reading momentum never" changes subject (a momentum guard).

**RequestChip → `RequestStatusChip`** (`.chip`; Components, E06, E07, P03, X01)
- Pill, min-height 44, padding `0 14 0 10`, 2px ink, 18 icon plus 14/600 text. "Attached to the thing requested · no percentages, no ETAs."
- States:
  - `requested`: clock icon, "Requested · Scroll of this Reel".
  - `preparing`: pending stripe and spinner arc, "Preparing · we'll let you know".
  - `ready`: `#14C79B` fill and check, "Ready · Open Scroll".
  - `failed`: border `#B23A0B`, text `#8A2C07`, retry icon, "Couldn't prepare · Retry".
  - `cancelled`: dashed border, `ink-2`, ✕.
- Drift: E06/E07 copies add `color`, `text-decoration:none` and `white-space:nowrap`; X01 uses radius 12 with no border; P03 reuses `.chip` as selectable reason chips (padding 0 14, `cursor:pointer`).

**SegmentedFormatSwitch → `FormatSwitch`** (`.seg`; 53 uses in 19 files: A01, Components, D01, E01, E02, E04, E05, E06, E07, E09, F01, H03, N01, Prototype, U04, V01, X01, X03, X04)
- `role="group"`, `aria-label="Format of this explanation"`. Container: padding 3, 2px ink, pill, gap 2. Buttons: min-height 38, padding 0 14, 14/600, `aria-pressed`; pressed = ink fill, cream text.
- Optional 14 icons: ▶ Reel, ≡ Scroll.
- States: Reel or Scroll selected; `preparing` (the unpressed option gets the pending stripe, "Scroll · preparing").
- Rules: "Same explanation, other representation. Tap only — never a swipe." It sits in the top bar in the same place on both formats, and it is a history push (N01).
- Large text: 18px, min-height 44.
- A11y: the 38 button height is below the 48/44 target; the hit area must be extended.

### 2.2 Labels and status

**Tag → `Tag`** (`.tag`; 199 uses in 34 files)
- Non-interactive. Inline-flex, height 26, padding 0 10, pill, DM Mono 11 caps +.06em, 1.5px ink border, paper fill, optional 12 icon.
- Variants (authored list "Only these labels appear in consumer UI"):
  - `part` (yellow): "Part 2 of 3"
  - `default`: "Related"
  - `hyp` (hypo, dashed accent, branch icon): "Hypothetical"
  - `cor` (corrected): "Corrected · 14 Oct"
  - `ai` (ink fill): "AI · Skeptic"
  - `moderator` (border and text `#0B7A5F`, shield): "Moderator"
  - `private` (lock): "Only you"
  - `shared`: "Shared with Ravi"
  - `sp` (on media or space: transparent, cream .55 border)
- Variants also drawn (outside the authored list):
  - topic ("Machine learning", "ML" on compact)
  - format plus duration ("Reel · 0:50" in part-yellow; "Scroll · 6 min" default)
  - "Speculative scenario" (dashed `#1B2FB8`) and `.tag.spec` "Speculative" (amber trio, D03/X02–X04)
  - "Another perspective", "What if", "Private", "Unavailable", "Optional · poll"
  - setting tag ("Sentence length · 4,096", yellow)
  - "1 what-if open" (D04)
  - "v2"
- "Never shown": scores, levels, streaks, "you learned", "documented", source counts, "seen", view or member counts, generation percentages.

**Banner → `Banner`** (`.banner`; 26 uses in 15 files: A01, C01, C02, C03, Components, E01, E02, E05, F01, H02, P01, P02, P03, R03, X01)
- Flex, gap 10, padding 12 14, radius 14, 2px ink, 14/1.4, 20 icon, bold lead word.
- Variants:
  - `offline`: "Offline. Your place is kept…"
  - `reconnecting`: paper-2 ground with spinner
  - `corrected`: corrected bg, `#8A2C07` border and pencil, "What changed" link
  - `accessEnded`: lock, "Asha stopped sharing this. Nothing from it is kept on your side."
  - `recordingPaused`: ink fill, cream text, pause icon, inline "Resume"
- A11y: no `role` on the authored banners; offline and reconnecting should be `role="status"`.

**ReceiptRow → `ReceiptRow`** (`.rc`, D05; `.rcpt` P02)
- Min-height 52, radius 12, padding 8 12, 18 icon.
- States: `preparing` (paper-2 with spinner: "Preparing · requested 19 Oct. We'll notify you."); `ready` (`#E3F6EF` with check and a "Download" sm button: "link expires in [N days]"); `failed` (corrected bg, retry, "Failed · nothing was exported" with Retry); `info` (clock: "Deletion in progress.").

**Presence → `PresenceIndicator`** (`.pres`; C01, C03, C04, D03, F01, H01, Prototype)
- `online`: 9px dot `#14C79B` (D03 adds a 1.5px `#0B7A5F` ring) plus the word "Online".
- `recent`: 9px ring, 2px `#0B7A5F`, "Recently active".
- `hidden`: "— (hidden)".
- "Availability only, as dot + word. Never what someone is watching." Optional and controllable; the default is an open decision.
- Drift: dot 7/8/9px; text 12/600 or 13 `ink-2` across copies.

**ProgressBar → `MediaProgress`** (`.prog` / `.bar`)
- On media: 4px track `rgba(255,251,240,.35)`, cream fill, radius 4, with mono "0:31 / 0:50".
- Scroll reading progress: a 4px `#2C46E8` bar across the top of the phone (E02, N01).

### 2.3 Content and conversation

**ContentCard → `ContentCard`** (Components; Keep, chat and share usage per Components)
- Radius 16, 2px ink, overflow hidden.
- `reel`: 104-high cobalt media area plus a part-yellow "Reel · 0:50" tag; body has a title 15/700 and topic 13 `ink-2`.
- `scroll`: a 104-high paper header with a 2px bottom border, "Scroll · 6 min" tag and Bricolage 18 title; body "Kept at 'Why squared?'".
- `private`: dashed 2px, paper-2, lock "Private" tag, "Sign in to see what Asha shared", "No title or preview until access is checked."
- `unavailable`: opacity .8, "Unavailable" tag, "This Reel was withdrawn. The message stays; the content doesn't."

**MessageBubble → `MessageBubble`** (`.bub`; 72 uses in 12 files: C02, C04, Components, D03, D04, H03, Prototype, R02, X01–X04)
- Padding 10 14, radius 18, 15/1.4.
- `them`: paper, 2px ink, bottom-left radius 6, sender name 12/600 above.
- `me`: accent, cream, bottom-right radius 6, mono status under ("Sent").
- `sending`: opacity .6, "Sending…".
- `failed`: paper, 2px `#B23A0B` border, ghost-sm "Not sent · Retry" (`#8A2C07`). "A failed message stays the same bubble; Retry re-sends the same request ID."
- `ai`: "AI · role" ink tag above, 2px **dotted** ink border, radius `6 18 18 18` (square top-left). "AI = black 'AI · role' tag + dotted outline + square top-left corner."
- `system`: centred 13/600 `#0B7A5F` with shield, "Moderator pinned a question" (also `.sysl` pill variants in C02, C03, C04, X02, X03).
- Max width: 280 (phone), 270/262 (drift), 460 (D03), 360 (D04, which also uses 14px and radius 16).
- Avatar (D04): 32 circle; AI avatar is an ink square of radius 8 with "AI" at 10px.

**SnippetCard → `SnippetCard`** (`.snip`; C04, D03, H03, Prototype, R02)
- `reelRange`: 44×56 ink thumb with a 3px yellow range bar, "Part 2 · 00:18–00:31" 14/700, a 12 subtitle, and a 44 accent play button `aria-label="Play this moment"`.
- `scrollPassage`: a `<blockquote>`, quote 14/1.45, mono source "Attention, slowly · Why squared?".
- `block`: "Try the diagram at 4,096 words" with a yellow setting tag.
- `correctedSource`: 2px `#8A2C07` border, Corrected tag, "Plays the mapped moment if one exists; otherwise 'This moment changed · Watch the revised Reel'".
- Drift: widths 258/290/380, radius 14/16, and a "Play" control that is an ink sm Button (D03) or a 30px tag-styled button (D04).

**BranchCard → `WhatIfCard` and `PerspectiveCard`** (`.brc` / `.pvc`; D03, R02, X01–X04)
- `whatIf`: 2px dashed `#2C46E8`, `#E6EAFF`, radius 16, padding 12 14–16. "What if" hyp tag plus "Speculative scenario"/"Speculative" tag, title Bricolage 17–19, line "Not established science — a thought experiment" in `#1B2FB8`, "Explore this →" (primary sm or link `.go`).
- `perspective`: 2px ink, paper, radius 16, `4px 4px 0 #111`, "Another perspective" (tag or mono), title, "Same subject, a different explanation — not a changed assumption.", "Explore this →".
- Relationship cue rule: "Dashed cobalt frame + branch glyph + the changed assumption in words. Lives only inside a shared exploration; never in the main feed."

**AISuggestion → part of `MessageBubble(ai)` plus `SuggestionActions`** (D04, R02)
- An AI bubble followed by "Explore this" and "Dismiss" (36-high sm buttons) and "Nothing is made unless someone chooses it."

**ShareSheet → `ShareSheet` on `BottomSheet`** (`.msheet` + `.grab`; 14 files: C02, C03, E01, E04, E05, E07, H01, H03, N01, P03, R02, U02, U08, X01)
- BottomSheet: absolute bottom, paper, `border-top 2px ink`, radius `28 28 0 0`, padding `10 20 28`, gap 14, grab 44×5 radius 9 ink at .25, `role="dialog"` with `aria-label`, scrim behind (the value varies, see §1.1), and a Close `IconButton`.
- ShareSheet options: four rows, min 56 (N01 `.opt`: 40×40 radius-12 icon box, 16/600), each with icon, title and subtitle:
  1. Send to a conversation
  2. **Explore with friends** (yellow row or yellow icon box: the promoted choice)
  3. Share a moment ("A time range, passage or block"; N01 appends the time "· 0:18")
  4. Copy link · Share elsewhere ("Copied ≠ delivered")
- Rule: sheets are never history entries; Back, Esc, Close and tap-outside close only the sheet.
- Platform: native system share sheet versus Web Share with copy-link fallback (V01).

**EpisodeBrowser → `EpisodeBrowser`** (`.ep`, `.nch`, `.nchip`, `.mk`; C04, D03, D04, R02, X01–X04)
- Expanded card (`.ep`, 104×100 or 112×100): 52-high thumbnail (SVG art), DM Mono 9.5 "Part N", title 12.5/700, marker badge top-right (20px pill: ✓ for "your marker", "Now" in yellow).
  - Current card: 3px border plus `3px 3px 0 #2C46E8`, `aria-current="true"`.
  - Preparing card: dashed `#7D7563`, pending stripe, `role="status"`, "Next part · Preparing · Not playable yet" (D03: "Ravi asked"), placed after a dashed divider and not selectable.
  - The row scrolls sideways; "the last card is cut off on purpose".
- Compact mode (when the player is collapsed): 44-high chips, radius 12. `1 ✓` (teal check), `2 · now` (ink fill), `3` (upcoming: border `#7D7563`, text `ink-2`), `Preparing` (dashed stripe). Plus a perspective chip ("Perspective · An information puzzle", globe) and a what-if chip ("What if · a portal", hypo).
- D04 variant: horizontal 162×64 card with a 48 thumbnail and mono "Part 1 · ✓ watched" / "Part 2 · Now" (now = ink fill, yellow label); upcoming border `#9A9382`.
- Semantics: "✓ is a playback/read-history marker for you — never 'complete' or understood… Only real sequential parts are numbered."
- A11y: descriptive `aria-label` ("Part 1, What it is, watched").

**MiniPlayerBar → `MiniPlayer`** (`.mini`; C04, Components, E03, Prototype, X01, X03)
- `collapsedPaused` (default): 60 high, radius 16, `#070A14`, 40 thumb radius 8, "Part 2 · The edge" 13/700, "Paused at 0:23" 12 at cream .78, 44 cream Play, Expand ⌃ and More ⋯.
- `keepListening`: `#1B2FB8` ground with a volume icon tile at `rgba(255,251,240,.16)`, "Listening · video hidden", "Part 2 · 0:31", Pause and Expand. "Audio only. Not counted as watching."
- Rule: "Collapsing or opening the keyboard pauses and keeps the playhead. Visible-viewing recording stops."
- Platform: background audio is native-only; web needs Media Session parity (not designed).

**CaptionOverlay → `MediaCaption`** (10 files)
- `rgba(17,17,17,.82)`, radius 12 (10 compact), padding 10 12, 16/500/1.4, cream text, emphasis in bold `#FFE44D`. Captions keep two lines on compact.

**ThreadRail → `ThreadRail`** (`.trow`; D01, E05; tablet aside in V01)
- Mono "This thread", title Bricolage 24.
- Rows: min 64, padding 10 12, radius 14, 2px ink. `current` = ink fill, cream, part tag, "· now", `aria-current="step"`. `next` = yellow fill with →. `upcoming` = paper. `related` = dashed.
- Then a "Same explanation as a Scroll: Open Scroll · 'Attention, slowly'" primary sm button on a paper-2 block, a Talk shortcut card, and "Opening Talk keeps this Reel paused at 0:31 — only one player runs."

### 2.4 Inputs and settings

**TextField → `TextField`** (Components, `.field` H01/H03)
- Label 14/600 above, gap 6. Input min-height 48, 2px ink, radius 12, padding 0 14, 16px Instrument, paper.

**WhatIfInput → `TextArea` variant `hypo`**
- 2px dashed `#2C46E8`, `#E6EAFF`, radius 12, padding 12 14, 16/1.4, `resize:none`.

**Composer → `Composer`** (`.comp`; C02, C04, R02, X01–X04; D03, D04)
- Optional "What if…" dashed hypo button, then a pill input (min 48, 2px, padding 0 16–18, 15–16px, visually-hidden label "Message the thread" / "Reply in this thread"), then Send (primary Button with plane and label on D03, or a 48 accent IconButton on D04).

**Switch → `Switch`** (`role="switch"`, `aria-checked`; 25 uses in C03, C04, Components, D05, E03, F01, H03, P01, P02, U08)
- 56×32, 2px ink, pill. On = `#2C46E8` with a cream 22 thumb at right 3. Off = `#F4EDD8` with an ink 22 thumb at left 3.
- Always paired with a `<label for>` carrying a bold title and a 13 helper.

**SettingsRow → `SettingsRow`** (`.lrow` drift ×5; F01, P01, P02, U02, U03)
- Min-height 56 (58/64 in copies), `border-bottom 1px #D9D1BC`, label block with 15/700 title and 13 helper, plus a trailing control.

**SettingsCard → `Card` variant `settings`** (D05 `.card`)
- 2px ink, radius 18, padding 20, gap 12, h2 Bricolage 22/800 −.01em. `danger` variant: border `#B23A0B`, title `#8A2C07`.

**SettingsNav → `SideNav`** (D05 `.sn`)
- 280 column on paper-2; title Bricolage 30/800; rows min 48, radius 12, 15/500; current = ink fill, cream, 700; footer "Signed in as @asha.k".

**PollCard → `PollCard`** (D04, R03)
- "Optional · poll" tag, question 15/700, options (`.opt`: 44 min, 2px, radius 12, 16px radio circle), "Skipping it changes nothing for you."

**ModeratorTools → `ToolList`** (D04)
- Shield label in `#0B7A5F`; tool rows 44 min, 1.5px `#D9D1BC` border, radius 12, 16 icon; "Shown only to moderators."

### 2.5 Navigation

**NavBar → `TabBar`** (instance source NavBar.html; `dc-import name="NavBar"` 83 times in 25 files)
- `<nav aria-label="Primary">`, a floating pill: padding 6, gap 4, radius 26, centred in a 390×96 slot (the pill is 320×68).
- Items: 74×56 buttons, radius 20, icon 22 plus label 11/600/1 +.01em, gap 4.
- Tabs: **Explore · Universe · Talk · Keep**.
- Props: `active` ∈ {explore, universe, talk, keep, none}; `tone` ∈ {paper, space}; `unread` (boolean).
- Active item: `#2C46E8` fill, cream text, `aria-current="page"`. Inactive: transparent, `rgba(255,251,240,.78)`.
- Pill: paper tone `#111111` with `0 10px 24px -12px rgba(17,17,17,.55)`; space tone `#0B1A2E` with `0 0 0 1px rgba(255,251,240,.22), 0 12px 28px -10px #000`.
- Unread changes the label to **"Talk •"**, which also becomes the `aria-label`.
- Compact (≤360): icon-only items 56×48, radius 18, pill padding 5, radius 24, labels move to accessible names.
- Usage: `active="universe" tone="space"` on U01–U04, U06–U08 and R01; talk on C01 and C03 (unread in C01); keep on S01 **and P01** (Account lives under Keep on mobile; S01 has an "Account and settings" button).
- Hidden (no NavBar) on C02, C04, E03, F01, H01–H03, P02, R02, R03, U05 and X01–X04: detail stacks, threads, sheets and formation.

**NavRail → `NavRail`** (tablet `.tnav`, desktop `.rnav` / `.rail`)
- Tablet: 76 wide, ink, padding 28 0, items 60×60 radius 16, label 10/600.
- Desktop: 88 wide, ink, padding 20 0, gap 8, items 72×64 radius 18, label 11/600; "K" Bricolage 800 22 `#FFE44D`; account avatar 40 circle at the bottom (`margin-top:auto`) linking to settings.
- D03 drifts: 72×60 radius 16, no K mark, teal 44 avatar with a 2px cream border.
- Space tone (D02): `border-right 1px rgba(255,251,240,.18)`.

**TopBar → `TopBar`**
- Back `IconButton` (plain on Scroll, `onMedia` on Reel), `FormatSwitch`, topic `Tag`.
- Positioned `left 12–16, right 16, top 52–56`, space-between. A Reel at the feed root has no Back (N01 step 1).

**KeyboardLegend → `KeyHints`** (`.kbd`; D01–D03)
- DM Mono 11, 1.5px border, radius 6, padding 2 6. D01 footer: "↑ ↓ subject · ← → thread · Space play / pause · Esc close". D02: "Tab next body · Arrows pan · + − zoom · Enter open". D03: "← → part · Space play · M share moment · Esc close".
- Desktop/web only. Also hover tooltips for icon buttons (V01).

**OutlineTree → `OutlineList`** (D02 `.ol`; U02 list, U08 `.orow`)
- `<ul>` tree; rows min 44, radius 10, 15/500; expandable parent (`aria-expanded`, caret 14); `aria-current="true"` on planet (paper-2 fill, 700) and region (yellow fill, 700); room "· station" row. "Universe always has the list view outline."

### 2.6 Spatial kit ("2D layered, renderer-agnostic")

**`OrganisingStar`, `Planet` (family, seed), `Planet` state `dormant`, `Dust`, `RoomStation`, `Ship` (with trail), `Orbit`, `Route`**: values in §1.2. Labels follow `SpaceLabel`.

**SpaceLabel → `SpaceLabel`**
- "Label on a baseline 12px under the body, Instrument 600 13/16 cream. If two labels collide, the farther one gets a leader line. Max 2 lines; never on top of another body." On close-ups (U03, U04, U07) the label is a pill chip `rgba(4,10,23,.86)`, height 26.

**RegionPin → `RegionPin`**
- Octagon, default or selected only, hit area 48 (`.hit` 48 circles: U01–U04, U06–U08); no seen or visited state.

**FloatingControls → `SpacePill`** (`.pillsp` / `.pillgh`, `.btn.sp`; U01–U04, U06, U08, D02)
- Cream pill, min 44, padding 0 16, 14/600, optional back chevron ("Universe") or teal dot ("Lately", `aria-pressed`).
- Ghost variant: transparent with a 1.5px cream .6 border ("List view").
- "Cream pills only. 'List view' opens the accessible outline of every system/planet/region."

**ZoomControls → `MapZoom`** (D02)
- Two `IconButton(onSpace)` buttons: "Zoom in (+)" and "Zoom out (−)".

**TopicCard → `PlaceCard`** (D02 docked; U04)
- 2px ink, radius 18, padding 16, hero shadow `6px 6px 0 #2C46E8`.
- Contents: mono "A Reel · in Deployment", close 44, Bricolage 24 title, 15 description, `Button(ink sm)` "Open", `Button(ghost sm)` "More in Deployment".

### 2.7 Documentation-only elements (not product components)

These should not ship in `packages/ui`: the "Prototype · design data" badge (yellow, mono, radius 6), the N01 stack chip (`.stack`), the `.cap` / `.note` / `.notes` annotation cards, the device frames (`.phone`, `.dev`), the Main audit cards with coloured offset shadows, and the Navigation-rules cards (their content is spec, see §3).

### 2.8 Summary list (proposed `packages/ui` names)

There are 55 proposed top-level components (plus 4 named sub-parts: `OptionRow`, `EpisodeCard`, `EpisodeChip`, `ThreadRow`) across 6 groups:

| Group | Components |
|---|---|
| Actions | `Button`, `IconButton`, `ActionRail`, `ActionStrip` (scroll / thread / desktop), `ContinueTab`, `ScrollEndCard`, `RequestStatusChip`, `FormatSwitch` |
| Labels and status | `Tag`, `Banner`, `ReceiptRow`, `PresenceIndicator`, `MediaProgress`, `ReadingProgress` |
| Content and conversation | `ContentCard`, `MessageBubble`, `SystemLine`, `Avatar`, `SnippetCard`, `WhatIfCard`, `PerspectiveCard`, `SuggestionActions`, `BottomSheet`, `Scrim`, `ShareSheet` (`OptionRow`), `EpisodeBrowser` (`EpisodeCard`, `EpisodeChip`), `MiniPlayer`, `MediaCaption`, `ThreadRail` (`ThreadRow`) |
| Inputs and settings | `TextField`, `TextArea`, `Composer`, `Switch`, `SettingsRow`, `Card`, `SideNav`, `PollCard`, `ToolList` |
| Navigation | `TabBar`, `NavRail`, `TopBar`, `KeyHints`, `OutlineList` |
| Spatial (`scene` folder) | `OrganisingStar`, `Planet`, `Dust`, `RoomStation`, `Ship`, `Orbit`, `Route`, `SpaceLabel`, `RegionPin`, `SpacePill`, `MapZoom`, `PlaceCard` |

Platform-specific behaviour to carry in the components:

| Concern | Where |
|---|---|
| Gestures | Vertical swipe = subject; horizontal = thread; swipes owned by the article, block or thread layer; `ContinueTab` respects a 24px OS back-edge inset; blocks inside a Scroll must not trap page scroll (N01 device questions). The blueprint says Gesture Handler 3 plus Reanimated 4 decide this on the UI thread. |
| Media | `MiniPlayer` pause-on-collapse and keyboard; audio-only keep-listening (native background audio); single active player on desktop; Reel restored paused after a detour, playing after an overlay. |
| Keyboard (web and desktop) | ↑↓ subject, ←→ thread or part, Space play/pause, Esc closes overlays, M share moment, Tab/Arrows/+/−/Enter on the map; focus order top bar → content → actions → thread → nav; landmarks nav / main / aside. |
| Platform | Native share sheet vs Web Share plus copy fallback; text selection in Scrolls on web; browser history mirrors the stack; haptics on Save (native); hover tooltips (web). |

---
## 3. Navigation model (NavBar, N01, Components "Navigation rules", V01, D01–D05)

### 3.1 Top-level destinations

**Explore · Universe · Talk · Keep.** Main §04 says this "moves from Cable / Atlas / Keep / Ask… Ask lives on the encounter itself."

| Tab | Root | Notes |
|---|---|---|
| Explore | The Reel/Scroll feed (E01/E02) | Icon: TV |
| Universe | Personal universe map (U01) | Space tone NavBar; rooms appear here as stations (R01 has `active="universe"`) |
| Talk | Conversation inbox (C01) | Content threads and room rows live here. The unread state is a bullet in the label ("Talk •"), never a count |
| Keep | Keep library (S01) | On mobile also hosts **Account & settings** (S01 header button "Account and settings"; P01 has `active="keep"`) |

On desktop, Account is the avatar at the bottom of the rail (D01–D05). Main's open decisions still list the tab labels ("Talk" vs "Conversations", "Keep" vs "Saved") and "four tabs vs three plus a header button".

Tab container by size:

| Size | Container |
|---|---|
| ≤360 compact | Icon-only floating pill |
| 361–599 phone | Floating pill with labels (`TabBar`) |
| 600–1023 tablet | 76px rail (`NavRail`) |
| ≥1024 desktop | 88px rail with "K" logomark and account avatar |
| Landscape phone | No tab bar; a "Menu" ☰ `IconButton` at top-left of the video. Not described anywhere else |

The tab bar is hidden inside detail stacks: conversation (C02), content thread (C04), what-if (X01–X04), share flows (H01–H03), room discussion and activity (R02, R03), privacy (P02), friends (F01), formation (U05) and the E03 block gallery.

### 3.2 The three axes (authored rules)

- **↑ ↓ subject.** Swipe up, the ↓ key or the "Next subject" button gives the next subject. Swipe down or ↑ gives the previous subject (Reels only; "Scrolls read upward instead"). In a Scroll the next subject comes **only after the end**: "reading momentum never does this." History: push.
- **← → thread.**
  - Swipe left, →, or the right-edge tab gives the next step: Part N (solid yellow) or Related (dashed).
  - Swipe right, ←, or the left-edge tab gives the previous step. "Not the same as Back." History: push.
  - "Every arrow points to its destination: next is on the right."
- **Format.** The Reel ⇄ Scroll switch is "same explanation, other format; each keeps its own position." It is tap only and a history push.
- **Back = your history.** System gesture or button, browser Back and the top-bar chevron all pop one step "through *your own* path; exact position restored (Reel paused, Scroll anchor, branch, camera)."
- **Overlays close first.** Esc, close, tap-outside or Back while a sheet is open closes only the overlay ("A Reel that was playing keeps playing"). Share, Ask, menus and the trail sheet "never enter history."
- **At a tab root**, Back follows the platform: Android leaves the app, web goes to the previous page. This is still an open decision: "platform convention vs returning to the previous tab — needs device testing."
- **Switching tabs:** "each tab keeps its own stack and position." Stacks survive app backgrounding.
- **Commands vs navigation:** `CMD subject.next / previous · thread.continue / previous · format.switch`. "Back is client navigation: no command, no evidence."

### 3.3 Restore semantics

| Destination | What is restored |
|---|---|
| Reel | Paused at the playhead after a real detour; plays on after an overlay |
| Scroll | Anchor block plus offset; the restored card flashes `content.highlight #FFF4C2` |
| Branch | The node |
| Map | The camera; the Ship marks the camera return point and its trail shows the route |

N01 worked example, with the stack at each step:

| Step | Action | Stack |
|---|---|---|
| 1 | Watch Part 1 | `P1 Reel@0:31` |
| 2 | Switch to the Scroll (a format switch is a history entry) | `P1 Reel@0:31 › P1 Scroll@end` |
| 3 | Part 2 → | `… › P2 Reel@0:18` |
| 4 | Share opens | Stack unchanged: "sheets aren't history" |
| 5 | Sheet closed | Part 2 plays on: `… › P2 Reel (playing)` |
| 6 | Back | `P1 Reel@0:31 › P1 Scroll@end ◂ you are here` |

Further Back from step 5: Back #2 gives Part 1 paused at 0:31 with captions as left. Back #3 gives "whatever came before Part 1 — the previous subject at its own position, or the Explore root." "Swipe right on Part 2" instead gives Part 1 as a **new** history entry, not a rewind.

### 3.4 Routes and deep links (authored in N01 "Route & origin")

"Each history entry is a route plus a position":

| Route | Meaning |
|---|---|
| `/e/:id?t=31` | Encounter or Reel at a time |
| `/s/:id#block` | Scroll at an anchor block |
| `/x/:id/:node` | What-if exploration at a node |
| `/universe/…?cam=` | Universe camera |

"Deep links start a fresh stack with Explore root beneath them." "Web history mirrors the stack; native uses the platform back."

Implied by other frames but **not given a route**:
- content thread (C04) and thread invitation (C03)
- conversation (C02)
- room and room thread (R01, R02, D04)
- Keep item resume (S02)
- share landing (H02, "available exact revision")
- snippet or moment (`Part 2 · 00:18–00:31`, passage, block plus settings)
- friend universe visit (U06)
- system, planet and region (U02–U04, probably under `/universe/…`)
- settings and privacy (P01, P02)
- export download link ("expires in [N days]")

### 3.5 Desktop composition (D01–D05, 1440×900; all with the 88px ink rail at the left)

| Frame | Layout, left to right | Notes |
|---|---|---|
| **D01 Explore** | Rail · stage on `paper-2` · aside 368 "This thread" | The stage has a top row (Previous subject button, Reel/Scroll switch, topic tag), the 430×720 Reel player, an action column (Like · Save · Share · Ask) to its right, and a 44px footer with a "Next subject" ghost button and key hints. The aside lists Part 1 (current, ink), Part 2 (yellow, →), Part 3, Related (dashed), an "Open Scroll" primary button, and a Talk shortcut card (Ravi's last message, "Open"). "Opening Talk keeps this Reel paused at 0:31 — only one player runs." No edge tab on desktop: the aside replaces it |
| **D02 Universe** | Rail (space, cream .18 right border) · full-height map · aside 380 (cream) | The map has a "‹ Universe" pill, a "Lately" pill, the system H1 and mono "A system", planets with labels, a selected planet with a dashed yellow ring, the ship, the room station, a route label "Route to Backend systems →", zoom ± and key hints. The aside holds the "Outline · list view" tree and a docked `PlaceCard` (A Reel · in Deployment, Open / More in Deployment) |
| **D03 Talk + What-if** | Rail · content column 560 · conversation (flex) | The content column has the thread header ("Black holes", "A content thread · Asha, Ravi, Meera", Map), the episode browser, a 270×480 player, the action strip and key hints. The conversation pane has a header with presence, messages, a moment snippet, a what-if card, a perspective card and the composer (What if… · input · Send) |
| **D04 Room** | Rail (Talk active) · room column 280 · main · "Room extras" 260 (collapsible) | The room column has a space-ground header (station, "Room · station on your map", room name), a description, Moderator / AI · Explainer / AI · Skeptic tags, "AI inhabitants are always labelled. They suggest; people choose what gets explored.", the room thread list (pinned first) and New thread / Leave. Main has the thread header ("1 what-if open", Branch map), the episode row, a 312 player plus action strip, and a `aria-live="polite"` conversation with a what-if card, an AI suggestion with Explore/Dismiss, and the composer. Extras holds an optional poll and moderator tools |
| **D05 Privacy** | Rail (avatar current) · settings nav 280 (paper-2) · two-column card grid | Cards: Recording (switch), History & export (receipt rows), Clear exploration (Removed / Stays columns plus an example receipt), Delete account (danger card) |

Main's coverage table adds desktop rules that are not drawn as frames:
- E02 Scroll "680px measure, actions in left rail"
- E03 blocks widen to 880
- E04 Ask is a "popover anchored to Ask"
- H01 Share is a "popover"
- E06 has the "switch in player header"
- U03 has the "planet fills left 2/3"
- U04 "card docks right"
- U06 has a "visitor bar"
- U08 has "search in the side panel"
- C01 inbox is the "D03 left column", C02 the "D03 centre", X01 the "D03 right column"
- S01 is a "two-column grid + detail pane"
- F01, P01 and P02 follow the "D05 pattern"
- A01 is a "centered 480px card on space ground"
- H02 is a web landing at 1440
- P03 is a popover or dialog

### 3.6 Responsive rules (V01)

| Width | Behaviour |
|---|---|
| ≤360 (compact 320×690) | Icon-only nav (56×48 items); action-rail buttons 44 with labels moved to accessible names; captions keep two lines; Reel title 24/26; the topic tag abbreviates to "ML" |
| 361–599 (phone 390×844) | Floating pill nav; full rail with labels |
| 600–1023 (tablet 834×1112) | "Nav becomes a rail; thread becomes a column." Text column ≤34em (500px); aside 212 "This thread" |
| ≥1024 (desktop) | Rail, content and side panel; **one active player**; 680px reading measure |
| Landscape phone (844×390) | Reel video 600 wide and 300 tall at left, with captions **under** the video. Right column: title (Bricolage 18), 4-column action grid with labels, "Part 2 →" (yellow), "Next subject ↓" (ghost-on-dark). Menu button replaces the tab bar |
| Larger text (200%) | Labels become Instrument 600 sentence case; the action strip becomes a 2×2 grid of text buttons; the title wraps and never truncates; body 26/38 |
| Reduced motion | §1.12 |

Keyboard and screen reader (V01):
- "Every swipe has a key and a visible button (↑↓ subject, ←→ thread, Space play)."
- "Focus order: top bar → content → actions → thread → nav."
- "Landmarks: nav, main, aside."
- "Universe always has the list view outline."

Platform (V01):
- **RN native:** system share sheet; back edge = Back (one step through your own history, N01); haptics on Save.
- **RN Web:** Web Share with copy-link fallback; text selection in Scrolls; browser history entries; hover tooltips for icon buttons.

N01 also lists things that need a touch prototype on real devices:
- Scroll end-boundary flick behaviour.
- Block drag vs page scroll.
- OS back-edge vs in-app swipe (24px inset), in landscape and with larger text.
- Closing a sheet resumes playback without an audio jump.

---
## 4. Operator surface (Operator.html), kept separate from consumer UI

### 4.1 What it is

The page header reads "OPS · Appendix · not consumer UI". Its own description: "Private tooling, never shown in the consumer app… **Proposed, not deployed.** Panels below are wireframes: values are placeholders, not measurements. Dashboards and saved queries live in source control under `ops/observability/`."

The proposed stack is **Grafana + Loki + Tempo + Alloy + a Prometheus-compatible metrics store + a narrow, audited, read-only domain-receipt query.** It uses its own neutral greyscale register (§1.3) and shares no components with the consumer app.

### 4.2 The six views and the data they imply

| # | View | Sources named | Panels (data implied) | Guardrail stated |
|---|---|---|---|---|
| 1 | System overview | metrics store · Loki (service/env/severity) · exporter health | Service health (api · workers · realtime up/down); queue wait age by queue; ingestion and projection lag; request latency p50/p95; provider failure and **unknown** rate; media disk; exporter or collector lag | "Unknown outcomes are their own series, never folded into success or failure." |
| 2 | Journey search | Loki structured fields · Tempo trace links · scoped receipt query | Search by `operationId \| receiptId \| encounterId \| demandId`, last 24h; chain `command.admitted` (ms) → `job.attempt` (linked by `causationId`, outcome) → `receipt.committed` (trace ↗) | "Search by account needs a separate authorised resolution step; handles and emails never appear in logs." |
| 3 | Content production | Loki · Tempo · production decision records | Supply decision (reuse · join · adapt · create); where it waited (admission → queue → provider → checks); provider usage and cost (known · estimated · unknown); publication checks (passed · refused with `reasonCode`) | "One shared job can serve several private requests; the links stay in scoped records, not a user list in logs." |
| 4 | Universe change | Cartographer decision records · scene projection | Evidence revisions (`evidenceRevisionId…`); proposal operations (`form_planet · add_region…`); validator reasons (applied · stale · refused + `reasonCode`); committed delta → scene revision (`deltaId → sceneRevision · fallback?`) | "**No psychological interpretation panel.** This view explains a change, never what a person 'is'." |
| 5 | Realtime delivery | outbox records · Socket.IO adapter logs · Tempo | Message receipt (`receiptId`, committed at); outbox publish attempts and outcome; reconnect catch-up cursor from → to; membership refusals (`reasonCode`) | "Message bodies are omitted everywhere in this view." |
| 6 | Privacy & diagnostics health | privacy receipts · retention jobs · collector stats | Scoped erasure completion (pending · complete · failed); remaining store obligations (db · logs · traces · exports · dead-letter); retention jobs (last run, outcome); dropped diagnostics and known gaps (count; sampled / expired / erased) | "Erased data shows as 'erased', never reconstructed from logs." |

**Worked example**, "Asha requests a Scroll and it never appears":

`demand.admitted` → `supply.joined` → `provider.attempt_sent` (attemptId · tool/model version) → `provider.outcome_unknown` (timeout) → **no `asset.published`** ("reconciliation pending — do not blindly re-issue a paid generation").

If publication did succeed, the client is stuck on "Preparing": follow outbox notice → socket reconnect cursor → client cache refresh. "The investigation never needs Asha's request text."

**Safe fields:** `schemaVersion, event, severity, timestamp, service/module, environment, build revision, outcome, reasonCode, operationId, requestId, commandId, causationId, correlationId, encounterId, demandId, jobId, attemptId, proposalId, deltaId, receiptId, contentRevisionId, traceId/spanId, policy/model/prompt/tool/schema versions, durationMs`. "Opaque IDs are still personal metadata: their mappings and copies are included in erasure."

**Never logged:** message or chat bodies, request text, prompts and responses, emails, phones, handles, credentials, session tokens, signed URLs, SQL bind values, raw pointer or keystroke data.

**Labels and retention:** the only Loki labels are `service`, `environment` and `severity`; every ID is a structured field. Debug capture (when enabled) 48h, operational logs 14d, traces 7d, domain records per product retention policy. "All durations proposed; size against the actual VPS before launch."

### 4.3 Mapping to the blueprint's Tier 0 observability

The architect brief (`~/Desktop/reports/KnowScroll blueprint changes for the architect.md`, item 22) says: "Tier 0 replaces 'searchable Grafana/Loki/Tempo/Alloy as operational acceptance'." Tier 0 consists of:
- journald with persistent 14-day retention
- durable decision records
- an `ops` schema of allowlisted views
- Grafana on PostgreSQL through a SELECT-only role
- `pnpm journey <id>`

Log search and a trace backend are added only on named triggers. **So the Operator appendix describes the deferred stack, not Tier 0.** The views map as follows:

| Operator view | Tier 0 home | Gap or adjustment |
|---|---|---|
| 2 Journey search | **`pnpm journey <id>`** (cli) over `ops` views: command receipts → job attempts (causation) → receipts / decision records. This is the "journey inspector" | "Trace ↗" links and Loki field search are not in Tier 0. The chain must be reconstructable from PostgreSQL rows alone. Keep the "authorised resolution step" for account lookup as a separate, audited cli path |
| 3 Content production | `ops` views over production decision records and the attempt ledger (supply decision, waits, provider usage known/estimated/unknown, publication checks) | Fits Tier 0 directly; "where it waited" needs timestamps on every stage row |
| 4 Universe change | `ops` views over Cartographer decision records (evidence revision ids, proposal ops, validator reasons, delta → scene revision) | Fits; keep the "no psychological interpretation" rule as a view allowlist rule |
| 5 Realtime delivery | Message receipts and outbox rows in PostgreSQL. The report recommends pg-boss in-transaction enqueue as the work outbox plus `pg_notify` hints and revision catch-up. Socket.IO adapter logs go to journald | Reconnect cursor data must be persisted or logged to journald; no Tempo |
| 6 Privacy & diagnostics health | `ops` views over privacy receipts, the erasure registry and retention-job runs | "Dropped diagnostics / collector stats" have no collector in Tier 0. Replace them with journald rate-limit or drop counters, or remove the panel |
| 1 System overview | Grafana on PostgreSQL: queue age (pg-boss tables), projection lag (revision tables), provider failure/unknown rates (attempt ledger) | **Request latency p50/p95, service up/down, media disk and exporter health need a metrics source Tier 0 does not define.** Options: derive latency from structured journald lines (no query engine), add a host check, or accept the gap until a named trigger |
| Labels & retention | journald 14d matches "operational logs 14d" | "Traces 7d" and "Loki labels" have no Tier 0 equivalent; "debug capture 48h" needs a journald namespace or a separate file. The safe-field and never-logged lists carry over unchanged as the typed diagnostic-event catalogue (report mechanism 8: "unknown events or fields fail to compile") |

Separation rules to keep:
- The Operator surface is not part of `packages/ui` and not reachable from the consumer app or its routes.
- It may show `policy/model/prompt/tool/schema versions`, `reasonCode` and decision records. None of these may appear in consumer UI; the consumer only sees the glyph-plus-word states: Requested · Preparing · Ready · Couldn't prepare · Cancelled.
- Consumer state to ops event, for the journey inspector: Requested = `demand.admitted` receipt; Preparing = `supply.joined` / job queued / `provider.attempt_sent` / `provider.outcome_unknown`; Ready = `asset.published` plus outbox notice; Couldn't prepare = terminal attempt failure or publication refusal; Cancelled = cancellation receipt.

---

## 5. Conflicts and ambiguities

### 5.1 Against the product rules

1. **A third epistemic label.** Main: "Only two epistemic labels survive… Hypothetical and Corrected." Components' "Only these labels appear in consumer UI" list agrees. Yet Components itself draws a dashed-cobalt "Speculative scenario" tag, while D03 and X02–X04 draw a different amber `.tag.spec` "Speculative" (`#FFF4C2/#8A5A10/#6B4508`, no token). Decide whether Speculative is a label and, if so, give it one style and a token.
2. **The tag allowlist is not followed.** Frames also show topic, format+duration, "Another perspective", "What if", "Private", "Unavailable", "Optional · poll", a setting tag ("Sentence length · 4,096") and **"1 what-if open"** (D04). That last one is a count in consumer UI next to the "never show counts" rule; replace it with wording such as "A what-if is open".
3. **Reel and Scroll are not drawn as equals.**
   - The Reel content card gets full-bleed cobalt media and a **yellow** (continuation-colour) tag; the Scroll card gets a plain tag.
   - Desktop has only a Reel frame (D01 claims E01/E02/E05 coverage). The Scroll desktop exists only as a sentence that puts its actions in a **left** rail, while the Reel's are on the right.
   - D01 adds a louder primary "Open Scroll" button besides the switch, with no mirrored Scroll → Reel.
   - Only "Scroll · preparing" is drawn as a switch state.
   - The feed lands on Reels; the Reel/Scroll mix in Explore is unspecified.
4. **Peer requests may be exposed.** D03's preparing episode says "Ravi asked". The Operator says one job serves "several **private** requests". Decide whether a request made inside a shared thread is attributable.
5. **Presence defaults.** D03 shows "Ravi · Online / Meera · Recently active" in the header, but presence is an open decision ("Recently active vs off for new accounts; online is opt-in"). "Recently active" also reveals activity timing. Build it opt-in, with no default exposure.
6. **Seen and progress markers in shared spaces.** Episode ✓ (Components, C04) and "Part 1 · ✓ watched" (D04, a *room* thread) are defined as "your marker". No frame shows the other members' view of the same row. Specify that peer markers are never rendered and that the API never returns them.
7. **Planet size has no defined meaning.** D02 planets differ in size (r34 vs r46) while "Planet size never encodes amount watched". If size tracks content or regions, readers will still read it as "how much I watched". Define what size encodes, or fix it.
8. AI identifiability is consistent: ink "AI · role" tag, dotted bubble, square top-left corner, "AI" square avatar, "AI inhabitants are always labelled", and "Nothing is made unless someone chooses it." No conflict found. Fabricated activity: all people are marked as authored examples. No conflict in scope.

### 5.2 Inconsistencies between frames

9. **Does Share pause playback?** N01 step 4 says "Part 2 pauses underneath", but the rules table says "A Reel that was playing keeps playing" and the restore note says "plays on after an overlay". Step 5's progress moved from 0:18 to 0:20.
10. **Yellow means too many things.** It is the Part/continuation cue, the pressed Like/Save state, the selection ring (N01 Share, R02, X04), the space focus ring, the selected outline row (D02), the "Now" badge, the promoted "Explore with friends" row, the setting tag and the D03 "Share moment" emphasis. This undermines "four moves that must never look alike."
11. **Saved state.** It is a yellow fill plus filled glyph in Components and C04, but an ink-filled glyph with no yellow in D04. The D04 strip also drops the More (⋯: keep listening, report) item.
12. **Icons.**
    - "Share a moment" is an H-bar in Components (three path variants) but a clock in the N01 sheet.
    - "Perspective" is a globe in Components but two circles in X01.
    - Every V01 Ask icon (compact, tablet, landscape) is the Talk bubble without "?", so Ask and Talk become indistinguishable. D01 draws Ask with "?" plus a dot.
13. **Three episode-card anatomies.**
    - Vertical 104×100 (D03) or 112×100 (C04) with a badge.
    - Horizontal 162×64 with "✓ watched" text (D04).
    - Upcoming border `#7D7563` vs `#9A9382`.
14. **Desktop rail drift and avatar colours.** D03 uses a different rail (72×60 radius 16, no "K", a teal 44 avatar); the others use 72×64 radius 18, "K", and a yellow 40 avatar. Asha's avatar is yellow in four frames and teal in one. Avatars reuse topic-family hues (`#6E86FF`, `#F2B84B`, `#FF8A5B`) and have no token.
15. **Rooms have no clear tab owner.** Mobile R01 sits under Universe, desktop D04 highlights Talk, and C01 lists rooms in Talk. Back-at-root and deep-link behaviour depend on this.
16. **Account sits in different places.** It lives under Keep on mobile (P01 `active="keep"`) but is a rail avatar on desktop.
17. **Space controls.** "Cream pills only", yet "List view" is an outline pill. "Lately" with `aria-pressed="true"` (Components) and `"false"` (D02) look identical, so the toggle has no visible pressed state.
18. **Token sheet vs frames.**
    - Radius "tag = 6" vs the pill `.tag`; cards drawn at 16 vs a 14 token; 12 and 18 unnamed.
    - The 14px spacing step is used widely but is not on the 4-base scale.
    - Reel titles are drawn at 20–30px vs `display.l` 32/36, and the desktop +15% rule is not applied (D01 title 30).
    - Measure is "~62ch" (Main) vs "30–34em" (Tokens).
    - Scrims use five opacities (.35–.55).
    - The mini-bar ground `#070A14` ≠ `space.0`.
    - Off-token greys `#7D7563`, `#9A9382` and `#8F887A`, plus `#E3F6EF`.
19. **Touch targets below the 44 floor.** Segment buttons 38, D04 pause 36, D01 footer button 36, D04 suggestion buttons 36, D04 snippet "Play" 30.
20. **Accessibility details.** The NavBar unread label "Talk •" becomes the accessible name. 31 Back buttons are named "Back", not "Back to …". Offline and reconnecting banners have no `role="status"`. The cobalt focus ring (`#2C46E8`) is invisible on cobalt Reel media and on accent fills without the offset; no rule covers focus on media.
21. **The coverage table promises panes D03 does not draw.** C01 is said to be the "D03 left column" and X01 the "D03 right column", but D03 draws only content plus conversation. D04 uses three panes beside the rail, beyond V01's "rail + content + side panel". Collapse rules between 1024 and 1439px are undrawn.
22. **Route collision with the blueprint.** N01 uses `/s/:id#block` for Scrolls; the blueprint reserves `/s/:token` for API-rendered share previews.
23. **The Operator stack** (Grafana, Loki, Tempo, Alloy, Prometheus) is superseded by blueprint Tier 0 (§4.3). Latency, up/down and disk panels have no Tier 0 source.
24. **Export and documentation slips.**
    - Main, Tokens and Components overflow their authored heights, so the Main H1 collapses in `html/`.
    - The README says "four clickable journeys", Main says five.
    - Main's `<title>` says "design v1".
    - V01's canvas height (1540) ≠ its content div (1480).

### 5.3 Underspecified or missing states

25. **Motion.** Only `motion.sheet` has an easing. "Yellow rail leads" (thread) is undefined. Camera is a range (600–900ms). There are no spring or Reanimated parameters and no definition of "page slides up" distance.
26. **Larger text.** "Body 26px at 200%" is not linear (18×2 = 36). The scaling function between 100% and 200% and the reflow trigger are undefined.
27. **Z-order and toasts.** There is no z-index anywhere, and no toast or snackbar component (e.g. a "Copied" confirmation or a Save receipt). Banners are only inline.
28. **Landscape menu.** The phone landscape "Menu" (☰) has no content or behaviour spec. Tablet landscape is not drawn.
29. **Missing component states** (system level):
    - `FormatSwitch`: failed or unavailable
    - `TabBar`: hover, focus, pressed, and an unread style other than "•"
    - `IconButton`, `Tag` and rows: focus-visible
    - `Switch`: disabled or pending, needed because "recording" is a command with a receipt
    - `ContentCard` and `ThreadRail`: loading or skeleton
    - `SnippetCard`: revoked or unavailable (only "corrected" is drawn)
    - `MiniPlayer`: buffering and error
    - `Composer`: offline or queued (the banner promises "will send when you reconnect")
    - `Banner`: dismissal and stacking
    - `BottomSheet`: keyboard-open and long-content scroll
    - `OutlineList`: empty and no search results
    - `PlaceCard`: loading
    - `Button` busy state in non-primary variants
30. **Privacy receipts** use `[N days]` placeholders, and the export "expires in [N days]" value is undecided.
31. **Open design decisions carried by Main §05** remain unresolved:
    - renderer (2D drawn; 3D optional)
    - tab labels and count
    - guest browsing
    - auth method (email-link placeholder)
    - room placement
    - Lately default
    - desktop single-player rule
    - hue rule for new families (only five starter families exist)
    - snippet settings opt-in
    - presence default
    - Back at a tab root
