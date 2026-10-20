# @knowscroll/ui

Accessible UI primitives of the v2.1 design (`Components.html`, `NavBar.html`, `N01`, `V01`) for
React Native and React Native Web, built only from `@knowscroll/design-tokens`. Components are
router-agnostic and data-agnostic: they take typed props and report semantic actions
(`onSelect('saved')`, `onAction('save')`), never raw gestures. A control whose backend does not
exist is not passed in, so it is not rendered.

The package exports its TypeScript sources (`"."` → `src/index.ts`); Metro and jest-expo compile
them. Tests run in CI only (D-010): `pnpm --filter @knowscroll/ui test` runs two Jest projects,
`native` (jest-expo, `src/**/*.test.ts(x)`, React Native Testing Library) and `web`
(jest-expo/web in jsdom, `src/**/*.web.test.ts(x)`) for the `.web.ts` modules. The browser itself
is covered by the app's Playwright smoke (`apps/client/e2e`).

**Navigation controls are links.** Every control that goes somewhere (`TabBar`, `NavRail` items
via `hrefFor`, `AccountButton`, `Button role="link"`, `StateBlock` actions) takes an `href`. On
the web it renders a real `<a href>`, so Enter, middle-click, Ctrl/Cmd-click and "open in new
tab" work; a plain click or Enter is taken over for client-side navigation (`onPress`). Without
an `href` the web control is a button, because React Native Web leaves Enter on a link-role
element to the browser, which acts only on a real anchor. Native keeps `onPress` only.

**Display, once.** Mount `DisplayRoot` at the app root: it reads the window, the system text size
and the reduce-motion setting once, and every component reads `useDisplay()` from context
instead of subscribing itself. `DisplayProvider` pins parts of it (the gallery's previews,
tests); without either, components get the current window at 100 % text and motion on.

## Components

