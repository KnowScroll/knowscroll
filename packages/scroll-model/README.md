# @knowscroll/scroll-model

The canonical declarative Scroll document, **`scroll-document.v1`**, and beside it **`scroll-document.v2`** (the V3 Scrolls: stops, calls and a pinned stage; see the section on it below). This package holds:

- schemas, limits and validation;
- version negotiation;
- passage and block locators, block state and snapshots;
- reading measures;
- the evaluation of simulation formulas.

It also has two separate, backend-only entries: the producer contract the writer model works to, and the internal provenance a revision rests on.

The package is pure TypeScript and Zod. It uses no React, no platform APIs and no Node built-ins outside tests. The API, the worker and the Expo app (web and native) run the same code, so a document, an offset or a simulation value means the same thing everywhere. Nothing in a document is ever executed: there is no HTML, CSS, script, URL or expression language, and code blocks are shown, never run.

Background reading:

- **Blueprint:**
  - §6 contracts: `ScrollDocument` lives here and is re-exported by `contracts/content.ts`;
  - §8 Scroll qualification by weighted section coverage;
  - §11 production, approved blocks, no model JavaScript;
  - §17 snippets: `scroll_passage`, `scroll_block`, block-state snapshots;
  - §18 Scroll rendering contract, gesture arbitration, interaction recorder.
- **Design and gap analysis:** `docs/v2/discovery/scroll-dsl.md` (sections B–E), and the block inventory at the end of `docs/v2/discovery/design-screens.md`.
- **Decisions:** D-012 on the integration branch, plus the coordinator's rulings on the review of #254 (recorded below).

## Entry points

