# @knowscroll/scroll-model

The canonical declarative Scroll document, **`scroll-document.v1`**: schemas, limits, validation,
version negotiation, passage and block locators, block state and snapshots, reading measures and
the evaluation of simulation formulas — plus, in separate backend-only entries, the producer
contract the writer model works to and the internal provenance a revision rests on.

Pure TypeScript and Zod. No React, no platform APIs, no Node built-ins outside tests: the API, the
worker and the Expo app (web and native) run the same code, so a document, an offset or a
simulation value means the same thing everywhere. Nothing in a document is ever executed: there is
no HTML, CSS, script, URL or expression language, and code blocks are shown, never run.

Blueprint: §6 (contracts; `ScrollDocument` lives here and is re-exported by `contracts/content.ts`),
§8 (Scroll qualification by weighted section coverage), §11 (production; approved blocks; no model
JavaScript), §17 (snippets: `scroll_passage`, `scroll_block`, block-state snapshots), §18 (Scroll
rendering contract, gesture arbitration, interaction recorder). Design and gap analysis:
`docs/v2/discovery/scroll-dsl.md` (B–E) and the block inventory at the end of
`docs/v2/discovery/design-screens.md`. Decision: D-012 on the integration branch.

## Entry points

| Entry | Who may import it | Contents |
|---|---|---|
| `@knowscroll/scroll-model` | everyone (server, worker, client) | document and block schemas, limits, `validateDocument`, `parseBlock`, `negotiate`, locators and anchor maps, block state and snapshots, telemetry payload, measures and coverage, simulation evaluation, canonical JSON and SHA-256 |
| `@knowscroll/scroll-model/producer` | backend only | `ScrollDraft` (what the writer model returns), `DraftProvenance` (compile input), `blockCatalogueText()` for the prompt, `validateDraft`, `compileDraft`, `draftFromDocument`, stages and repair hints |
| `@knowscroll/scroll-model/internal` | backend only | `ScrollProvenance` (claims, sources, bindings, checks, production record) and the honesty checks |
| `@knowscroll/scroll-model/fixtures/*.json` | tests only | the labelled example fixtures (below) |

Dependency direction, enforced by dependency-cruiser:

```text
 apps/client, packages/ui, packages/client-core ──▶ scroll-model (public entry)
 packages/contracts (content.ts re-export)       ──▶ scroll-model (public entry)
 packages/backend, apps/api, apps/worker         ──▶ scroll-model, ./producer, ./internal
 ./producer ──▶ ./internal ──▶ public modules ──▶ zod
```

- `clients-never-import-scroll-internals`: `apps/client`, `packages/ui` and `packages/client-core`
  never import `./internal` or `./producer`.
- `scroll-model-public-entry-is-self-contained`: the public modules never reach `internal/` or
  `producer/`, so a client cannot get them transitively.
- `contracts-are-wire-only`: contracts may re-export the public entry only.
- `scroll-model-is-portable` / `scroll-model-depends-on-zod-only`: no Node built-ins and no third
  party other than Zod outside tests.

## How it takes part in the reading journey

1. **Production (worker).** The writer role returns one JSON object. `validateDraft` checks it in
   stages; `compileDraft(draft, provenance)` turns it into the immutable consumer document and its
   internal provenance. Code — not the model — sets missing ids, versions, gestures, text blocks'
   accessibility label and fallback text, framing, template, theme, reading time, coverage weights
   and the integrity hash.
2. **Storage.** The document is stored per revision (served to clients); the provenance beside it
   (never served).
3. **Serving.** The client advertises `ClientCapabilities`; `negotiate` returns the rendition for
   that client, replacing unsupported blocks with `fallback` blocks and listing degraded essential
   blocks so the caller can prefer another rendition (the Reel variant) instead.
4. **Rendering.** The renderer parses each block defensively (`parseBlock`), shows its fallback text
   when it cannot render it, uses `gesture` for arbitration, `REDUCED_MOTION` for reduced motion,
   `projectText` for text selection, and `evaluateSimulation`, `sampleCurve`, `renderTemplate`,
   `readoutBand` and `formatNumber` for simulations.
5. **Reader state.** State (`BlockState`) lives on the device keyed by (account scope, epoch,
   asset, revision, block id); `defaultBlockState` and `blockStateProblems` restore or reset it.
6. **Sharing.** `createPassageLocator` / `validateLocator` for `scroll_passage`;
   `buildBlockStateSnapshot` (personal values excluded unless explicitly included) for
   `scroll_block`; `describeBlockState` for the server-rendered card.