| Component | States and behaviour | Accessibility |
|---|---|---|
| `Text` | Token type role; desktop +15 %; own text-size scaling (`allowFontScaling` off, `resolveType` applies the system size with the 200 % rules) | `heading={1..3}` (native header; web `h1`–`h3`) |
| `Icon` | The export's 24 × 24 line icons (list below) | Always hidden; the control carries the name |
| `Button` | Variants `primary · default · ink · ghost · space · danger · continue`; sizes `md` 48 / `sm` 44; default · pressed (travels 3 px, loses the shadow; no travel under reduced motion) · focus-visible · disabled (45 %) · busy (spinner + "…ing" label, no presses) | `button` or `link`; `toggled` makes a toggle button; `aria-busy`, `aria-disabled` |
| `IconButton` | `paper · onMedia · onSpace · plain · accent`; 48 or 44 only; `pressed` (filled glyph on cobalt on paper, on opaque cream over media and the map; never yellow, D-006 b as amended on #255; Components.html draws it yellow) · disabled · busy | Name from `label` ("Back to Keep"), never the icon |
| `FormatSwitch` | Reel ⇄ Scroll; ready · preparing (stripe + "· preparing") · unavailable (disabled); tap only | Labelled `radiogroup` of two `radio`s, the current format checked (choosing it again does nothing, as for any radio); on the web one Tab stop and arrow keys move and choose; 44 px options |
| `RequestStatusChip` | requested · preparing · ready · failed · cancelled; a button only when ready/failed have an action; no percentages or times | Waiting states are a `status` |
| `ActionRail` / `ActionStrip` | One action set (Like · Save · Share · Ask · More) and one placement (`encounterActionPlacement`, no format argument) that both components lay themselves out from, for Reel and Scroll (D-006 b); compact (≤ 360) 44 px buttons; above 150 % text a 2 × 2 grid of text buttons (pressed = primary cobalt); Save busy while its command is in flight | A `group` named "Actions" (not `toolbar`: each action is its own Tab stop); Like/Save are toggle buttons whose names and visible words stay "Like"/"Save" in both arrangements (the state is announced, never added to the name); rail words hidden (the button says it) |
| `Tag` | `neutral · part · onDark · hypothetical · corrected` (no "Speculative", D-006 a) | Non-interactive text; caps become sentence case above 150 % |
| `Banner` | `offline · reconnecting · corrected · accessEnded · recordingPaused · info · error`; optional inline action (44 × 44 minimum) | Offline/reconnecting `status` (polite), error `alert`, info plain |
| `Skeleton` | Loading cards; gentle pulse, still under reduced motion | One busy `progressbar` with a name |
| `StateBlock`, `OfflineState`, `ErrorState` | Empty / offline / error blocks: illustration, display title, one sentence, the real next steps | Title is a heading; illustration hidden |
| `BottomSheet`, `Scrim` | Overlay (Modal), never a route; closes on Close, scrim, Back, Esc; rises 24 px over 240 ms, fades 140 ms under reduced motion. Web: while open it adds one transient history entry for the same address, so browser Back closes the sheet only (N01; ruling on #255), and removes it when the sheet closes another way | One labelled modal dialog (on the web the Modal's own `role="dialog" aria-modal`, no second one inside); scrim not focusable; focus returns to the opener |
| `TabBar` | Floating pill, `paper`/`space` tone; icon-only ≤ 360 | Native `tablist`/`tab` + selected; web `nav` + links with `aria-current`; unread is a description, never in the name (D-006 n) |
| `NavRail` | Tablet 76 px; desktop 88 px with the K mark and the account avatar | Same as `TabBar`; K mark hidden |
| `TopBar` | Back · title or format switch · trailing (account avatar on every tab, D-006 c) | Title is the screen heading |
| `AccountButton` | Initial, or a person glyph when signed out; current on the account screen; 48 target (40 px avatar in the rail) | Link "Account and settings" |
| `Spinner`, `PendingStripe` | Busy arc (still under reduced motion); the 135° preparing stripe | Decorative |
| `DisplayRoot`, `DisplayProvider`, `useDisplay` | Width → breakpoint, system text size, reduced motion, read once at the root (see above); pinnable for the gallery and tests | — |

## Scroll renderer (`src/scroll`, S2.1 part 2, #230)

Renders a consumer `scroll-document.v1` from `@knowscroll/scroll-model` (the client path only: `parseDocument`,
`parseBlock`; the admission path, with its full-grid proof, never runs on a device, and a test scans the sources for
it). The route (#229) owns chrome and navigation; `ScrollArticle` owns reading.

| Piece | What it does |
|---|---|
| `prepareScrollDocument(input, {verify?})` | The client's way in: `parseDocument` and a typed outcome (`ready · unsupported-version · invalid`). The hash is checked only with `verify` (it costs on Hermes). |
| `ScrollArticle` | A vertical `ScrollView`: the template's opening (poster card or editorial essay), the persistent framing (Hypothetical, perspective) and correction notes, every section and block through the registry, the end mark. Props: `document`, `observer?`, `diagnostics?`, `store?`, `anchorBlockId?`, `paused?`, `contentInset?`, `readingInset?`, `afterHeader?`, `endSlot?`. Keyed by `(assetId, revision)`. |
| Registry (`blocks/registry.tsx`) | Block type → component, in an exhaustive `switch` (a new block type does not compile until decided). `SCROLL_RENDERER_CAPABILITIES` is exactly what the build renders: the server's `negotiate` replaces the rest with `fallback` blocks, and a document that still carries an unrendered block shows its own text. |
| Text blocks | Paragraph (marks; runs concatenated with nothing between them, so the text is the passage projection; on the web every run carries `data-ks-block` and `data-ks-offset`), subheading (a real level-3 heading; section headings are level 2; the title is level 1), list, quote, callout, disclosure (state `{expanded}` kept by revision and block), code (horizontal scroll inside the frame, focusable on the web, Copy through `expo-clipboard`). The editorial opening has a drop cap: `::first-letter` on the web, an enlarged first letter on native (no float); the paragraph text is whole either way. |
| Fallback (`blocks/fallback.tsx`) | E02 "Diagram couldn't load · text version": the block's own text under a one-line label, never blank. `Retry` only where retrying can help (a block that threw while rendering, caught by `BlockBoundary`); a block the build cannot draw says "This part needs an app update". Every case calls `diagnostics.onRenderFallback` (internal; never shown to the reader). |
| Anchors (`anchors.ts`) | `#block` is a block id (`parseBlockAnchor`, `formatBlockAnchor`); `anchorBlockId` scrolls to the block and flashes it on `content.highlight`; a block inside a disclosure opens it first. |
| Observer (`observer.ts`) | The three-event interface the recorder (#229, `client-core`) implements: `onBlockVisibility`, `onBlockInteraction`, `onActivity`. The article measures (web: IntersectionObserver in tenths; native: layout and scroll offset) and reports by one rule (`reading/visibility.ts`): a change of ≥ 0.1, a crossing of 0, 0.5 or 1, mount or unmount. Activity: `AppState` / `visibilitychange`, plus `paused` for an open overlay. |
| Block state (`state.ts`) | `ScrollBlockStateStore`: `get · set · clear · earlier` by `(assetId, revision, blockId)`, values only the package's `BlockState`. In-memory by default; the AccountScope-scoped persistent one is `createScopedBlockStateStore` in `@knowscroll/client-core` (purged when the scope ends). |
| `fixtures/` (`@knowscroll/ui/scroll-fixtures`) | Original, labelled fixture documents for tests and the developer gallery (`/gallery-scroll`); never product content, never imported by production code. |

Reading measure: full width on phones, 500 px on tablets, 680 px on desktops (880 for code and interactive blocks).
Code is shown in DM Mono 13/21 (the token set has no code role yet, D-006 p).

## Platform files

Only where behaviour differs (blueprint §18):

| File | Native | Web |
|---|---|---|
| `display/focus-ring(.web).ts` | Ring drawn while the element has focus (`outline*` styles) | One stylesheet draws the ring on `:focus-visible` only, so pointer clicks do not |
| `display/semantics(.web).ts` | `togglebutton` + checked, `radio` + checked, `tab` + selected, `tablist`, accessibility hint, dialog on the sheet's panel | `button` + `aria-pressed`, `radio` + `aria-checked`, `link` + `aria-current` (button without an `href`), `navigation` landmark, `aria-describedby`, `aria-level`, the dialog name on the Modal |
| `display/link(.web).ts` | `onPress` only | `href` plus a press handler that leaves modified and middle clicks to the browser |
| `overlay/overlay-history(.web).ts` | Nothing (Android Back reaches `onRequestClose`) | The transient history entry that makes browser Back close an open overlay |

## Icons

From the export's 24 × 24 line icons (paths copied from `source/*.dc.html`): `explore`,
`universe`, `talk`, `keep`, `back`, `forward`, `chevronUp`, `chevronDown`, `arrowRight`,
`arrowLeft`, `arrowUp`, `arrowDown`, `close`, `menu`, `like`, `save`, `share`, `ask` (with "?",
so Ask never looks like Talk), `more`, `send`, `shareMoment`, `fullScreen`, `play`, `pause`,
`reel`, `scroll`, `check`, `spinner`, `retry`, `clock`, `offline`, `alert`, `info`,
`hypothetical` (branch), `corrected` (pencil), `lock`, `shield`, `plus`, `minus`, `search`,
`link`, `list`. Composed for this package: `person` (signed-out account glyph, from the Members
icon's geometry). Icons the export draws but no primitive needs yet (members, volume, eye, flag,
block, trash, pin, branch map, captions) are added with the surfaces that use them; `copy` came with the Scroll code block.

## Not built here (later surfaces)

Content, message, snippet and branch cards, the share sheet's options, episode browser, mini
player, thread rail, continue tab, inputs, switches, settings rows and the spatial kit are built
with the journeys that use them, from these tokens and primitives.