| Entry | Who may import it | Contents |
|---|---|---|
| `@knowscroll/scroll-model` | everyone (server, worker, client); see *Limits and cost* for which functions a client may call | `ScrollDocumentV2`, `LIMITS_V2`, `computeMeasuresV2`, the kit enums and `validateDocumentV2` (`scroll-document.v2`, D-120; `validateDocumentV2` is admission, not for clients). Document and block schemas, limits, `admitDocument` / `validateDocument`, `parseDocument`, `admitBlock`, `parseBlock`, `negotiate`, `parseCapabilities`, locators and anchor maps, block state and snapshots, the telemetry payload, measures and coverage, simulation evaluation and its runtime guards, the readers of a simulation's stored display (`displayScale`, `displayRange`), `fallbackTextOf`, `textFields`, canonical JSON and SHA-256 |
| `@knowscroll/scroll-model/producer` | backend only | `AuthoredScrollV2`, `assembleScrollV2` and `compileAuthoredV2` (the v2 writer's shape and checks, D-120), `AuthoredScroll` (what the writer model returns), `compileAuthored`, `authoringReference()` for the prompt, `ScrollDraft` (the canonical draft), `DraftProvenance` (the compile input), `validateDraft`, `compileDraft`, `draftFromDocument`, stages and repair hints |
| `@knowscroll/scroll-model/internal` | backend only | `ScrollProvenance` (claims, sources, bindings, checks, production record) and the honesty checks |
| `@knowscroll/scroll-model/admission` | backend only | `admitDocument`, `admitBlock` and `validateDocument`: every check including the full-grid proof. The public entry still re-exports the same functions for code written before this entry existed (they are the same function objects); new server code imports them from here, and client code may import neither (see the rules below). |
| `@knowscroll/scroll-model/fixtures/<name>.json` | tests only | The labelled consumer-document fixtures (`fixtures/documents/`). Drafts, compile inputs and internal provenance fixtures are not exported. |

Dependency direction, enforced by dependency-cruiser and proved by `pnpm boundaries:probe`:

```text
 apps/client, packages/{ui,client-core,design-tokens,scene-core} ──▶ scroll-model (public entry)
 packages/contracts (content.ts re-export)                        ──▶ scroll-model (public entry)
 packages/backend, apps/api, apps/worker                          ──▶ scroll-model, ./producer, ./internal, ./admission
 ./producer ──▶ ./internal ──▶ public modules ──▶ zod
```

| Rule | What it enforces |
|---|---|
| `clients-never-import-scroll-internals` | Client code never imports `./internal` or `./producer`, whether by resolved path or by the bare package specifier (`@knowscroll/scroll-model/internal`). |
| `clients-never-import-scroll-admission` | Client code never imports `./admission`, by resolved path or by the bare package specifier (`@knowscroll/scroll-model/admission`). `pnpm boundaries:probe` proves it for `apps/client`, `packages/ui` and `packages/client-core`. |
| ESLint `no-restricted-imports` (client packages) | Client code does not import `admitDocument`, `admitBlock` or `validateDocument` by name from the public entry either, where they remain for compatibility. `pnpm lint:probe` proves it for the three client packages. |
| `clients-never-import-scroll-producer-fixtures` | Client code never reaches `fixtures/producer/` (claims, sources, URLs). |
| `scroll-model-public-entry-is-self-contained` | The public modules never reach `internal/`, `producer/` or `admission/`, so a client cannot get them transitively. |
| `contracts-are-wire-only` | `contracts` may re-export scroll-model's public entry only. |
| `scroll-model-is-portable`, `scroll-model-depends-on-zod-only` | No Node built-ins, and no third-party package other than Zod, outside tests. |

## How it takes part in the reading journey

1. **Production (worker).**
   - The writer role returns one JSON object in the authored shape (below).
   - `compileAuthored(authored, provenance, evidence)` converts it into a canonical draft, derives its claim bindings from the passages each block cites, and runs the stages below. Hand-authored editorial drafts take `validateDraft` / `compileDraft` directly.
   - `compileDraft(draft, provenance)` turns a draft into the immutable consumer document and its internal provenance. This is **admission**: every check runs, including the full-grid proof of each simulation.
   - Code, not the model, sets: missing ids, versions, gestures, text blocks' accessibility label, the "Illustrative" notice, framing, template, theme, series, reading time, coverage weights and the integrity hash.
2. **Storage.** The document is stored per revision and served to clients. The provenance is stored beside it and never served. A revision is admitted with `admitDocument` (the same checks again, on exactly the stored bytes).
3. **Serving.**
   - The client advertises `ClientCapabilities`, and `negotiate` parses them (they are untrusted input).
   - `negotiate` returns the rendition for that client. It replaces each unsupported block with a `fallback` block and lists the essential blocks that degraded, so the caller can prefer another rendition, such as the Reel variant.
   - A rendition that substituted blocks carries `rendition {of, sha256}`, which the client can verify.
   - A rendition of a valid stored revision is always valid, because the stored limits hold for the worst rendition.
4. **Rendering.**
   - The renderer parses each block defensively (`parseBlock`: structure, bounds and cheap checks, never a grid walk). When it cannot render a block, it shows `fallbackTextOf(block)`.
   - Every evaluated point is guarded: when `outputsUsable` is false (a non-finite output at runtime), the renderer shows the block's fallback text instead of the view, never `NaN` or `Infinity`.
   - `gesture` drives gesture arbitration, and `REDUCED_MOTION` drives reduced motion.
   - `projectText` and `isGraphemeBoundary` handle text selection.
   - Simulations use `evaluateSimulation`, `sampleCurve`, `renderTemplate`, `readoutBand` and `formatNumber`, and read the bar scale and plot range that admission stored (`displayScale`, `displayRange`); nothing a renderer calls walks the grid. An illustrative simulation always shows its "Illustrative" notice.
5. **Reader state.** `BlockState` lives on the device, keyed by (account scope, epoch, asset, revision, block id). `defaultBlockState` and `blockStateProblems` restore or reset it.
6. **Sharing.**
   - `createPassageLocator` and `validateLocator` handle `scroll_passage`.
   - `buildBlockStateSnapshot` handles `scroll_block`. It leaves personal values out unless they are explicitly included.
   - `describeBlockState` gives the server-rendered card text.
7. **Evidence.**
   - The recorder reports visible block ids and deliberate interactions (`blockInteractionPayload`, which never carries values).
   - The server computes weighted coverage with `coverageOf`, from the stored measures.
8. **Corrections.**
   - A new revision is compiled with `corrections[]` from the correction workflow.
   - `deriveAnchorMap` and `repointLocator` re-point old snippets and resume anchors.
   - Every outcome says what happened: `same` only when the block is identical under the same id.

## Rulings implemented

### D-012 (scroll-document.v1)

- **Blocks.** Every authored type takes typed `data`.
  - **paragraph:** inline marks, and stable passage offsets in UTF-16 over the block's plain text.
  - **subheading** and **list**.
  - **quote.**
  - **callout:** note, example, limit, key-idea or try-it.
  - **disclosure.**
  - **code:** displayed, never executed; it scrolls horizontally.
  - **table:** at most 5 × 12.
  - **figure** and **media:** admitted asset references only, and alt text is required.
  - **comparison**, **timeline** and **sequence** (a stepper).
  - **diagram:** authored nodes and edges, and up to 8 authored frames switched by steps, toggles or dragging a token onto a target. There is no physics.
  - **chart:** bar, line, scatter or heatmap, at most 200 points.
  - **simulation:**
    - at most 4 parameters, each with min, max, step, default and unit, and optionally `personal: true`;
    - a closed set of formula kinds: linear, product, ratio, power, exponential, inverse-square and lookup;
    - a closed set of views, and no expression grammar.
  - **fallback:** emitted by the server only.
  - `predict_reveal` is not in v1.
- **Envelope, document, honesty, personal parameters, limits, negotiation, locators and producer.** All as ruled. The details are in the sections below.

### Coordinator rulings on limits and fallback text

Related: #254.

- **Media cap.** At most 12 figure and media blocks per document.
- **Text blocks' fallback text** is derived at negotiation and render time (`fallbackTextOf`), never stored.
- **Numbers.** Digits and Unicode number forms (`\p{N}`) are checked. Number words are not required in v1.
- **Formatting.** English number formatting only in v1.
- **Charts and comparisons.** Chart "inspect" and comparison glyphs stay out of v1.
- **Explanation unit.** A single `explanationUnitId` per Scroll, plus an optional `series` reference.
- **Fixtures.** `./fixtures` exports consumer-document fixtures only.
- **Validation paths (M1).** The full-grid proof runs at admission only; the client path is cheap (*Limits and cost*).
- **Display scale.** The bar scale and plot range of every cards, area and plot view are computed once by code at admission, in the proof pass, and stored as code-set data (`data.display`); the client reads them and never walks the grid (*Simulations*).
- **Client hash check.** `parseDocument` may skip the measures and the hash; admission and `validateDocument` always verify.

## The document

| Field | Set by | Meaning |
|---|---|---|
| `schemaVersion` | code | `"scroll-document.v1"`; anything else is `unsupported-version` |
| `assetId`, `revision` | code | The immutable revision; a change is a new revision |
| `language` | brief | A BCP 47 subset (`en`, `en-GB`) |
| `explanationUnitId` | brief | The explanation shared with the Reel variant, so the two are not counted twice |
| `series` (optional) | brief | `{seriesId, part}`, when the Scroll is one part of a series |
| `template` | brief | `poster` (E02) or `editorial` (E09-2) |
| `theme.family` | brief | The family accent from the design tokens |
| `kicker` | brief | The topic line above the title |
| `title`, `dek` | model | The poster or editorial header |
| `framing` | brief or scenario node | `factual`, `hypothetical {assumptions, kept}` or `perspective {lens}` (D-006 a) |
| `sections[]` | model; ids may come from code | `{id, heading, blocks}`; only the first section may have `heading: null` |
| `corrections[]` | correction workflow | `{on, summary}`, for the persistent "Corrected …" note |
| `limitsVersion` | code | `"scroll-limits.v1"` |
| `measures` | code | `scroll-measures.v1`: a weight per top-level block, the total, and reading minutes |
| `integrity` | code | `canonical-json-sha256.v1`: the SHA-256 of the canonical JSON without `integrity` and `rendition` |
| `rendition` (renditions only) | `negotiate` | `{of: <stored integrity>, sha256: <hash of exactly what the client received>}`; a stored revision never has it |

Deliberately absent: sources, claims, quotes, model, prompt, run, reviewer, counts, navigation (Part 2, Related and the end card are app chrome) and any per-reader data.

### How a client verifies a document

- If `rendition` is absent, the document is the stored revision: verify `integrity.sha256`.
- If `rendition` is present, verify `rendition.sha256` over the canonical JSON without `integrity` and `rendition`. `rendition.of` names the stored revision it came from.

## Blocks

| Kind | Envelope | Who writes what |
|---|---|---|
| Text blocks: paragraph, subheading, list, quote, callout | `{id, type, version, a11y, essential, gesture, data}` | Code sets `a11y.label` (`deriveTextLabel`) and nothing else: admission **recomputes** it and refuses any other label (`a11y_label_mismatch`) and any description (`a11y_description_unexpected`), because screen readers speak both and no honesty, copy or length check would see them. Code derives the fallback text on demand (`fallbackTextOf`). |
| Every other block | `{id, type, version, a11y, fallbackText, essential, gesture, data}` | The writer supplies `a11y` and a standalone `fallbackText` of at least 40 characters. |

| Type | Data (bounds) | Gesture (derived) | State | Interactive | Reduced motion | Passages |
|---|---|---|---|---|---|---|
| `paragraph` | spans (marks `em`, `strong`, `code`), ≤ 1,200 chars | none | — | no | — | yes |
| `subheading` | text ≤ 80 | none | — | no | — | no |
| `list` | bullet or number, 2–8 items ≤ 400 | none | — | no | — | yes (items joined by `\n`) |
| `quote` | pull or quotation, ≤ 400; attribution (quotation only) | none | — | no | — | yes |
| `callout` | note, example, limit, key-idea or try-it; title ≤ 60; ≤ 600 | none | — | no | — | yes |
| `disclosure` | summary ≤ 100; 1–6 reading blocks (paragraph, list, quote, callout, code, table, figure) | none | `{expanded}` | no | expand without animation | children |
| `code` | 16 languages; ≤ 4,000 chars, 120 lines, 160 per line; highlights; caption | horizontal | — | no | — | no |
| `table` | 1–5 columns × 1–12 rows; cells are text, number or empty | none | — | no | — | no |
| `figure` | admitted still or loop; alt 10–300; caption | none | — | no | poster instead of loop | no |
| `media` | admitted video (poster and captions required) or audio; transcript; ≤ 60 s | none | — | yes | poster, no autoplay | no |
| `comparison` | 2–3 columns × 1–5 points | none | — | no | — | no |
| `timeline` | 2–12 events in order | none | — | no | — | no |
| `sequence` | 2–8 steps; optional step figure | none | `{step}` | yes | change step without sliding | no |
| `diagram` | ≤ 16 nodes, ≤ 24 edges, ≤ 8 frames, ≤ 4 groups; six layouts (`grid` uses 6 × 6 cells); static, steps, toggle or drag-to-target | two-axis for drag-to-target, else none | `{frame}` | unless static | switch frame without transition | no |
| `chart` | bar, line, scatter or heatmap; ≤ 4 series; ≤ 200 points; axes with linear or log scale (a log domain must be > 0) | none | — | no | — | no |
| `simulation` | 1–4 params; ≤ 12 constants; 1–6 outputs; view; readout bands; model note; `illustrative`; `display` (set by code) | horizontal with a slider, else none | `{params}` | yes | update without morphing | no |
| `fallback` | `{originalType, originalVersion, reason}`; emitted by `negotiate` only | none | — | no | — | no |

### Simulations

**Parameters.** Each parameter is a number on the grid `min + k·step`. `(max − min) / step` must be a whole number of at most 1,000. Each has a primary control (`slider`, `stepper` or `input`), and text-version mode adds a stepper for every number.

**Formulas.** Operands are numbers or keys (parameters, constants and earlier outputs). The formula kinds are:

| Kind | Computes |
|---|---|
| `linear` | a·x + b |
| `product` | the product of its factors |
| `ratio` | numerator / denominator |
| `power` | scale·(x/base)^exponent, with the exponent between −4 and 4 |
| `exponential` | initial·e^(rate·x) |
| `inverse-square` | k/r² |
| `lookup` | a step or piecewise-linear table of at most 12 increasing points, clamped at the ends |

**Views.** The view kinds are:

| View | Shows |
|---|---|
| `readout` | a primary output and an optional secondary one |
| `cards` | 2–8 outputs with bars |
| `plot` | an output as a curve over one parameter's grid values (all of them, or 200 evenly spread ones) |
| `area` | a parameter as a bar beside an output as a square |

**Display scale (`data.display`, set by code).** Bars, areas and plot ranges are scaled from the grid, never by a number the model writes. Admission computes the scale **once**, in the same full-grid pass that proves the outputs finite (no second walk), and stores it in the consumer document, like reading time and coverage weights:

| View | `display` | Value |
|---|---|---|
| `cards` | `{kind: 'cards', scale}` | the largest value any card shows over the grid (what fills a bar); 1 when none is positive |
| `area` | `{kind: 'area', scale}` | the largest value of the area output over the grid (what fills the square); 1 when none is positive |
| `plot` | `{kind: 'plot', range: [low, high]}` | `[min(0, lowest), highest]` of the plotted output over the grid; `[low, low + 1]` when flat |
| `readout` | `{kind: 'none'}` | nothing to scale |

- **Never written by the model.** The draft schema has no such member, so a draft that carries one is refused (`schema_unrecognized_keys`); `draftFromDocument` drops it, and `compileDraft` replaces the producer's placeholder with the proven value before the document is signed.
- **Covered by the integrity hash**, and **recomputed and compared at admission** (`sim_display_mismatch`, to the last digits: a relative 1e-9 of the scale's own magnitude, and for a range of its largest end, with no absolute floor, so a library update cannot refuse a stored scale but a wrong scale of a simulation whose outputs are tiny is refused too), the same tamper check as the reading measures. It is a derived number, not a claim: the honesty checks do not bind it.
- **Checked on the client path** (`parseDocument`, `parseBlock`, rendition validation): present (the schema), the kind its view needs, finite, a positive scale or an increasing range (`sim_display_invalid`). The client does not recompute it.
- **Read, never computed, by the client**: `displayScale(data)` and `displayRange(data)` return the stored value (a neutral 1 or `[0, 1]` for a view without one), and `displayFraction(value, data)` turns a value into a position from 0 to 1 that is always finite (a `null`, an `Infinity` or a forged scale of 5e-324 reads as 0 or 1, never `NaN` or `Infinity`), so a renderer can use it as a length without a further guard. `cardsScale`, `plotRange` and the grid sweep are gone from the public entry (`display.test.ts` asserts it); a renderer whose own arithmetic puts a value a hair above the stored scale clamps it.

**Proof over the whole grid (admission only).**
- The product of all the parameters' grid sizes must be at most **10,000** points (`sim_grid_too_large`). This is a count, checked on both paths.
- The admission validator evaluates every output at **every** grid point. Plot samples are grid values, so they are covered. The same pass finds the display scale (above). The client path never does this (see *Limits and cost*).
- It refuses any non-finite output, any output beyond ±1e15, and any negative bar or area.
- Each formula is compiled once into a kernel over one `Float64Array`. The proof sweeps the grid a row at a time (the largest grids laid out along the row, up to 1,024 values) and re-evaluates only the outputs that depend on a parameter that changed. The same kernels evaluate a single point and a curve, so the proof checks exactly the arithmetic the renderer runs. Evaluation never throws; outside validation, a bad value becomes `null` and renders as "—".

**`illustrative`.**
- A drafted `illustrative: true` becomes the stored notice `{notice: "Illustrative"}`. The renderer must always show it, next to the view and in the text version.
- A simulation that is not illustrative binds every number it states (see *Honesty* below).

## Limits (`scroll-limits.v1`)

A change to any value is a new limits version. These are bench values, not measured optima.

The limits hold for the **worst rendition** a client can be given. Each block a client might lack counts at the larger of its own visible text and its fallback text. A disclosure counts at the larger of its fallback text and its children's worst cases. The byte size includes every substitution's growth and the `rendition` member. So `negotiate` can never turn a valid revision into an invalid rendition.

| Ruled limit | Value | Code when exceeded |
|---|---|---|
| Document (canonical JSON, UTF-8; worst rendition) | 128 KiB | `document_too_large` (checked first, before parsing) |
| Sections | ≤ 12 | `schema_too_big` |
| Blocks (nested included) | ≤ 80 | `too_many_blocks` |
| Interactive blocks (simulation, sequence, media, non-static diagram) | ≤ 8 | `too_many_interactive` |
| Figure and media blocks | ≤ 12 | `too_many_media` |
| Visible characters (worst rendition) | ≤ 24,000 | `visible_text_too_long` |
| Parameters per block / in total | ≤ 4 / 16 | `schema_too_big` / `too_many_params` |
| Simulation grid | ≤ 10,000 points | `sim_grid_too_large` |
| Chart points | ≤ 200 | `chart_too_many_points` (or `schema_too_big` per series) |
| Diagram nodes / edges / frames | ≤ 16 / 24 / 8 | `schema_too_big` |
| Table columns × rows | ≤ 5 × 12 | `schema_too_big` |
| Code | ≤ 4,000 characters | `schema_too_big` |
| Passage quote | ≤ 600 UTF-16 code units, on grapheme boundaries | locator `range-too-long` / `range-splits-character` |
| Saved block state (snapshot) | ≤ 1 KiB | `too-large` / locator `state-too-large` |
| JSON nesting of any untrusted input | ≤ 32 levels | `document_too_deep` / `draft_too_deep` |

The per-field bounds are listed in `FIELD_LIMITS`. They include kicker 40, title 90, dek 200, heading 80, a11y label 120 and description 600, fallback text 40–1,200, 40 spans per text, paragraph 1,200, list 8 × 400, quote 400, callout 600, 6 disclosure children, code 120 × 160, caption 300, table cell 120, alt 300, transcript 1,200, media 60 s, comparison 3 × 5 × 240, timeline 12, sequence 8 × 500, 4 diagram groups, labels 32, frame description 400, 4 chart series, 24 bar categories, heatmap 12 × 12, 12 constants, 6 outputs, 12 lookup entries, 8 cards, 6 bands, template 160, 1,000 slider positions, numbers ±1e15, 10 corrections and 64 capability types.

Text primitives refuse:
- control characters and line separators;
- lone surrogates (two different strings would otherwise hash alike);
- text that is not NFC;
- web addresses in reader text (a URL scheme, `www.`, `mailto:`, or a host name on a common suffix, including one with an underscore, `my_site.com`).

Every one of these checks is a single scan of constant state per character, so it costs time linear in the text, and each runs only on text within its length cap: text over its limit is refused by the cap alone, with no scan (a regular expression with nested quantifiers here cost O(length²), 5.8 s for a 40,000-character title, in the first version of this PR).

## Limits and cost

### Two validation paths (coordinator ruling on M1)

The review of #254 (M1) asked what validation costs. The ruling: the full-grid finiteness proof (up to 10,000 grid points per simulation) must **not** run on the client's parse path. Hermes has no JIT, so the proof would cost tens to hundreds of milliseconds per Scroll on a phone (the coordinator's estimate; not measured here).

| | Admission | Client |
|---|---|---|
| Who may call it | server, worker, producer | the device (a renderer) |
| Document | `admitDocument`, `validateDocument(…, {purpose: 'stored'})` (the default), the producer's `validateDraft` and `compileDraft` | `parseDocument`, `validateDocument(…, {purpose: 'rendition'})` |
| Block | `admitBlock` | `parseBlock` |
| Envelope, depth, byte size, unknown types, schema | yes | yes |
| Counted limits (blocks, interactive, media, parameters, visible text, worst-rendition growth) | yes | yes |
| Per-block structure (tables, charts, diagrams, media) | yes | yes |
| Simulation declarations (keys, ranges, references, views, grid size) | yes | yes |
| **Full-grid proof (every output finite and within ±1e15, no negative bar or area, at every grid point)** | **yes** | **never** |
| Display scale of each cards, area and plot view | computed in the proof pass and compared with the stored one | stored value checked (present, finite, right kind), read, never computed |
| Reading measures and the integrity or rendition hash | always | may be skipped, and is by default: only `parseDocument(…, {verify: true})` checks them |

- **The client trusts admission, and guards each point.** A revision reached the client only after admission proved it. At runtime a single point is still guarded: `evaluateSimulation` returns `null` for a non-finite output (or one beyond ±1e15), and `outputsUsable(values)` (and `curveUsable(curve)` for a plot) is then false. The renderer shows `fallbackTextOf(block)` in place of the view, the readout and the bars. Number text is never `NaN` or `Infinity`: `formatNumber` renders `—`.
- **The client may skip the measures and the hash; nothing else may.** SHA-256 over up to 128 KiB is linear and cheap on a JIT but not on Hermes, so `parseDocument` leaves the reading measures and the integrity (or rendition) hash alone unless `{verify: true}` (accepted by the coordinator). The rendition's `of` link to the stored revision is always checked. `admitDocument` and `validateDocument`, for either purpose, **always verify**, and have no option to skip it.
- **The display is stored, so the client never walks the grid for it.** Admission computes each cards, area and plot scale in the grid proof it runs anyway and stores it (see *Simulations*). `cardsScale`, `plotRange` and the sweep are not exported; the client reads `displayScale` and `displayRange`. A bar scale or plot range is therefore no render-time cost: the only grid work in the package is admission.
- **Strict CSP and runtimes without dynamic compilation.** Every Scroll schema imports the local `zod.ts` facade, which configures `z.config({jitless: true})` before construction. Zod otherwise probes `Function` when it builds an object schema, even if parsing later disables JIT; a caught probe still causes a browser CSP violation. This setting applies to the entire realm, including Zod schemas constructed by other packages afterwards. It changes parsing cost, not validation rules. The package preserves this initialization in its `sideEffects` list. `csp.test.ts` starts from an unconfigured Zod instance, traps every call and construction of `Function`, cold-imports the public entry, then the admission, producer and internal entries, and exercises document/block/envelope/capabilities/admission/compile paths with zero attempts. This is a CI fixture in Node, not a browser CSP or Hermes measurement. `contracts` also configures jitless at its own entry before its schemas; direct imports of unrelated packages are outside this package's guarantee.
- **The entry points name their path.** Each exported function's TSDoc says whether a client may call it (the `index.ts` header lists both sets). No client code may call an admission function; this table is the contract.

### Budgets

Measured in `performance.test.ts` on the CI runner as the median CPU time of the test process, after warm-up, on a fresh copy of the input (the runner shares its cores with other suites, so wall-clock time is printed beside it and is not asserted). The inputs are the largest the limits allow (`test-support/worst-case.ts`): the worst simulation is the largest grid (10,000 points) with six outputs that all depend on every parameter, five of them fractional powers, twelve constants and a cards view; the worst document holds eight simulations of two parameters (100 × 100 points each, 80,000 grid points: the 16-parameter and 8-interactive-block limits together), twelve figures and paragraphs up to the 80-block limit. Hostile text is measured too: an 85 KB document whose title is a long dotted string, a 120,000-character field in a draft, and a document filled to its visible-text limit with dotted and hyphenated paragraphs, each within the budget of the path it takes.

| Path | Input | Budget |
|---|---|---|
| Admission | worst-case simulation block (`admitBlock`) | < 10 ms |
| Admission | worst-case stored document (`admitDocument`) | < 200 ms |
| Client | worst-case simulation block (`parseBlock`) | < 1 ms |
| Client | worst-case document (`parseDocument`) | < 20 ms |

These replace the earlier single "< 5 ms" assertion, which measured the admission work on the client path and failed on the runner at about 7.4 ms. The device path now has a much tighter budget than before. The CI records are printed by the test; the informational record (`parseDocument` with `verify`) has no budget.

### What is not proved

- Hermes timing and on-device rendering: all the numbers above are Node/V8 on a CI runner.
- Whether the stored `display` matches the scale the client's own arithmetic would give on Hermes: a value that differs in the last digit is clamped by the renderer.

## Honesty (`./internal`, evidence stage)

These checks are pure functions of a document and its provenance. They prove that every number a reader is shown or read is anchored to a claim. They cannot prove that the claim is true or that the prose says what the claim says; that is content review (blueprint §11).

1. **Every numeric token is anchored.**
   - A numeric token is a run of `\p{N}`: digits, fractions such as ⅜, superscripts such as ², and Roman numerals. `4,096` and `1.46` are one token each.
   - The rule covers **every reader-facing text**: title, dek, kicker, section headings, and every field `textFields` lists (prose, captions, labels, units, number-format suffixes, a11y label and description, fallback text, alt text, transcripts, table cells).
   - Each token must lie inside an anchor bound to a claim on that same field (`number_unbound`).
   - An anchor never crosses a sentence boundary (`binding_anchor_crosses_sentence`). A sentence ends at a line break; at `!`, `?`, `…`, `。`, `！` or `？`, with any closing quotes and brackets after it (`.)`, `."`, `.”`, `?»`); and at a `.` (with its closers) followed by whitespace, by the end, or directly by a capital letter or a digit. A `.` between two digits is a decimal point and one before a lower-case letter is part of a name (`np.exp`), so both stay inside a sentence. A break made too eagerly only asks for a second anchor; one that is missed lets a single claim stand behind two numbers.
   - Exemptions: the **body of a code block**, because code is shown, never run, and is not a factual claim; the `{key}` placeholders of a readout template, whose values are the simulation's own numbers; and, **in a unit field only**, a superscript exponent attached to a unit symbol (`m/s²`, `km²`, `kg/m³`), which is notation. A superscript anywhere else, a standalone one, or one with ordinary digits (`10²`) is a number like any other.
2. **Every chart** has a claim binding for its data (`numeric_block_unbound`).
3. **A simulation that is not illustrative binds every number it states.**
   - The numbers covered (`simulationNumbers`): parameter min, max, step and default; constants; every literal operand; power exponents; lookup breakpoints; and readout band thresholds.
   - Constants take a `constant` binding; every other number takes a `value` binding by path.
   - Exempt: the structural numbers 0, ±1, 2 and 0.5, except in a **constant**: a constant is a named, stated quantity (the number of Mars's moons is 2), so it is bound whatever its value.
   - Codes: `constant_unbound`, `simulation_number_unbound`. The simulation must also have at least one binding (`simulation_unbound`).
4. **Not checked.** Diagram edge weights are stroke emphasis, not quantities a reader is shown. `format.decimals` is display precision. A simulation's stored `display` is derived by code from numbers that are themselves bound (or illustrative), not a claim.

Binding kinds (internal provenance; the draft uses `anchorText` in place of `start`/`end`):

| Kind | Fields |
|---|---|
| `passage` | `claimId, blockId, field, start, end`: `field` is `text` (a text block's passage text) or a `textFields` path |
| `header` | `claimId, field (title, dek or kicker), start, end` |
| `heading` | `claimId, sectionId, start, end` |
| `constant` | `claimId, blockId, constantKey` |
| `value` | `claimId, blockId, path`: a simulation number, for example `params.0.max` or `outputs.1.formula.exponent` |
| `block` | `claimId, blockId` |

## Failure behaviour

Everything returns a typed outcome. Validators never throw on bad input. They report stable reason codes with paths (`REASON_CODES`), never the offending text.

### `validateDocument(input, {purpose})`

`purpose: 'stored'` (the default, also `admitDocument`) is admission; `purpose: 'rendition'` (also `parseDocument`) is the client path. `validateDocument` always verifies the measures and the hash; only `parseDocument` may skip them. Checks run in order:
1. the envelope;
2. nesting depth;
3. canonical byte size;
4. unknown block types;
5. the schema;
6. counted limits;
7. per-block checks. On the admission path simulations are proven over their grid last (which also computes and compares their display), and only when every limit holds; the client path only checks their declarations and the stored display;
8. measures and the integrity (or rendition) hash: always for `validateDocument` and `admitDocument`; for `parseDocument` only with `{verify: true}`.

Outcomes:
- `valid`;
- `unsupported-version {schemaVersion}`;
- `invalid {issues}`. Rendition-specific codes: `rendition_integrity_mismatch` and `rendition_in_stored_document`.

### Other functions

| Function | Outcomes |
|---|---|
| `parseBlock(input)` (client), `admitBlock(input)` (admission) | `block` · `unsupported {unknown-type \| unknown-version, envelope}` · `invalid {envelope, issues}`; the envelope keeps any valid id and fallback text |
| `negotiate(document, capabilities)` | `negotiated {document, substitutions, degradedEssential}` · `invalid-capabilities` · `unsupported-document` · `missing-baseline` (every client must render `fallback`, `paragraph` and `subheading`) |
| `validateLocator(document, locator, {personalConsent})` | `valid {sectionId, sectionHeading, quote, block}` · `invalid {reason}` |
| `buildBlockStateSnapshot(block, state, {includePersonal})` | `snapshot` · `stateless` · `invalid-state {problems}` · `too-large` |
| `deriveAnchorMap(previous, next, {moves})` | `derived {map}` · `invalid {reason}` |
| `repointLocator(locator, previous, next, map)` | `same {change: 'same'}` · `remapped {change, moved}` · `state-reset {change}` · `unavailable {block-removed \| block-type-changed \| passage-changed, sectionId}` · `invalid` |
| `validateDraft(raw, provenance)` | `valid {draft}` · `refused {stage, issues}` |
| `compileDraft(raw, provenance)` | `compiled {document, internalProvenance}` · `refused {stage, issues}`; a `publish` refusal means an internal bug, so escalate rather than repair |

`repointLocator` notes:
- **Trust in the anchor map.** The map is stored data and could be stale or forged, so it is trusted for one thing only: the pairing of ids (the moves the correction workflow declared). Its `change` for each pair is recomputed from the two blocks, and a map that disagrees (a rewritten paragraph called `same`, a block called removed that the next revision still has, an id the next revision does not have) is refused as `map-mismatch`.
- `same` only when the anchor map says the block is identical under the same id. A rewritten, updated or moved block is `remapped`, with its change.
- A state whose declaration changed (ranges, frames, steps, or a parameter's `personal` flag) is kept only if it still fits and its consent label still holds; otherwise it is reset.
- Every kept locator is re-validated against the next revision.

## Locators, state and telemetry

- **`scroll_passage {assetId, revision, blockId, start, end, quoteHash}`.**
  - `[start, end)` is in UTF-16 code units over the block's `text-projection.v1`: the concatenation of its spans, with list items joined by `\n`.
  - At most 600 units.
  - It starts and ends on **grapheme boundaries**: `Intl.Segmenter` where available, otherwise `grapheme-fallback.v1` (never inside a surrogate pair, before a combining mark, ZWJ, variation selector, emoji modifier or tag character, after a ZWJ, or between two regional indicators). The server is the authority.
  - `quoteHash` is the SHA-256 of the quoted text.
- **`scroll_block {assetId, revision, blockId, blockType, blockVersion, state?}`.** The optional `{state, personalIncluded}` snapshot must fit the block and stay within 1 KiB.
- **Personal values.**
  - `buildBlockStateSnapshot` drops personal parameters unless `includePersonal: true`.
  - `validateLocator` accepts a personal value only when the snapshot says it was included and the sender confirmed it (`personalConsent`).
  - `BlockInteractionPayload` is `{blockId, blockType, blockVersion, kind}` and nothing else.
- **Anchor map** `scroll-anchor-map.v1`. It has one entry per block of the previous revision: `same`, `updated`, `text-changed`, `state-changed` (including a flipped `personal` flag), `type-changed` or `removed`, with declared moves checked.

## Measures (`scroll-measures.v1`)

Weights are in word-equivalents:

| Block | Weight |
|---|---|
| Text blocks | their word count, at least 5 |
| Subheading | 2 |
| Code | 10 + 3 per line |
| Table | 10 + 2 per cell |
| Figure | 20 |
| Media | 20 + 1 per 400 ms |
| Comparison and timeline | their words, at least 10 |
| Sequence | 10 + its words |
| Diagram | 40 + 10 per frame |
| Chart | 45 |
| Simulation | 60 + 15 per parameter |
| Disclosure | 5 + 30% of its children |

- Reading minutes = round(total / 200), at least 1.
- `coverageOf(document, seenBlockIds)` gives the weighted fraction, overall and per section.

## The authored shape (`scroll-authoring.v1`)

What a writer model returns is deliberately smaller and more forgiving than the canonical draft.
Long nested JSON is where models slip (a dropped quote, an unbalanced bracket), so:

- **Flat blocks.** `{title, dek, blocks}`; a `heading` block starts a section. Types: `heading`,
  `paragraph`, `list`, `callout`, `comparison` (columns and rows), `timeline`, `sequence`, `diagram`,
  `bar-chart`, `line-chart`, `simulation`.
- **Plain strings** stand for rich text. Diagram nodes get ids the writer chooses; frames name nodes
  and edges by id, by label or as `from>to`. A simulation lists parameters, constants and outputs
  with the canonical closed formula kinds; code aligns its grid and always marks it illustrative.
  Cosmetic text up to twice its limit is shortened at a word boundary; prose keeps its strict limit.
  A diagram's `layout` and a node's `kind` only change how it looks: any other word is mapped to the
  default (`flow-lr`, `entity`) instead of refusing the Scroll, and the revision's provenance records
  it as a check named `authoring-normalisation` with reason codes such as
  `diagram_layout_defaulted_block_6`. Choices that change meaning stay strict. A formula operand is
  a number or the key of a parameter, constant or earlier output; a nested formula or an
  expression is refused at the operand (`blocks[7].outputs[0].formula.denominator`), and the
  prompt's reference says to name a computed value as an output first.
- **Citations instead of anchors.** Every non-heading block has `cites`, the handles of the offered
  evidence passages (`e1`, …) it rests on. `deriveBindings` turns them into claim bindings: a `block`
  binding per citation, and for every sentence of any reader-facing text that states a number, an
  anchor on a cited claim whose source text contains that same figure. A figure in no cited passage,
  a chart value in no cited passage (zero excepted), an unknown handle and fewer than four distinct
  cited passages are findings.
- **Derived envelope.** Accessibility labels and fallback texts are built from each block's own words.
- **Findings are located at the authored block** (`blocks.7`, `title`), via the converter's
  positions, so a repair can name the block the writer wrote. Four reason codes belong to this shape
  (`authoring_*`), each with a fixed hint.

`authoringReference(types)` is the prompt's description of the shape, built from the limits tables.
Its examples are invented syntax guidance. Everything else in this package is unchanged by it: the
converter produces a canonical `ScrollDraft` and every canonical check still runs.

## The producer contract (`./producer`)

- **`ScrollDraft` (`scroll-draft.v1`).**
  - Shape: `{draftVersion, title, dek, sections[{id?, heading, blocks}], bindings}`.
  - Text blocks are `{id?, type, essential?, data}`. Every other block is `{id?, type, a11y?, fallbackText?, essential?, data}`.
  - Inline text may be a plain string. A drafted simulation's `illustrative` is a boolean.
  - Refused if present: `version`, `gesture`, `fallback` blocks, and `a11y` or `fallbackText` on text blocks.
- **Bindings.** As in *Honesty*, with `anchorText`, which must occur exactly once in the named text. `passage.field` defaults to `text`.
- **`DraftProvenance` (`scroll-draft-provenance.v1`).**
  - Chosen by code: publication identity, template, theme, kicker, framing, optional series, corrections and target minutes.
  - The offered claims and their sources.
  - Research excerpts for the copy check.
  - Offered media.
  - The production record.
- **`scrollDraftJsonSchema()`.** The JSON Schema of the canonical draft, for providers that constrain decoding. The writer does not use it.
- **`validateDraft` stages.** They run in order and stop at the first stage with findings:
  1. `envelope`: one object, at most 32 levels deep, at most 256 KiB, the right version, no reserved or unknown types.
  2. `schema`: after `normalise.v1` (NFC; strings to spans; null-prototype copies, so an own `__proto__` key is just an unknown member).
  3. `structure`.
  4. `computation`: simulations.
  5. `evidence`: bindings, the honesty checks, offered media, and **no run of 9 or more words copied from a quote or excerpt in any reader-facing text**. Code bodies are exempt.
  6. `brief`: reading time.

  `REPAIR_HINTS` gives one fixed hint per code, and `repairItems` caps a repair at 32 items.
- **`compileDraft`.**
  - Builds the document and re-validates it as a stored revision (`publish`).
  - Records the bound claims, their sources, the resolved bindings and every stage in `ScrollProvenance`.
  - The same input gives byte-identical output, and compiling `draftFromDocument(document, bindings)` returns the same document.

## `scroll-document.v2` (D-120, D-121)

Status. **Implemented** (unit tests, and a recorded writer answer through the real harness over PostgreSQL): the document, `scroll-limits.v2`, `scroll-measures.v2`, the Earth & sky kit enums, `validateDocumentV2`, and the writer's authoring shape with its assembler and rules. **Not yet run on real MiniMax**: that is the S-0 spike (#471), whose result decides whether the shape stands. **Planned** (S-1, S-2): the reader and stage engine, negotiation and a client `parseDocumentV2`, coverage v2, play, and admission and storage of v2 documents. v1 documents, limits and measures are untouched and still govern the library.

Where it lives. `src/v2/` is the public model (`@knowscroll/scroll-model`). The writer's side is backend-only (`./producer`): `src/producer/v2/`.

### The document

A header like v1's (`assetId`, `revision`, `language`, `explanationUnitId`, `series`, `theme`, `kicker`, `title`, `dek`, `framing`), then:

| Field | Set by | Meaning |
|---|---|---|
| `misconception` | the recipe, by code | `{kind: 'myth', claim, source: {label, reviewed}}` or `{kind: 'none'}`. The source is a human-reviewed label, never model text. |
| `landmark` (optional) | the recipe, by code | `{key, name}`: what a locked Final call awards, like "The Leaning Axis" (D-188). Absent: the Scroll awards none. Never model text. |
| `stage` (optional) | the model's choices, settled by code | `{kit: 'earth-sky.v1', states[{stop, state, alt}]}`: the read stops that change the picture. `state` is `{view, earthAt, moonAt, focus}`, settled to what the view draws. Tilt, pins and Ray are derived from it and never stored. `alt` is derived by code. A plain Scroll has none. |
| `stops[]` | the model | `read` (optional heading, paragraph, optional line; `simple`), `call_it` (prompt, 2 or 3 options, `answer`, `explain`, `twist`, optional `commonGuess`, `simple`) and `final_call` (the same without a common guess, and with an optional `binding: {kind: 'tilt'}` that code sets from the recipe: the control the reader turns on the picture, D-187). Ids `s1`, `s2`, … by code. |
| `asides[]` | the model | `tangent`, `limits` or `definition`, with `anchorStop` (the stop it opens next to) and `collapsed`. |
| `recap` | the model | Up to 3 captions and `smallPrintAside`, the limits aside the "Small print" chip links to. |
| `askSuggestions[]` | the model | 1 to 3 questions for the Ask sheet. |
| `limitsVersion`, `measures`, `integrity` | code | `scroll-limits.v2`; `scroll-measures.v2`; the SHA-256 of the canonical JSON without `integrity`. |

### The 23 blocks of the design

The design's block table lists 12 new, 5 kept and 6 changed blocks. *Implemented* means schema, limits, validation and assembly exist and are tested. *Planned* means nothing exists yet.

| Block | Design | Here |
|---|---|---|
| `stop` | new | implemented (a `read` stop; holds heading, paragraph and line) |
| `line` | new | implemented, inside a stop (at most 12 words) |
| `paragraph` | kept | implemented, inside a stop |
| `heading` | changed | implemented, inside a stop (level 1 or 2, rare) |
| `aside` | new | implemented (a limits aside is required and never last) |
| `stage` | new | model implemented (Earth & sky kit; the physics is derived by code, D-124); stage engine and drawing planned (S-1b) |
| `call_it` | new | implemented as a stop; locking in, sparks, combo and the Plot twist reveal are play, implemented (S-2: `modules/play`, `packages/client-core/src/play-session.ts`) |
| `final_call` | new | implemented as the last stop (S-3): judged on the server like a Call it, a combo bonus (`sparksEarned`, D-187), an optional `binding: tilt` that hands the reader Earth's tilt on the stage, and the document's `landmark` it awards (D-188). No `bind_stage` for other kits and no simulation formulas for it: the tilt is the kit's physics in code |
| `recap` | new | implemented |
| `scale`, `scene`, `sort`, `fork`, `guide` | new | planned (slice 8) |
| `quote`, `table`, `code`, `media` | kept | planned |
| `list`, `diagram`, `chart`, `simulation`, `figure` | changed | planned |

The design cuts or merges `sequence`, `comparison`, `callout`, `disclosure`, `timeline` and `subheading`, the "Text version of diagrams" toggle, and "limits as the last block". None of them is built in v2.

### Limits (`scroll-limits.v2`) and measures (`scroll-measures.v2`)

| Rule | Value | Code when broken |
|---|---|---|
| Stops and calls | 6 to 14 | `stops_too_few`, `schema_too_big` |
| Read stops (the units a facet binds to, D-127) | at least 3 | `read_stops_too_few` |
| A stop's text and line together | at most 60 words; the line at most 12 | `stop_too_long`, `line_too_long` |
| Explanation, twist, aside text, `simple` | at most 60 words each | `stop_too_long`, `simple_too_long` |
| Stage | at most 1; at least 3 states, the first on the first stop, in stop order, on read stops only (never on a call), each settled to what its view draws and described by code | `stage_too_static`, `stage_first_state_missing`, `stage_states_unordered`, `stage_state_on_call`, `stage_state_unsettled`, `stage_alt_mismatch` |
| Final call binding | a `tilt` binding needs a stage whose picture at the Final call changes when the tilt is turned (`tiltMatters`): a view that draws the axis and the season, in a month that is not March or September | `final_call_binding_invalid` |
| Calls, Final call included | at most 4; at least one Call it; exactly one Final call, the last stop, whose question and correct answer are not near-identical to an earlier call's (content-word overlap below 0.6, D-126) | `call_budget_exceeded`, `call_it_missing`, `final_call_missing`, `final_call_misplaced`, `final_call_restates_call` |
| Other interactives | at most 2 (none is built; a constant only) | n/a |
| Limits aside | at least one, anchored before the Final call, linked from the recap | `limits_aside_missing`, `limits_aside_last`, `recap_small_print_unknown` |
| Common guess | only the first Call it of a myth Scroll; a wrong option; the recipe's source | `common_guess_missing`, `common_guess_invalid`, `common_guess_unexpected` |
| Reading time | words at 230 a minute plus 10 seconds a call: 180 to 360 seconds | `reading_length_out_of_brief` |
| Document | 128 KiB; measures and hash recomputed | `document_too_large`, `measures_mismatch`, `integrity_mismatch` |

What counts as a word, and what does not (`simple` texts), is in D-121. `validateDocumentV2` returns `valid {document, notices}` or `invalid {issues}`. A notice (`misconception_source_unreviewed`) does not refuse the document.

### Delivery and reading (D-128, D-129)

Status: **implemented**, unit-tested.

- `parseDocumentV2(input, {verify?})` is the client path: the size, the schema, the budget and the structure
  rules, with the measures, the reading time and the hash checked only with `verify: true` (as v1's
  `parseDocument`). `validateDocumentV2` always verifies.
- `negotiateV2(document, capabilities)` offers the document whole to a client that declares
  `scroll-document.v2`, and reports `unsupported-document` to any other. A v2 document has no blocks to
  substitute.
- `INTERACTION_KINDS_V2`: a call reports `locked` or `revealed`, nothing else. No kind carries the option
  picked or whether it was right (D-063).
- `tallyOf` / `talliesAfterEach` / `sparksEarned` / `finalBonusReady` (`src/v2/play.ts`, D-064, D-180, D-187): the sparks and combo of a Scroll's calls in the order locked: a spark for each right call, a second one for a right Final call after a combo of two or more (`COMBO_FOR_FINAL_BONUS`), the combo a run of right calls, a wrong call keeps the sparks and ends the run. A device uses it to show play at once and while recording is paused; the server judges every lock from the stored revision with its own copy of the rule (`modules/play/domain`), and a test runs both over every run of calls. `landmarkTier` is the finish of a landmark: gold for a right Final call, plain otherwise (D-188). It sums nothing across Scrolls.
- `./internal` has `ScrollProvenanceV2` (`scroll-provenance.v2`): the claims, sources, production record
  and, per stop, aside and recap, the claims it cites.

### The kit

`EARTH_SKY_KIT` (`earth-sky.v1`) is the one kit: the Sun, Earth with its tilted axis, its orbit, Ray the sunbeam, a pin in each hemisphere and the Moon. A writer chooses only four things, from closed word lists (D-124):

| Key | Words |
|---|---|
| `view` | `sun-earth`, `orbit` (to scale), `orbit-stretched`, `earth-close`, `moon-orbit` |
| `earthAt` | the month, `jan` to `dec` (March and September are the equinoxes, June and December the solstices) |
| `moonAt` | `off`, `new`, `first-quarter`, `full`, `last-quarter`; only the Moon view has a Moon |
| `focus` | `none`, or a part the view draws |

Code derives the rest, by `stagePhysics` and `settleStageState`:

- Earth's tilt is 23.4 degrees in every picture. There is no word for a different one.
- A table of the lean toward the Sun by month (the sine of the year) says which half leans toward it. That half has a high Sun, a warm pin and a steep Ray; the other half the opposite; at the equinoxes neither leans and both pins are neutral.
- `settleStageState` sets aside what the view does not draw: the month where the view has no seasons, a Moon phase where there is no Moon, a focus on a part that is not there. `stageParts(view)` lists what each view draws.
- `describeStageState` writes the text version and accessible name from the settled state, so it cannot contradict the picture.

**The tilt of the Final call (D-187).** A Final call may hand the reader Earth's tilt (`binding: tilt`, from the recipe). `TILT_RANGE` (0 to 90 degrees in whole degrees) and `physicsAtTilt(state, tilt)` work out the Sun's latitude (`asin(sin(tilt) · sin(season))`, `sunLatitudeDegrees`), each pin's distance from it and which half leans toward the Sun, and `describeStageAtTilt` writes the text version for that tilt. At today's 23.4 degrees they agree with `stagePhysics` and `describeStageState` in every month. Properties are tested over every month and whole degree of the range. Nothing of a reader's tilt is part of a document or of what a device reports.

Properties tested for every month and view: the pins and Ray agree with the season of each hemisphere (against the noon Sun height computed in the test), the halves mirror six months apart, and no description says the axis is on its side. A call never carries a stage state. Which recipes get a stage is recipe data, not the kit's: see `stageKit` in the content module's library plan (D-125).

### The writer's shape (`./producer`)

`scroll-authoring.v2` is one flat list of `items` (`stop`, `call_it`, `final_call`, `aside`) plus `recap` and `askSuggestions`: no ids, no indexes, the correct option first (and, in the first `call_it` of a myth Scroll, the wrong option that states the myth second: code marks it as the common guess, so there is no number to count, D-126), an aside after the item it belongs to, and a stage patch of the four choices above on stops only.

- `assembleScrollV2` turns it into the document, deterministically.
- `compileAuthoredV2` runs the authoring rules (citations and figures, copying, where an aside sits, the stage against the recipe's variant, and that a stage Scroll never calls Earth's axis sideways: `earth_axis_sideways`), assembles, runs `validateDocumentV2`, and returns the document with the claims each part cites, or merged findings located at the writer's items.
- `REPAIR_HINTS_V2` is the repair catalogue. It is its own because the v1 catalogue is near the harness's limit of 128 codes.
- `authoringReferenceV2(variant)` is the prompt's description of the shape, built from the same tables as the schema.

## Fixtures

The labelled examples are CI fixtures, not product content (`production.kind: "fixture"`):

| Fixture | What it exercises |
|---|---|
| `attention-slowly` | Drag-to-target diagram, heatmap chart with an anchored caption number, illustrative slider simulation, disclosure with code, table |
| `weight-other-worlds` | Non-illustrative simulation with a personal input and cards, value bindings for its range and default, anchored fallback-text numbers, bar chart |
| `spring-neap-tides` | Step-through diagram on the grid layout, illustrative slider simulation with cards and bands, timeline. Its two claims are the real passages from the frozen v1 library pack `1aca9029bc97`. |
| `seasons-stage-ci` | A `scroll-document.v2` about the seasons: a stage with seven states, two Call its and a Final call, a tangent and a limits aside, a recap. It is the reader's fixture (S-1c): its title and kicker say it is a CI fixture, its measures and hash are checked by `seasons-fixture.test.ts`, and `fixtures/regenerate-v2.mjs` rewrites it after a deliberate change to the v2 rules (`pnpm --filter @knowscroll/scroll-model build && node packages/scroll-model/fixtures/regenerate-v2.mjs && pnpm format`). |

Layout:
- `fixtures/documents/<name>.json`: the exported consumer documents.
- `fixtures/producer/<name>.{draft,provenance,internal}.json`: the inputs and internal provenance. Not exported, and not reachable from clients.

To regenerate after a deliberate change: `pnpm --filter @knowscroll/scroll-model fixtures && pnpm format`. The fixtures test fails when the committed outputs differ from a fresh compile.

## Tests

Vitest with fast-check property tests, run in GitHub Actions only (D-010). They cover:

- **Limits:** accepted at the limit and refused above, including documents generated near the limits; every negotiated rendition of such a document validates.
- **Compile:** deterministic and idempotent compile; staged draft refusals with their codes.
- **Negotiation:** never drops an essential block silently.
- **Locators:** creation, validation, grapheme safety, and re-pointing that is never silent (rewrites and flipped personal flags included).
- **Simulations:** the full-grid proof. An adversarial generator includes poles and negative bars, so the test fails if the proof is removed. Evaluation stays finite and bounded for any schema-valid input.
- **Primitives:** typed outcomes for unknown versions, SHA-256 against Node's, canonical JSON, number tokens, lone surrogates.
- **Personal values:** excluded from snapshots by default.
- **Two paths (`client-path.test.ts`):** a simulation with a pole that only the grid proof can see is valid on the client path and refused on the admission path; declarations are refused on both; the hash is verified by `validateDocument` and admission always, and by `parseDocument` only on request; a single evaluated point is guarded (`outputsUsable`, `curveUsable`) and number text is never `NaN` or `Infinity`.
- **Timing (`performance.test.ts`):** the four budgets in *Limits and cost* (admission < 10 ms block and < 200 ms document; client < 1 ms block and < 20 ms document), as medians of the test process's CPU time on the runner; the wall-clock medians are printed beside them.
- **Copy check (`producer/copy-check.test.ts`):** a copied nine-word run is refused in each kind of reader-facing text (header, headings, captions, labels, accessibility text, fallback text, alt text, transcripts, table cells, readouts, notes), and only a code body is exempt.
- **Completeness of the text enumeration (`text-fields.test.ts`):** built from the block schema itself, it plants a marker in every free-text property of every block type and union branch and requires `textFields` to return it, so no text escapes the visible-text limit, the numeric check or the copy check.
- **Locale (`locale.test.ts`):** formatting and every fixture's integrity hash are unchanged when the runtime's locale-sensitive built-ins are replaced, and the package's own code uses none.
- **Display scale (`display.test.ts`):** the stored scale equals a brute-force scale over every grid point (fixtures, and generated simulations of every view); it is refused in a draft; admission refuses a scale that is not the one the grid gives and the hash covers it; the client path refuses a missing, non-finite, non-positive, inverted or wrong-kind display and reads the stored value; the public entry exports no scale, range or sweep function.
- **`scroll-document.v2` (`v2/*.test.ts`, `producer/v2/*.test.ts`):** every rule of the limits, the structure and the authoring checks has a case that breaks it and expects its code at the writer's item; a property test on the stage descriptions over every state; property tests on the option shuffle (the correct option is found where it went, the common guess follows it, the order is stable and not always the same); compile is deterministic; the measures hold 230 words a minute plus ten seconds a call. **Stage physics (`v2/kit.test.ts`):** every state of every view and month is settled, described and bounded; June and December are opposite seasons and March and September neutral; the lean table is the sine of the year; pins and Ray follow an independent noon-Sun calculation; the halves mirror; no description says the axis is on its side. **Earth's axis (`producer/v2/compile.test.ts`):** a sentence of a stage Scroll that joins "sideways" or "on its side" to the axis, lean or tilt is refused at the writer's item; the same words in a plain Scroll, or in another sentence, are not. **Restatement (`v2/similarity.test.ts`, `v2/validate.test.ts`):** a near-copy of an earlier call's question or answer is refused, a different question passes. **Common guess (`producer/v2/compile.test.ts`):** a two-option myth call whose second option states the myth passes, and the old numeric key is refused by the schema.
- **Rulings (`rulings.test.ts`):** no chart "inspect" interaction or glyph, one `explanationUnitId` with an optional series reference, no stored fallback text on text blocks.

`csp.test.ts` checks cold schema construction and the first parse with dynamic code generation refused, including the code-generation probe itself. The existing admission/client timing budgets run with the same jitless configuration.

`review-254.test.ts` reproduces each of the reviewer's proof-of-concept inputs (p1–p11) as a regression test. `review-254b.test.ts` does the same for the re-review (sentence breaks, accessibility text, display tolerance, the sweep above 1,024 points, unit exponents, the admission entry, the anchor map), with `primitives.test.ts` and `performance.test.ts` carrying the linear-cost cases.

## Interpretations

- **Block count.** D-012 counts "17 authored block types". The ruled list gives 16 authored types (figure and media are separate) plus `fallback`, which makes 17 in total.
- **Added document fields:** `corrections[]` (the persistent "Corrected" note belongs to a revision), `limitsVersion`, the optional `series`, and the rendition-only `rendition`. Measures carry per-block weights, so the server's coverage is fixed per revision.
- **Diagram interactions.** `toggle` is one labelled button per frame (2–8 frames). `steps` is Previous/Next.
- **Per-block hashes (design note, review minor 12).** The integrity hash covers the whole document, so a client cannot check that the blocks `negotiate` did not substitute are those of the stored revision: `rendition.sha256` proves what it received and `rendition.of` names the revision, nothing more. Giving every block its own hash (and hashing the hashes) would let a client verify the untouched blocks of any rendition. v1 does not: it adds about 70 bytes to each of up to 80 blocks, changes the canonical form, and verification on a device is the cost the M1 ruling avoids. The `scroll-document.v1` hash method is versioned (`canonical-json-sha256.v1`), so a block-hash method can arrive as a new method name without changing the stored blocks.
- **Judgement calls of the re-review, recorded.**
  - `framing` and `corrections[].summary` are reader-facing but written by the brief and the correction workflow, not the model, and no binding kind addresses them; they stay outside the numeric and copy checks and the visible-text count (the kicker, also code-set, is checked because it has a binding kind). They hold at most about 3,400 characters.
  - The structural literals (0, ±1, 2, 0.5) also exempt lookup values and breakpoints, band thresholds and parameter ranges, where one of them could in principle be a quantity. Constants are never exempt. Tightening it further would ask for a binding on every `[0, …]` range; not done.
  - `validateDocument` keeps its default `purpose: 'stored'` (the expensive, admission one) for compatibility; it is documented as admission, imported from `./admission`, and refused in client code by name.
  - dependency-cruiser excludes `dist/` by convention, so a relative import of `packages/scroll-model/dist/...` from client code is not seen by the client rules; the package specifiers, `src/` paths and `fixtures/producer/` are.
  - `package.json` preserves only the `zod.ts`/`zod.js` configuration module as a side effect; a client bundle may drop admission code it never calls (bundle size not measured).
- **"Binds all its numbers".** For a non-illustrative simulation this means every number it states except the structural ones, plus at least one binding. The structural numbers are not bindable quantities.