7. **Evidence.** The recorder reports visible block ids and deliberate interactions
   (`blockInteractionPayload`, which never carries values); the server computes weighted coverage
   with `coverageOf` from the stored measures.
8. **Corrections.** A new revision is compiled with `corrections[]` from the correction workflow;
   `deriveAnchorMap` and `repointLocator` re-point old snippets and resume anchors, and every
   outcome says what happened — never a silent move.

## Coordinator rulings for scroll-document.v1 (D-012)

These are the rulings this package implements (logged as D-012 on `codex/release-knowscroll-v2`).

- **Blocks.** paragraph (inline marks; stable passage offsets in UTF-16 over the block's plain
  text), subheading, list, quote, callout (note / example / limit / key-idea / try-it), disclosure,
  code (displayed, never executed; horizontal scroll), table (≤ 5 × 12), figure and media
  (admitted asset references only, alt text required), comparison, timeline, sequence (stepper),
  diagram (authored nodes and edges and up to 8 authored frames switched by steps, toggles or
  dragging a token onto a target — no physics), chart (bar / line / scatter / heatmap, ≤ 200
  points), simulation (≤ 4 parameters with min / max / step / default / unit, optional
  `personal: true`; a closed set of formula kinds — linear, product, ratio, power, exponential,
  inverse-square, lookup — and a closed set of views; no expression grammar), and the
  server-emitted `fallback`. `predict_reveal` is not in v1 (it risks reading as a quiz).
- **Envelope.** Every block: `id`, `type`, `version`, `a11y` (label, description), `fallbackText`,
  `essential`, `gesture` (`none | horizontal | two-axis`), typed `data`. Reduced-motion behaviour
  is defined per moving type.
- **Document.** `schemaVersion`, asset id and revision, language, template (`poster | editorial`)
  and theme (family accent), kicker / title / dek, sections with headings, the explanation unit,
  framing (`factual | hypothetical | perspective`, with assumptions or lens text when not
  factual), reading time and coverage weights computed by code from content size, integrity hash.
  Internal provenance is a separate schema in `./internal`, which client packages must never import.
- **Honesty checks** (pure): a sentence containing a number binds a claim; a simulation not marked
  `illustrative` binds every constant to a claim; empirical numbers may not hide as literals in
  formulas.
- **Personal parameters** never enter telemetry payloads, and enter a snippet's block-state snapshot
  only when the sender explicitly includes them (`includePersonal`, default false).
- **Limits** `scroll-limits.v1` (table below). **Negotiation** by advertised capabilities.
  **Locators** `scroll_passage` and `scroll_block`, validated against a document, with an anchor
  map for re-pointing across revisions. **Producer**: `ScrollDraft`, a catalogue text of at most
  8 KB, staged `validateDraft`, `compileDraft(draft, provenance) → { document, internalProvenance }`.

## The document (`scroll-document.v1`)

| Field | Set by | Meaning |
|---|---|---|
| `schemaVersion` | code | `"scroll-document.v1"`; anything else is `unsupported-version` |
| `assetId`, `revision` | code | the immutable revision; a change is a new revision |
| `language` | brief | BCP 47 subset (`en`, `en-GB`) |
| `explanationUnitId` | brief | the explanation shared with the Reel variant (no double counting) |
| `template`, `theme.family` | brief | `poster` (E02) or `editorial` (E09-2); family accent from the design tokens (`learning-machines`, `systems`, `past`, `play`, `worlds`) |
| `kicker`, `title`, `dek` | brief, model, model | the poster or editorial header |
| `framing` | brief / scenario node | `factual`, `hypothetical {assumptions, kept}` (shown as "Hypothetical"; speculative premises live in the assumption text, D-006 a) or `perspective {lens}` |
| `sections[]` | model (ids may be code) | `{id, heading, blocks}`; only the first section may have `heading: null` |
| `corrections[]` | correction workflow | `{on, summary}` for the persistent "Corrected …" note |
| `limitsVersion` | code | `"scroll-limits.v1"` |
| `measures` | code | `scroll-measures.v1`: weight per top-level block, total, reading minutes |
| `integrity` | code | `canonical-json-sha256.v1`: SHA-256 of the canonical JSON without `integrity` |

Absent on purpose: sources, claims, quotes, model, prompt, run, reviewer, counts, navigation (Part 2,
Related and the end card are app chrome) and any per-reader data.

## Blocks

