# @knowscroll/scroll-model

The canonical declarative Scroll document, **`scroll-document.v1`**. This package holds:

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
| `@knowscroll/scroll-model` | everyone (server, worker, client) | Document and block schemas, limits, `validateDocument`, `parseBlock`, `negotiate`, `parseCapabilities`, locators and anchor maps, block state and snapshots, the telemetry payload, measures and coverage, simulation evaluation, `fallbackTextOf`, `textFields`, canonical JSON and SHA-256 |
| `@knowscroll/scroll-model/producer` | backend only | `ScrollDraft` (what the writer model returns), `DraftProvenance` (the compile input), `blockCatalogueText()` for the prompt, `validateDraft`, `compileDraft`, `draftFromDocument`, stages and repair hints |
| `@knowscroll/scroll-model/internal` | backend only | `ScrollProvenance` (claims, sources, bindings, checks, production record) and the honesty checks |
| `@knowscroll/scroll-model/fixtures/<name>.json` | tests only | The labelled consumer-document fixtures (`fixtures/documents/`). Drafts, compile inputs and internal provenance fixtures are not exported. |

Dependency direction, enforced by dependency-cruiser and proved by `pnpm boundaries:probe`:

```text
 apps/client, packages/{ui,client-core,design-tokens,scene-core} ──▶ scroll-model (public entry)
 packages/contracts (content.ts re-export)                        ──▶ scroll-model (public entry)
 packages/backend, apps/api, apps/worker                          ──▶ scroll-model, ./producer, ./internal
 ./producer ──▶ ./internal ──▶ public modules ──▶ zod
```

| Rule | What it enforces |
|---|---|
| `clients-never-import-scroll-internals` | Client code never imports `./internal` or `./producer`, whether by resolved path or by the bare package specifier (`@knowscroll/scroll-model/internal`). |
| `clients-never-import-scroll-producer-fixtures` | Client code never reaches `fixtures/producer/` (claims, sources, URLs). |
| `scroll-model-public-entry-is-self-contained` | The public modules never reach `internal/` or `producer/`, so a client cannot get them transitively. |
| `contracts-are-wire-only` | `contracts` may re-export scroll-model's public entry only. |
| `scroll-model-is-portable`, `scroll-model-depends-on-zod-only` | No Node built-ins, and no third-party package other than Zod, outside tests. |

## How it takes part in the reading journey

1. **Production (worker).**
   - The writer role returns one JSON object.
   - `validateDraft` checks it in stages.
   - `compileDraft(draft, provenance)` turns it into the immutable consumer document and its internal provenance.
   - Code, not the model, sets: missing ids, versions, gestures, text blocks' accessibility label, the "Illustrative" notice, framing, template, theme, series, reading time, coverage weights and the integrity hash.
2. **Storage.** The document is stored per revision and served to clients. The provenance is stored beside it and never served.
3. **Serving.**
   - The client advertises `ClientCapabilities`, and `negotiate` parses them (they are untrusted input).
   - `negotiate` returns the rendition for that client. It replaces each unsupported block with a `fallback` block and lists the essential blocks that degraded, so the caller can prefer another rendition, such as the Reel variant.
   - A rendition that substituted blocks carries `rendition {of, sha256}`, which the client can verify.
   - A rendition of a valid stored revision is always valid, because the stored limits hold for the worst rendition.
4. **Rendering.**
   - The renderer parses each block defensively (`parseBlock`). When it cannot render a block, it shows `fallbackTextOf(block)`.
   - `gesture` drives gesture arbitration, and `REDUCED_MOTION` drives reduced motion.
   - `projectText` and `isGraphemeBoundary` handle text selection.
   - Simulations use `evaluateSimulation`, `sampleCurve`, `cardsScale`, `plotRange`, `renderTemplate`, `readoutBand` and `formatNumber`. An illustrative simulation always shows its "Illustrative" notice.
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

### Coordinator rulings on the review of #254

- **Media cap.** At most 12 figure and media blocks per document.
- **Text blocks' fallback text** is derived at negotiation and render time (`fallbackTextOf`), never stored.
- **Numbers.** Digits and Unicode number forms (`\p{N}`) are checked. Number words are not required in v1.
- **Formatting.** English number formatting only in v1.
- **Charts and comparisons.** Chart "inspect" and comparison glyphs stay out of v1.
- **Explanation unit.** A single `explanationUnitId` per Scroll, plus an optional `series` reference.
- **Fixtures.** `./fixtures` exports consumer-document fixtures only.

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
| Text blocks: paragraph, subheading, list, quote, callout | `{id, type, version, a11y, essential, gesture, data}` | Code sets `a11y.label`. Code derives the fallback text on demand (`fallbackTextOf`). |
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
| `simulation` | 1–4 params; ≤ 12 constants; 1–6 outputs; view; readout bands; model note; `illustrative` | horizontal with a slider, else none | `{params}` | yes | update without morphing | no |
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

Bars, areas and plot ranges are scaled by code from the grid (`cardsScale`, `plotRange`), so no model-written display number exists.

**Proof over the whole grid.**
- The product of all the parameters' grid sizes must be at most **10,000** points (`sim_grid_too_large`).
- The validator evaluates every output at **every** grid point. Plot samples are grid values, so they are covered.
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
- web addresses in reader text.

## Honesty (`./internal`, evidence stage)

These checks are pure functions of a document and its provenance. They prove that every number a reader is shown or read is anchored to a claim. They cannot prove that the claim is true or that the prose says what the claim says; that is content review (blueprint §11).

