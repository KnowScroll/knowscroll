# @knowscroll/ui

Accessible UI primitives of the v2.1 design (`Components.html`, `NavBar.html`, `N01`, `V01`) for
React Native and React Native Web, built only from `@knowscroll/design-tokens`. Components are
router-agnostic and data-agnostic: they take typed props and report semantic actions
(`onSelect('saved')`, `onAction('save')`), never raw gestures. A control whose backend does not
exist is not passed in, so it is not rendered.

The package exports its TypeScript sources (`"."` → `src/index.ts`); Metro and jest-expo compile
them. Tests (`src/**/*.test.tsx`, jest-expo + React Native Testing Library) run in CI only
(D-010): `pnpm --filter @knowscroll/ui test`.

## Components

| Component | States and behaviour | Accessibility |
|---|---|---|
| `Text` | Token type role; desktop +15 %; own text-size scaling (`allowFontScaling` off, `resolveType` applies the system size with the 200 % rules) | `heading={1..3}` (native header; web `h1`–`h3`) |
| `Icon` | The export's 24 × 24 line icons (list below) | Always hidden; the control carries the name |
| `Button` | Variants `primary · default · ink · ghost · space · danger · continue`; sizes `md` 48 / `sm` 44; default · pressed (travels 3 px, loses the shadow; no travel under reduced motion) · focus-visible · disabled (45 %) · busy (spinner + "…ing" label, no presses) | `button` or `link`; `toggled` makes a toggle button; `aria-busy`, `aria-disabled` |
| `IconButton` | `paper · onMedia · onSpace · plain · accent`; 48 or 44 only; `pressed` (yellow, filled glyph) · disabled · busy | Name from `label` ("Back to Keep"), never the icon |
| `FormatSwitch` | Reel ⇄ Scroll; ready · preparing (stripe + "· preparing") · unavailable (disabled); tap only | Labelled group of toggle buttons; 44 px options |
| `RequestStatusChip` | requested · preparing · ready · failed · cancelled; a button only when ready/failed have an action; no percentages or times | Waiting states are a `status` |
| `ActionRail` / `ActionStrip` | One action set (Like · Save · Share · Ask · More) and one placement function (`encounterActionPlacement`, no format argument) for Reel and Scroll (D-006 b); compact (≤ 360) 44 px buttons; ≥ 150 % text a 2 × 2 grid of text buttons; Save busy while its command is in flight | `toolbar`; Like/Save are toggle buttons; rail words hidden (the button says it) |
| `Tag` | `neutral · part · onDark · hypothetical · corrected` (no "Speculative", D-006 a) | Non-interactive text; caps become sentence case above 150 % |
| `Banner` | `offline · reconnecting · corrected · accessEnded · recordingPaused · error`; optional inline action (44 px) | Offline/reconnecting `status` (polite), error `alert` |
| `Skeleton` | Loading cards; gentle pulse, still under reduced motion | One busy `progressbar` with a name |
| `StateBlock`, `OfflineState`, `ErrorState` | Empty / offline / error blocks: illustration, display title, one sentence, the real next steps | Title is a heading; illustration hidden |
| `BottomSheet`, `Scrim` | Overlay (Modal), never a route or history entry; closes on Close, scrim, Back, Esc; rises 24 px over 240 ms, fades 140 ms under reduced motion | Labelled modal dialog; scrim not focusable |
| `TabBar` | Floating pill, `paper`/`space` tone; icon-only ≤ 360 | Native `tablist`/`tab` + selected; web `nav` + links with `aria-current`; unread is a description, never in the name (D-006 n) |
| `NavRail` | Tablet 76 px; desktop 88 px with the K mark and the account avatar | Same as `TabBar`; K mark hidden |
| `TopBar` | Back · title or format switch · trailing (account avatar on every tab, D-006 c) | Title is the screen heading |
| `AccountButton` | Initial, or a person glyph when signed out; current on the account screen; 48 target (40 px avatar in the rail) | Link "Account and settings" |
| `Spinner`, `PendingStripe` | Busy arc (still under reduced motion); the 135° preparing stripe | Decorative |
| `DisplayProvider`, `useDisplay` | Width → breakpoint, system text size, reduced motion (system setting; overridable for the gallery and tests) | — |

## Platform files

Only where behaviour differs (blueprint §18):

| File | Native | Web |
|---|---|---|
| `display/focus-ring(.web).ts` | Ring drawn while the element has focus (`outline*` styles) | One stylesheet draws the ring on `:focus-visible` only, so pointer clicks do not |
| `display/semantics(.web).ts` | `togglebutton` + checked, `tab` + selected, `tablist`, accessibility hint | `button` + `aria-pressed`, `link` + `aria-current`, `navigation` landmark, `aria-describedby`, `aria-level` |

## Icons

From the export's 24 × 24 line icons (paths copied from `source/*.dc.html`): `explore`,
`universe`, `talk`, `keep`, `back`, `forward`, `chevronUp`, `chevronDown`, `arrowRight`,
`arrowLeft`, `arrowUp`, `arrowDown`, `close`, `menu`, `like`, `save`, `share`, `ask` (with "?",
so Ask never looks like Talk), `more`, `send`, `shareMoment`, `fullScreen`, `play`, `pause`,
`reel`, `scroll`, `check`, `spinner`, `retry`, `clock`, `offline`, `alert`, `info`,
`hypothetical` (branch), `corrected` (pencil), `lock`, `shield`, `plus`, `minus`, `search`,
`link`, `list`. Composed for this package: `person` (signed-out account glyph, from the Members
icon's geometry). Icons the export draws but no primitive needs yet (members, volume, eye, flag,
block, trash, pin, branch map, captions, copy) are added with the surfaces that use them.

## Not built here (later surfaces)

Content, message, snippet and branch cards, the share sheet's options, episode browser, mini
player, thread rail, continue tab, inputs, switches, settings rows and the spatial kit are built
with the journeys that use them, from these tokens and primitives.