Every block is `{id, type, version: 1, a11y, fallbackText, essential, gesture, data}`. Text blocks
(paragraph, subheading, list, quote, callout) get their `a11y` label and `fallbackText` from code;
every other authored block needs both from the writer (fallback ≥ 40 characters).

| Type | Data (bounds) | Gesture (derived) | State | Interactive | Reduced motion | Passages |
|---|---|---|---|---|---|---|
| `paragraph` | spans (marks `em`, `strong`, `code`) ≤ 1,200 chars | none | — | no | — | yes |
| `subheading` | text ≤ 80 | none | — | no | — | no |
| `list` | bullet/number, 2–8 items ≤ 400 | none | — | no | — | yes (items joined by `\n`) |
| `quote` | pull / quotation, ≤ 400, attribution (quotation only) | none | — | no | — | yes |
| `callout` | note / example / limit / key-idea / try-it, title ≤ 60, ≤ 600 | none | — | no | — | yes |
| `disclosure` | summary ≤ 100, 1–6 reading blocks (paragraph, list, quote, callout, code, table, figure) | none | `{expanded}` | no | expand without animation | children |
| `code` | 16 languages, ≤ 4,000 chars / 120 lines / 160 per line, highlights, caption | horizontal | — | no | — | no |
| `table` | 1–5 columns × 1–12 rows, cells text / number / empty | none | — | no | — | no |
| `figure` | admitted still or loop, alt 10–300, caption | none | — | no | poster instead of loop | no |
| `media` | admitted video (poster + captions required) or audio, transcript, ≤ 60 s | none | — | yes | poster, no autoplay | no |
| `comparison` | 2–3 columns × 1–5 points | none | — | no | — | no |
| `timeline` | 2–12 events in order | none | — | no | — | no |
| `sequence` | 2–8 steps, optional step figure | none | `{step}` | yes | change step without sliding | no |
| `diagram` | ≤ 16 nodes, ≤ 24 edges, ≤ 8 frames, ≤ 4 groups; layouts flow-lr / flow-tb / radial / cycle / layers / grid (6 × 6 cells); interaction static / steps / toggle / drag-to-target | two-axis for drag-to-target, else none | `{frame}` | unless static | switch frame without transition | no |
| `chart` | bar / line / scatter / heatmap, ≤ 4 series, ≤ 200 points, axes with linear/log scale and domain | none | — | no | — | no |
| `simulation` | 1–4 params, ≤ 12 constants, 1–6 outputs, view, readout bands, model note, `illustrative` | horizontal with a slider, else none | `{params}` | yes | update without morphing | no |
| `fallback` | `{originalType, originalVersion, reason}` — emitted by `negotiate` only | none | — | no | — | no |