1. **Every numeric token is anchored.**
   - A numeric token is a run of `\p{N}`: digits, fractions such as ⅜, superscripts such as ², and Roman numerals. `4,096` and `1.46` are one token each.
   - The rule covers **every reader-facing text**: title, dek, kicker, section headings, and every field `textFields` lists (prose, captions, labels, units, number-format suffixes, a11y label and description, fallback text, alt text, transcripts, table cells).
   - Each token must lie inside an anchor bound to a claim on that same field (`number_unbound`).
   - An anchor never crosses a sentence boundary (`binding_anchor_crosses_sentence`).
   - Exemptions: the **body of a code block**, because code is shown, never run, and is not a factual claim; and the `{key}` placeholders of a readout template, whose values are the simulation's own numbers.
2. **Every chart** has a claim binding for its data (`numeric_block_unbound`).
3. **A simulation that is not illustrative binds every number it states.**
   - The numbers covered (`simulationNumbers`): parameter min, max, step and default; constants; every literal operand; power exponents; lookup breakpoints; and readout band thresholds.
   - Constants take a `constant` binding; every other number takes a `value` binding by path.
   - Exempt: the structural numbers 0, ±1, 2 and 0.5.
   - Codes: `constant_unbound`, `simulation_number_unbound`. The simulation must also have at least one binding (`simulation_unbound`).
4. **Not checked.** Diagram edge weights are stroke emphasis, not quantities a reader is shown. `format.decimals` is display precision.

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

Checks run in order:
1. the envelope;
2. nesting depth;
3. canonical byte size;
4. unknown block types;
5. the schema;
6. counted limits;
7. per-block checks. Simulations are evaluated last, and only when every limit holds.

Outcomes:
- `valid`;
- `unsupported-version {schemaVersion}`;
- `invalid {issues}`. Rendition-specific codes: `rendition_integrity_mismatch` and `rendition_in_stored_document`.

### Other functions

| Function | Outcomes |
|---|---|
| `parseBlock(input)` | `block` · `unsupported {unknown-type \| unknown-version, envelope}` · `invalid {envelope, issues}`; the envelope keeps any valid id and fallback text |
| `negotiate(document, capabilities)` | `negotiated {document, substitutions, degradedEssential}` · `invalid-capabilities` · `unsupported-document` · `missing-baseline` (every client must render `fallback`, `paragraph` and `subheading`) |
| `validateLocator(document, locator, {personalConsent})` | `valid {sectionId, sectionHeading, quote, block}` · `invalid {reason}` |
| `buildBlockStateSnapshot(block, state, {includePersonal})` | `snapshot` · `stateless` · `invalid-state {problems}` · `too-large` |
| `deriveAnchorMap(previous, next, {moves})` | `derived {map}` · `invalid {reason}` |
| `repointLocator(locator, previous, next, map)` | `same {change: 'same'}` · `remapped {change, moved}` · `state-reset {change}` · `unavailable {block-removed \| block-type-changed \| passage-changed, sectionId}` · `invalid` |
| `validateDraft(raw, provenance)` | `valid {draft}` · `refused {stage, issues}` |
| `compileDraft(raw, provenance)` | `compiled {document, internalProvenance}` · `refused {stage, issues}`; a `publish` refusal means an internal bug, so escalate rather than repair |

`repointLocator` notes:
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
- **`blockCatalogueText()`.** The prompt description, generated from the limits tables (≈ 6.9 KB, test-bounded at 8 KB). It separates **rules code checks** from **guidance code does not check**. `scrollDraftJsonSchema()` is the much larger JSON Schema for constrained decoding.
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

## Fixtures

The labelled examples are CI fixtures, not product content (`production.kind: "fixture"`):

| Fixture | What it exercises |
|---|---|
| `attention-slowly` | Drag-to-target diagram, heatmap chart with an anchored caption number, illustrative slider simulation, disclosure with code, table |
| `weight-other-worlds` | Non-illustrative simulation with a personal input and cards, value bindings for its range and default, anchored fallback-text numbers, bar chart |
| `spring-neap-tides` | Step-through diagram on the grid layout, illustrative slider simulation with cards and bands, timeline. Its two claims are the real passages from the frozen v1 library pack `1aca9029bc97`. |

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
- **Timing (`performance.test.ts`):** a worst-case stored document validates in under 200 ms, and a worst-case simulation `parseBlock` takes under 5 ms (six outputs that all depend on every parameter, five of them fractional powers, over 10,000 points). These are medians of the test process's CPU time on the runner, which shares its cores with other suites; the wall-clock medians are printed beside them.

`review-254.test.ts` reproduces each of the reviewer's proof-of-concept inputs (p1–p11) as a regression test.

## Interpretations

- **Block count.** D-012 counts "17 authored block types". The ruled list gives 16 authored types (figure and media are separate) plus `fallback`, which makes 17 in total.
- **Added document fields:** `corrections[]` (the persistent "Corrected" note belongs to a revision), `limitsVersion`, the optional `series`, and the rendition-only `rendition`. Measures carry per-block weights, so the server's coverage is fixed per revision.
- **Diagram interactions.** `toggle` is one labelled button per frame (2–8 frames). `steps` is Previous/Next.
- **"Binds all its numbers".** For a non-illustrative simulation this means every number it states except the structural ones, plus at least one binding. The structural numbers are not bindable quantities.