**Simulations.** Parameters are numbers on the grid `min + k·step` (`(max − min)/step` a whole
number ≤ 1,000) with a primary control (`slider | stepper | input`); text-version mode adds a
stepper for every number. Operands are numbers or keys (parameters, constants, earlier outputs).
Formula kinds: `linear` a·x + b, `product`, `ratio`, `power` scale·(x/base)^exponent (exponent
−4…4), `exponential` initial·e^(rate·x), `inverse-square` k/r², `lookup` (step or piecewise-linear
table of ≤ 12 increasing points, clamped). Views: `readout` (primary and secondary output),
`cards` (2–8 outputs with bars scaled to `barMax`), `plot` (an output as a curve over one
parameter's range, ≤ 200 samples), `area` (a parameter as a bar beside an output as a square).
`evaluateSimulation` is pure, constant-time per output and never throws; a non-finite value or one
beyond ±1e15 becomes `null` and renders as "—". The validator evaluates every output on a
deterministic grid of up to 256 parameter combinations (and every plot sample) and refuses
non-finite outputs, curves outside their domain and negative bars or areas.

## Limits (`scroll-limits.v1`)

A change to any value is a new limits version. Bench values, not measured optima.

| Ruled limit | Value | Code when exceeded |
|---|---|---|
| Document (canonical JSON, UTF-8) | 128 KiB | `document_too_large` |
| Sections | ≤ 12 | `schema_too_big` |
| Blocks (nested included) | ≤ 80 | `too_many_blocks` |
| Interactive blocks (simulation, sequence, media, non-static diagram) | ≤ 8 | `too_many_interactive` |
| Visible characters | ≤ 24,000 | `visible_text_too_long` |
| Parameters per block / in total | ≤ 4 / 16 | `schema_too_big` / `too_many_params` |
| Chart points | ≤ 200 | `chart_too_many_points` (or `schema_too_big` per series) |
| Diagram nodes / edges / frames | ≤ 16 / 24 / 8 | `schema_too_big` |
| Table columns × rows | ≤ 5 × 12 | `schema_too_big` |
| Code | ≤ 4,000 characters | `schema_too_big` |
| Passage quote | ≤ 600 UTF-16 code units | locator `range-too-long` |
| Saved block state (snapshot) | ≤ 1 KiB | `too-large` / locator `state-too-large` |

Per-field bounds that keep every string and list finite (also part of scroll-limits.v1; listed in
`FIELD_LIMITS`): kicker 40, title 90, dek 200, heading 80, a11y label 120 / description 600,
fallback text 40–1,200, 40 spans per text, paragraph 1,200, list 8 × 400, quote 400, callout 600,
disclosure 6 children, code 120 lines × 160, caption 300, table cell 120, alt 300, transcript 1,200,
media 60 s, comparison 3 × 5 × 240, timeline 12, sequence 8 × 500, diagram groups 4, labels 32,
frame description 400, chart series 4, bar categories 24, heatmap 12 × 12, constants 12, outputs 6,
lookup entries 12, cards 8, bands 6, template 160, slider positions 1,000, numbers ±1e15,
corrections 10.

## Failure behaviour

Everything returns a typed outcome; validators never throw on bad input and report stable reason
codes with paths, never the offending text (`REASON_CODES`).

| Function | Outcomes |
|---|---|
| `validateDocument(input, {purpose})` | `valid` · `unsupported-version {schemaVersion}` · `invalid {issues}` (unknown block types/versions get `block_type_unknown` / `block_version_unknown`) |
| `parseBlock(input)` | `block` · `unsupported {unknown-type \| unknown-version, envelope}` · `invalid {envelope, issues}`; the envelope keeps any valid id and fallback text so the renderer can still show something |
| `negotiate(document, capabilities)` | `negotiated {document, substitutions, degradedEssential}` · `unsupported-document` · `missing-baseline` (every client must render `fallback`, `paragraph` and `subheading`) |
| `validateLocator(document, locator, {personalConsent})` | `valid {sectionId, sectionHeading, quote, block}` · `invalid {reason}` |
| `buildBlockStateSnapshot(block, state, {includePersonal})` | `snapshot` · `stateless` · `invalid-state {problems}` · `too-large` |
| `deriveAnchorMap(previous, next, {moves})` | `derived {map}` · `invalid {reason}` |
| `repointLocator(locator, previous, next, map)` | `same` · `remapped` · `state-reset` · `unavailable {block-removed \| block-type-changed \| passage-changed, sectionId}` · `invalid` |
| `validateDraft(raw, provenance)` | `valid {draft}` · `refused {stage, issues}` |
| `compileDraft(raw, provenance)` | `compiled {document, internalProvenance}` · `refused {stage, issues}` (`publish` means an internal bug: escalate, do not repair) |

A stored revision may not contain `fallback` blocks; a client rendition (`purpose: 'rendition'`)
may, and keeps the stored revision's integrity member (integrity identifies what was stored, not
what one client was shown).

## Locators, state and telemetry

- `scroll_passage {assetId, revision, blockId, start, end, quoteHash}`: `[start, end)` in UTF-16
  code units over the block's `text-projection.v1` (the concatenation of its spans; list items
  joined by `\n`), at most 600 units, never splitting a surrogate pair; `quoteHash` is the SHA-256
  of the quoted text.
- `scroll_block {assetId, revision, blockId, blockType, blockVersion, state?}` with an optional
  `{state, personalIncluded}` snapshot that must fit the block (parameters on their grid, frame or
  step that exists) and stay within 1 KiB.
- **Personal values.** `buildBlockStateSnapshot` drops personal parameters unless
  `includePersonal: true`; `validateLocator` accepts a personal value only when the snapshot says it
  was included and the sender confirmed it (`personalConsent`). `BlockInteractionPayload` is
  `{blockId, blockType, blockVersion, kind}` and nothing else, so no value reaches telemetry.
- **Anchor map** `scroll-anchor-map.v1`: one entry per block of the previous revision —
  `same | updated | text-changed | state-changed | type-changed | removed` — with declared moves
  checked. Passages in changed text re-anchor only when their exact quote occurs once.

## Measures (`scroll-measures.v1`)

Weights in word-equivalents: text blocks their word count (minimum 5), subheading 2, code 10 + 3 per
line, table 10 + 2 per cell, figure 20, media 20 + 1 per 400 ms, comparison and timeline their words
(minimum 10), sequence 10 + words, diagram 40 + 10 per frame, chart 45, simulation 60 + 15 per
parameter, disclosure 5 + 30 % of its children. Reading minutes = round(total / 200), at least 1.
`coverageOf(document, seenBlockIds)` gives the weighted fraction overall and per section.

## The producer contract (`./producer`)

- `ScrollDraft` (`scroll-draft.v1`): `{draftVersion, title, dek, sections[{id?, heading,
  blocks}], bindings}`. Blocks are `{id?, type, a11y?, fallbackText?, essential?, data}` with the
  same data as the document; inline text may be a plain string. `version`, `gesture` and `fallback`
  blocks are refused — code sets them. Bindings: `passage {claimId, blockId, anchorText}` (exact and
  unique in that block), `constant {claimId, blockId, constantKey}`, `block {claimId, blockId}`.
- `DraftProvenance` (`scroll-draft-provenance.v1`): publication identity, template, theme, kicker,
  framing, corrections and target minutes chosen by code; the offered claims and their sources;
  research excerpts for the copy check; offered media; the production record.
- `blockCatalogueText()`: the hand-written prompt description of every authored block, formula
  kind, view, binding and rule, generated from the limits tables (≈ 5.7 KB, test-bounded at 8 KB).
  `scrollDraftJsonSchema()` is the much larger JSON Schema for constrained decoding.
- `validateDraft` stages, in order, stopping at the first with findings: `envelope` (one object,
  ≤ 256 KiB, version, no reserved/unknown types) → `schema` (after `normalise.v1`: NFC, strings to
  spans) → `structure` → `computation` (simulations) → `evidence` (bindings, honesty checks, offered
  media, no run of 9 or more words copied from a quote or excerpt) → `brief` (reading time).
  `REPAIR_HINTS` gives one fixed hint per code for the single repair attempt; `repairItems` caps a
  repair at 32 items.
- `compileDraft` then builds the document, re-validates it as a stored revision (`publish`) and
  records the bound claims, their sources, the resolved bindings (anchor text → UTF-16 ranges) and
  every stage in `ScrollProvenance`. Same input, byte-identical output; compiling
  `draftFromDocument(document, bindings)` returns the same document.

## Fixtures

`fixtures/` holds three labelled examples (`production.kind: "fixture"`, CI fixtures, not product
content): `attention-slowly` (drag-to-target diagram, heatmap chart, slider simulation, disclosure
with code, table), `weight-other-worlds` (simulation with a personal input and cards, bar chart) and
`spring-neap-tides` (step-through diagram on the grid layout, slider simulation with cards and
bands, timeline; its two claims are the real passages from the frozen v1 library pack
`1aca9029bc97`). Each has `*.draft.json` + `*.provenance.json` (inputs) and the committed
`*.document.json` + `*.internal.json` (outputs). Regenerate after a deliberate change with
`pnpm --filter @knowscroll/scroll-model fixtures && pnpm format`; the fixtures test fails when the
committed outputs differ from a fresh compile.

## Tests

Vitest with fast-check property tests, run in GitHub Actions only (D-010): limits, idempotent and
deterministic compile, negotiation never dropping an essential block silently, locator creation
and validation, re-pointing that is never silent, formula evaluation staying finite and bounded for
any schema-valid input, typed outcomes for unknown versions, SHA-256 against Node's, canonical JSON,
personal-value exclusion and staged draft refusals with their codes.

## Interpretations and open points

- D-012 counts "17 authored block types"; the ruled list is 16 authored types (figure and media
  are separate) plus `fallback` = 17 in total. Implemented as listed.
- Additions beyond the ruled document fields: `corrections[]` (the persistent "Corrected" note is
  part of a revision) and `limitsVersion`. Measures carry per-block weights so the server's
  coverage is fixed per revision.
- `toggle` is one labelled button per frame (2–8 frames); "steps" is Previous/Next.
- The numeric honesty check looks for digits only (not number words) and cannot bind section
  headings, title, dek or kicker; code blocks and simulations marked `illustrative` are exempt from
  the block-level rule. Only 0, ±1, 2 and 0.5 may appear as bare formula literals, in every
  simulation; other numbers must be declared, labelled constants.
- Number formatting is deterministic English-style (`,` grouping, `.` decimals); locale-aware
  formatting would be a new format version.
