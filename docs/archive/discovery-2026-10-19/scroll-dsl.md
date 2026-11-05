# Scroll document DSL — discovery and proposal (`scroll-document.v1`)

KnowScroll v2 programme · discovery note · 19 October 2026 · read-only research, no repository changed.

> **Status (S2.1, #230).** This proposal predates the implementation. `packages/scroll-model/README.md` is authoritative for what `scroll-document.v1` is. Among the differences, the model writes no display number: the `barMax` of `factor_cards` and the `y.domain` of `function_plot` below became a **bar scale and plot range computed by code once, at admission** (in the same pass that proves the outputs finite) and stored as `data.display`, which the draft schema refuses and the client only reads (D-012; the coordinator's ruling after the review of #254).

Inputs read:

- Blueprint `02d-greenfield-blueprint.md` §6, §8, §11, §17, §18, §21, §22 and `03-design-brief.md` (worktree `72-personal-universe-architecture`).
- Design v2.1 export: E02, E03, E05, E06, E08, E09, C04, H03, X01–X04, Components, V01, N01 and Main. I rendered E02, E03 and E09 in a browser and read the text of the others.
- Current product at `origin/dev` `106c4701` (16 Oct). I read the contracts, core, web and Android renderers, ADR-0041/0046, the writer, the `content/` library and the live-batch evidence.

Companion files are in `/Volumes/Mrigesh SSD/knowscroll-dev/v2/agents/scroll-model/`:

- `sketch/scroll-model.ts` is the Zod sketch. It is runnable.
- `sketch/examples/*.json` holds the worked examples.
- `sketch/check.ts` validates the examples against the sketch.
- `content/` holds the extracted library used for the statistics.
- To rerun: `cd sketch && node --experimental-strip-types check.ts`. It needs Node ≥ 22. `sketch/node_modules/zod` is a read-only symlink to the product checkout's `zod@4.6.5`.

---

## A. What exists today (current product, `origin/dev`)

### A1. Four Scroll representations that do not agree

| Representation | Where | Shape | Used for |
|---|---|---|---|
| `ScrollAsset` wire type | `packages/contracts/src/ledger.ts` | `{assetId, revision, kind:'Scroll', title, summary, body, sourceTitle, sourceUrl, truthState:'documented'}`. `body` is plain text, with paragraphs separated by blank lines. | Every Scroll the API serves, on Android and the web. Feed, Trace and Ask admit only `documented` Scrolls. |
| `webScrollArtifactV1` | `packages/contracts/src/web-scroll-artifact.ts`, `packages/core/src/scrolls/web-artifact.ts`, migration `0041_web_scroll_artifact.sql` | `schemaVersion:1, level:'declarative', assetId, revision`, then 1–24 `blocks` of 7 types. The types are `text{heading?, paragraphs 1–8}`, `disclosure{label, body≤1800}`, `comparison{title, left/right{label, points 1–5}}`, `timeline{title, events 2–8}`, `diagram{title, nodes 2–6, edges 1–10}`, `visualization{title, description, frequency 0.5–4}` and `code{title, language∈js/ts/python/text, code≤3200}`. It also has `accessibility{title}`, `provenance{kind: checked_model_scroll \| authored_test_fixture}`, `fallbackBodySha256`, `integritySha256` over canonical JSON, and a cap of 64 KB. | Web only, and only on request (`GET /v1/feed?webArtifact=v1`). A model-written Scroll's artifact holds only text blocks, one per beat. Rich blocks exist only in authored preview fixtures (`scripts/fixtures/web-rich-scrolls.ts`: tides and orbit). |
| Android `ScrollDocument` | `apps/mobile/.../ui/scroll/content/ScrollDocument.kt`, `ScrollBlocks.kt` | A separate vocabulary: `Prose`, `Heading`, `Image(url, alt, caption)`, `ComparisonSlider(label,left,right)`, `Diagram(label, nodes:List<String>)` and `Unsupported(type)`. It allows up to 128 blocks and 30 nodes. | The live reader calls `ScrollDocument.fromBody(item.body)`, so the whole Scroll renders as one prose block. The rich types appear only in `AuthoredPreview`. |
| Writer reply `scroll-reply-v1` | `packages/core/src/scrolls/writing.ts` | `{title, summary, beats[3–7], concepts[{code, role}], claims[2–6]{statement, truthState, concepts, quote, supportKind}}` | Model output. The beats become `body`, and the claims become substrate claims. |

**Validation** happens in three places, and the copies differ:

- **Server.** Zod checks the artifact. `validateScrollWebArtifact` then checks the asset, the revision, the hash of the body, the integrity hash and that diagram edges point at real nodes. Anything invalid returns `null`, and the client falls back to the body.
- **Web client.** `NativeScroll.tsx` parses the artifact again with Zod, then runs a hand-written `parseBlock` that repeats every rule.
- **Android.** Only `require(blocks ≤ 128)` and `require(nodes ≤ 30)`.

**Renderer registry:**

- **Web.** A `switch` in `BlockView`. React keys are `${type}-${index}`, so block identity is positional. Interactive state is `useState`, so nothing is kept across remounts, Share or Back. The `visualization` block is a single hard-coded sine wave. Its frequency slider is the only "simulation" kind that exists. If any one block is invalid, all blocks are dropped and the body paragraphs are shown with the notice "Part of this Scroll could not be displayed".
- **Android.** A `when` with `key(index, block)`. `Image` fetches any `https` URL, not an admitted asset. `ComparisonSlider` is a percentage slider with no meaning attached. An unknown type prints "This content type is not supported: X".

### A2. Claims and sources: stored, checked and hidden

- **Claims.** A claim is a statement plus a **verbatim quote** on a hashed **source snapshot** (ADR-0031). It carries `truthState`, concept links with roles (`subject|object|mechanism|context`) and `supportKind` (`supports|qualifies`). Claims are linked to the Scroll through `asset_claim`.
- **Material.** The fetched page text lives in `source_material` (ADR-0041 §2). A database guard requires its SHA-256 to equal the snapshot's hash. No API route reads it.
- **Sources stay hidden.** The owner decided on 24 September that readers never see a source. `sourceTitle` and `sourceUrl` are internal only. Checks refuse a web address in any reader-facing text. The live evidence confirms that no "NASA", "http" or ".gov" appeared on screen.
- **Passages.** A "passage" (ADR-0044) is *one claim of the Scroll at the revision read*, not a text range. `GET /v1/scrolls/:id/passages` lists the claim statements, and "seems wrong" is recorded against the claim.
- **Corrections.** A changed source makes a claim unsupported. The Scroll then becomes ineligible, its bindings are withdrawn, and the reader sees "withdrawn: what it was based on changed" (ADR-0040/0046).
- **Gap.** Claims are **not anchored in the prose**. Nothing records which sentence relies on which claim, and prose outside the claims is unchecked (ADR-0041 §9).

### A3. The writer (ADR-0041; the brief's "ADR-0046 writer")

ADR-0041 defines the writer. ADR-0046 connects it to demand and the Quartermaster: reuse, join, fund or cannot_meet, plus a worker loop over `supply_request`.

1. **Material.** Only from an allowlist (`material-hosts-v1`: NASA, NOAA/NWS and USGS public-domain hosts; OpenStax refused by name). Redirects are followed by hand and rechecked, the read is capped at 2 MB, HTML only. A page with too little text or a "page not found" title is refused.
2. **Request.** One bounded request (`scroll-writing-prompt-v1`): at most 16,384 bytes, `max_tokens` 4,096, thinking disabled. It offers 1–8 existing concept codes and the material, trimmed at a word boundary.
3. **Transport.** MiniMax-M3 over the subscription route. The key comes from the environment. Before each send there is a quota preflight and a file-locked session ledger. Each request is sent exactly once, with no retry.
4. **Reply parsing.** The reply must be exactly one JSON object. `<think>` blocks are dropped first, and an optional fence is accepted.
5. **Deterministic checks** (`scroll-checks-v2`), each with a reason code:
   - `quote_not_in_material` (exact passage required);
   - `copied_passage` (more than 8 shared consecutive words);
   - `mentions_web_address`;
   - length and count ranges;
   - concept rules: `concept_unknown`, `concept_not_offered`, `primary_not_one`, `duplicate_concept`, `claim_concept_not_offered`;
   - `no_supporting_claim`.
   A refused quote also gets a diagnosis code, never text (`quote-diagnosis-v1`).
6. **Admission and identity.** Admission is one transaction. The identity of an attempt is the pair (material hash, request hash), and a decided pair is never sent again. A refusal stores reason codes only, with no model text, so the 13 `quote_not_in_material` refusals in the first batch could not be read back (#181).
7. **Admission rates.** The first batch admitted 18 of 35. Round 2 (#211) admitted 36 of 106 pages. Roughly a third to a half of paid requests are refused, mostly for quote mismatch.
8. **Labelling.** Every Scroll is labelled `documented`, because the wire type admits nothing else, although only the quoted claims are checked (ADR-0041 §9).

### A4. The library and the quality of the 70 model-written Scrolls

**What is in the library.** There are **93 Scrolls**:

- **23 editorial Scrolls** in `content/editorial-scrolls.json`. These are hand-written, 72–93 words each, with one body and one source.
- **70 model-written Scrolls** in `content/model-scrolls/*.json`, added by #208/#211 on 8 October. The commit "57 → 93" counts the whole library.

**How a model-written pack is stored.** Each pack has the shape `{version, plan{url, conceptCodes}, identity{materialSha256, requestSha256}, material{url, title, text, retrievedAt}, reply (raw string), record{transport, model, inputBytes, usage, versions}}`. `content/README.md` and ADR-0041 still say model text is never committed. The packs were committed later, so the documentation is stale on this point.

**Statistics** (computed over all 70; script `scripts/stats.py`):

| Measure | Value |
|---|---|
| Model | MiniMax-M3, all 70 |
| Prompt and checks versions | `scroll-writing-prompt-v1` / `scroll-checks-v2`, all 70 |
| Hosts | science.nasa.gov 47, spaceplace.nasa.gov 13, nasa.gov 6, weather.gov 3, oceanservice.noaa.gov 1 |
| Beats | 4–7 (median 6) |
| Words | 117–300 (median **172**, about 1 minute of reading; the E02 design shows "6 min") |
| Claims | 4–6 (median 5) |
| Output tokens | 603–1,063 |
| Headings, blocks, interaction | none |

**Repeated topics.** About 7 Scrolls each cover seasons/tilt and climate warming. There are also 3 on black holes and 2 each on gravitational waves and sunspots. The allowlist confines every topic to astronomy and Earth science.

**Three representative Scrolls, read in full:**

1. **"How Orbits Are Just Continuous Falling Around a Planet"** (`09c8afcf30f9…`, from the NASA *Basics of Space Flight* chapter).
   - **What works.** It opens with a good hook, Newton's cannon.
   - **What fails.** The beats then paraphrase the page in order, like bullet points: periapsis/apoapsis burns, aerobraking, a list of perigee, perijove and perihelion. There is no arc and no *why speed matters*.
   - **Unchecked number.** "Roughly 30,000 km/h at about 150 km" sits in the prose with no claim behind it.
   - **Missing interaction.** A cannon-speed slider is the obvious centrepiece, and no format today can express it.
2. **"How the Moon's Pull Shapes Earth's Tides"** (`1aca9029bc97…`, NASA Moon/tides).
   - **What works.** This is the best of the three. It has a vivid opening, a mechanism, the timing nuance, the Sun's share, local effects, and the Moon flexing in return.
   - **Unchecked numbers.** "27 million times more massive" has no claim. "About half" relies on a claim whose quote only `qualifies` ("a little less than half").
   - **Missing interaction.** A spring/neap step-through or a Sun–Moon angle simulation is the natural centrepiece.
3. **"What a Black Hole Really Is"** (`83d1ef314877…`, NASA *for K-4*).
   - **What fails.** It reads like a flat encyclopaedia list written from a children's page, and the title promises more than it delivers.
   - **Hypothetical stated as fact.** "Tiny ones as small as a single atom with the mass of a mountain" restates the source's wording for hypothetical black holes as a bare fact, with no claim.
   - **Concept fit.** The primary concept is `astro.star.death`, which fits poorly.

**Verdict on quality.** The texts are correct in their quoted claims, readable and source-free. They are short, flat and textbook-like. Without sections, headings, figures or interaction, *section coverage* cannot mean anything. Prose sentences, especially numbers, are not tied to evidence, so a correction cannot point at the passage it affects. The format, not only the prompt, is what limits them.

### A5. Ideas to carry forward (concepts, not code)

| Carry forward | Why |
|---|---|
| **A closed declarative vocabulary with no model HTML, JS or code execution**, and an explicit "never executed" rule for code shown as text | Already the rule on both clients; the blueprint keeps it. |
| **Every rich document has a guaranteed readable text form** | The current body fallback is right in spirit. v1 makes it *per block* instead of all-or-nothing. |
| **The document is bound to its revision**: asset id + revision + an integrity hash over canonical JSON; an invalid, stale or future document degrades and never breaks the feed | `validateScrollWebArtifact` has the right instincts. |
| **Claims carry a verbatim quote on a hashed snapshot.** Material is private. Sources never reach readers, and checks refuse web addresses. | Strong, cheap and deterministic. v1 adds *anchoring* of claims in the document. |
| **Deterministic checks with versioned reason codes**; a rule change is a new checks version; diagnoses are codes | Auditable; owner-friendly. |
| **One bounded request per admitted attempt**, identity by input hashes, no transport retry, budget and ledger preflight | Matches blueprint §15. |
| **The copy check** (more than 8 shared words) and the hidden-source policy | Keep, and extend to every text field in every block. |
| **The truth-state vocabulary** (`documented, synthesis, interpretation, disputed, modelled, counterfactual, fictional`) | Already in `ledger.ts`. It maps onto v2 framing (what-if = hypothetical/speculative; simulations = modelled). |
| **The client opts in to a richer format** (`?webArtifact=v1`) | This is primitive version negotiation. v1 generalises it to advertised block capabilities. |
| **Corrections withdraw, the reader gets an honest notice, and a kept passage is pinned to the revision read** | The same concept appears in E05, H03 and Components. |

**Leave behind:**

- two client vocabularies;
- index-keyed blocks;
- the all-or-nothing fallback;
- Android's arbitrary-URL image;
- the `visualization` hard-coded sine;
- labelling model text `documented`;
- source fields on the wire type;
- "beats" as unstructured paragraphs;
- claims with no position in the text;
- refusals that leave nothing to diagnose. Keep a protected short-retention payload; see D5.

The v2 stack is one Expo/React Native app. A single TypeScript `scroll-model` package can therefore hold the schema, the expression evaluator, the text projection and the coverage weights, and the server, the web and native all run the same code. That removes the Kotlin/TypeScript duplication behind most of today's drift.

---
## B. Gap analysis: can the blueprint's ScrollDocument express v2.1?

The blueprint fixes the right principles:

- immutable block IDs and versioned block types (§18);
- semantic content with bounded parameters;
- accessibility text on every block, and a declaration of whether it captures gestures;
- state persisted by article revision + block ID;
- a client that advertises its blocks and gets a fallback for the rest (§6);
- snippets as `scroll_passage` or `scroll_block` locators with an optional block-state snapshot (§6, §17);
- qualification by section coverage weighted by content size (§8);
- nine approved blocks with no model JavaScript (§11).

It does **not** specify a schema. It names nine blocks and leaves the following undefined:

- sections;
- inline text;
- offsets;
- how a simulation computes anything;
- controls;
- framing and correction notes;
- the text-version mode;
- privacy of reader inputs;
- how anchors move across revisions.

The table lists every capability that E02/E03/E09, the snippet designs (H03, C04, Components) and the branch designs (X01–X04) need. "Blueprint" says what §6/§8/§11/§17/§18 already give.

| # | Capability needed (design source) | Blueprint | v1 answer |
|---|---|---|---|
| 1 | Header: topic kicker, title, dek, "A Scroll · 6 min" (E02, E06, E09) | Partial. "title" is listed as a *block*, with no dek, kicker or reading time. | `header{title, dek, form}`. The kicker comes from the canonical topic. The reading estimate is **computed by code**. |
| 2 | Sections with real h2 headings. They serve as resume labels ("At 'Why squared?'"), snippet-card labels ("Attention, slowly · Why squared?"), the fallback anchor when a revision changes, and rotor navigation (E02, H03, S01, V01). | Missing. §8 relies on "section coverage", but sections are not in the document. | `sections[]{id, heading, blocks}`, with stable section IDs. |
| 3 | Weighted section coverage (§8, §18 recorder) | Principle only | A registry `readingWeight(block)` (pure, versioned `coverage-weights.v1`). The client reports visible block IDs and dwell; the server computes coverage. |
| 4 | Prose with emphasis, bold and inline code, plus a reference to an earlier block ("the q @ k.T line is the n × n grid from before") (E02, E03) | Missing ("prose" undefined) | `RichText = Span[]` with marks `em`, `strong`, `code` and `ref → blockId`. |
| 5 | Stable passage offsets for native text selection, a share card that quotes the text, and "Read in context" (H03) | Partial ("validated text range", unit undefined) | A canonical plain-text projection per text-bearing block. Offsets are UTF-16 code units over NFC text. The locator carries the quote text plus its SHA-256 and context. |
| 6 | Resume anchor = revision + block ID + **offset within the block** (E02 Restore) | Partial | A `scroll_position` locator with a UTF-16 offset or a fraction. |
| 7 | 6×6 "every word × every word" heat grid with a highlighted row and caption (E02) | Missing (no data figure) | `chart` kind `heatmap` (static), or the `simulation` view `grid_matrix` when n is a parameter. |
| 8 | Text fallback "Diagram couldn't load · text version" with Retry, never a blank block (E02-4) | Partial ("safe readable fallback") | A required `fallback` rich text on every non-text block. The host renders it for unsupported or invalid types, failed media and render errors, and emits a diagnostic. |
| 9 | Global "Text version of diagrams" toggle; the diagram becomes a table and the slider becomes a stepper (E03-4) | Missing (alt text only) | The registry function `textAlternative(block)` returns a structured table or description. Every visual block must produce one, and steppers are an alternative control for the same parameter. |
| 10 | Draggable diagram: drag "it" toward a word and the edge weights change; Reset; Describe (E03-1) | Missing (the blueprint diagram is static) | `diagram.frames[]` plus `interaction: drag_to_target`. Each target selects a frame with its own edge weights and description. Weights are authored and bounded; there is no physics. |
| 11 | Step-through diagram or sequence (task brief; X04 outline) | Missing | `diagram` with `interaction: step` over frames, and a separate `sequence` block for text-led steps. |
| 12 | Comparison with small decorative glyphs per side (E03-2) | Partial ("comparison") | `comparison` columns with an optional `glyph` from a closed icon set. |
| 13 | Slider "Sentence length 512–4,096 → ~64× the work", with a sentence that changes by range (E03-2, H03) | Partial ("parameterised simulation", computation undefined) | `simulation{params, derive (closed formula kinds or expr@1), view: readout, bands}`. |
| 14 | Accessible slider: arrow = one step, Home/End, spoken valuetext; stepper alternative (E03 a11y) | Partial | `controls[]` bound to a parameter, with a `valueText` template. The stepper is a declared alternative control. |
| 15 | Numeric input with unit and stepper, "Your weight on Earth 60 kg", result cards ×0.17 … ×2.53 with bars (E09-4) | Missing | `simulation` view `factor_cards` plus `number_input` and `stepper` controls. Factors are constants bound to claims. |
| 16 | **A reader's personal input** (body weight) kept in block state and shared only if "Include how I set it" is chosen (E09, H03) | Missing (privacy of state undefined) | `param.sensitivity: 'personal'`. It is never sent in telemetry, excluded from snippets by default, and included only by an explicit choice; the server renders the summary. |
| 17 | Disclosure, expand/collapse persisted (E03-3) | Covered (name only) | `disclosure{summary, blocks[]}` with state `{expanded}`. |
| 18 | Static code: language label, Copy, horizontal scroll inside the block, line highlights (E03-3) | Covered (name only) | `code{language enum, code, highlightLines, caption, copyable}`. It captures horizontal gestures only when lines overflow. |
| 19 | Table ("Where 'it' looks: Word / Attention") (E03-4) | Missing | `table{caption, columns, rows, rowHeader}`. |
| 20 | Editorial register: "Essay · History of the sea", drop cap, illustrated figure with caption and alt (E09-2) | Partial ("illustration") | `figure{media ref → admitted asset, alt, caption}`, plus a closed `presentation{theme, dropCap}`. No CSS. |
| 21 | Content "character" (palette, imagery, rhythm) carried by the asset, not by a different screen template (E09) | Missing | `presentation.theme` from a closed token preset list (`poster, editorial, night, field`). |
| 22 | Persistent "Corrected 14 Oct. One claim was revised. What changed" banner (E02 states, Components) | Missing (correction lineage is internal) | `corrections[]{on, summary}` in the consumer document. Only the correction workflow writes it. |
| 23 | What-if / perspective framing that persists on **every** item: "Speculative scenario · not established science", "Changed: traffic ×10 · Kept: same model", "A Scroll · another perspective" (X01–X03, Components) | Partial (ScenarioNode has `truthMode`; the Scroll doesn't carry it) | `framing{kind: standard \| perspective{lens} \| what_if{truthStatus, changed[], kept[]}}`. It is copied from the ScenarioNode, and the validator requires an exact match. The renderer must show it. |
| 24 | Simulation honesty: "illustrative, not a forecast"; units and assumptions kept apart from prose (§14 scenario note; current tide fixture) | Principle only | A required `simulation.modelNote` and units on parameters and outputs. Formula constants are bound to claims in provenance. |
| 25 | Block-state snippet: "Try the diagram with sentence length set to 4,096 · Length 4,096", with an include/exclude toggle (H03, Components) | Partial ("bounded block-state snapshot") | A `scroll_block` locator with `{fingerprint, values}` and `included`. The server validates against the derived state schema and renders `stateSummary` from parameter labels. |
| 26 | Corrected snippet: "moment found (moved)" versus "moment changed" (H03, Components) | Principle ("explicit compatible mapping") | `revision.anchorMap[]` (block ID → block ID or `null`). Text ranges are remapped by exact quote search. State is restored only when the fingerprints are compatible. |
| 27 | "Block type changed → default settings, says so"; "revision changed → state reset with notice" (E03, H03) | Partial | Registry `stateFingerprint(block)`. The client restores state only when the fingerprints match or a declared clamp-migration applies; otherwise it resets with a notice. |
| 28 | Observations `scroll.block_coverage{blockId}` and `scroll.block_interaction{blockId, kind}`: deliberate and summarised, with no raw pointer frames (E02, E03) | Partial | Registry `interactionKinds` per block type. Unknown kinds are rejected; parameter values are never sent. |
| 29 | Gesture ownership per block: a slider owns a horizontal drag after the axis locks; code scrolls sideways; the diagram owns a 2D drag; the article never steals a claimed gesture (E03, N01, §18) | Covered as a principle | Registry `gesture(block) ∈ none \| tap \| horizontal \| pan2d`, derived from the configuration rather than written by the model. |
| 30 | Reduced motion ("every motion has a reduced form"); larger text up to 200% (V01) | Partial | Registry `reducedMotion` behaviour. Animated media requires a poster. Layout hints are relative (no pixels). |
| 31 | Explanation identity shared with the Reel ("Same explanation as a Scroll"), which keeps the Reel and the Scroll from being double-counted (E06) | Covered (PublishedEncounter) | `explanationUnitId` is referenced in the header. Navigation (Part 2, Related, end card) stays **out** of the document; it is app chrome built from ContinuityLinks. |
| 32 | Media: illustration, an animated loop with a poster, captions for any narration (E09) | Partial ("illustration") | `figure` (still or animated) and `media` (video/audio with required captions), both referencing **admitted** media IDs only. |
| 33 | Quiz-free "try it" | Missing | A `callout` of kind `try_it` invites the reader to use the block before it. `predict_reveal` lets the reader make a guess, then reveals the result, with no right/wrong, no score and no stored guess. |
| 34 | Callout / pull quote; a closing "What it can't do" limits section (E02-3, §11 "a lens and its limits") | Missing | `callout{kind: note \| example \| limit \| key_idea \| try_it}`, `quote{kind: pull \| quotation}`. |
| 35 | Language of the document; sizes that survive larger text | Missing | `language` (BCP-47). Limits are in characters, not pixels. |
| 36 | Claim ↔ text binding, so that a correction targets a passage and "seems wrong" on a passage finds its claim | Missing (and absent today) | `ScrollProvenance.bindings[]{claimId, blockId, range \| paramKey}`. These are internal and never in the consumer document. |
| 37 | Partial download / offline: "What's above stays readable" (E02-4) | Partial | The document JSON is one bounded, cacheable object (at most 128 KiB). The partial state applies to media and to blocks that failed to render. Streaming sections is *not* proposed; this is an open question for owner review. |

**Verdict.** The blueprint's ScrollDocument is the **right contract direction**, but as written it cannot express v2.1. Of the 37 capabilities, it covers 4 (#17, #18, #29, #31; two of these by name only). It covers 18 in part, mostly by naming a block or principle with no schema behind it. It misses 15 entirely. The missing ones are:

- sections;
- inline marks and offsets;
- table and chart;
- controls and computation;
- diagram frames and drag;
- the numeric input with personal sensitivity;
- framing;
- correction notes;
- text-version alternatives;
- claim anchoring.

No design screen needs arbitrary code. Everything shown is expressible with a closed registry and declared parameters, which confirms the blueprint's "no model JS" rule. The one stretch is E03's draggable diagram. Authored frames selected by drag-to-target express it honestly and accessibly, with no continuous physics. Section C is the schema that closes these gaps.

---
## C. Proposal: `scroll-document.v1` for `packages/scroll-model`

The complete, runnable sketch is `agents/scroll-model/sketch/scroll-model.ts` (Zod 4, about 1,300 lines). It includes the expression evaluator, checks, adaptation and locator validation. `sketch/check.ts` publishes the three examples and runs 51 assertions, including 24 refusal cases with named reason codes. **All 51 pass.** The excerpts below are trimmed for reading; the file is authoritative.

### C1. Design rules

1. **Declarative and closed.**
   - Every block is `{id, type, v, a11y?, fallback?, essential?, data}`. Type identity is `type@v` (`chart@1`).
   - No HTML, CSS, URLs, script, model code or `eval`.
   - Code is shown, never run.
   - Computation uses a **closed set of formula kinds**. One optional tiny expression grammar (`expr@1`) has hard limits.
2. **Three artefacts, three owners.** Keeping them apart is what keeps sources hidden from readers without losing the ability to correct.
   - `ScrollDraft`: what the model writes.
   - `ScrollDocument`: what readers get. It is immutable per revision.
   - `ScrollProvenance`: internal claims, bindings, checks and review.
3. **Computed fields come from code, never from the model.** Identity, framing, reading time, integrity hash, coverage weights, gesture ownership, the text alternative and the state schema are all derived by pure functions in `scroll-model`.
4. **Block state is local to the block.** Controls drive only parameters declared in the same block. There is no cross-block reactivity in v1, which keeps "share this block as set" well defined.
5. **Readable floor.** Every non-text block carries a standalone `fallback` (40–1,200 characters). Every client must implement `fallback@1`, `paragraph@1` and `subheading@1`.
6. **Offsets are defined once.** A UTF-16 code unit over the NFC plain-text projection of one block. JS (server, RN, web) and Android use the same unit.
7. **Strict schemas.** Unknown keys are rejected. A new field means a new block version. Old clients get a fallback instead of an unexpected shape.
8. **One TypeScript implementation.** The schema, `projectText`, `evalFormula`, `stateFingerprint` and `readingWeight` run identically in the API, the worker and the Expo app (web and native).

### C2. Layering

```text
 writer role (one bounded call)          publisher (pure)                       per-client rendition (pure)
 ScrollDraft  ──checks──repair≤1──▶  ScrollDocument rev N  ───────────────▶  adaptForClient(doc, caps)
  · header{title,dek,form}            · identity, language, topicIds           · unsupported block → fallback@1
  · presentation                      · header + estimatedReadingMinutes       · substitutions → diagnostic
  · sections/blocks (string | spans)  · framing (copied from ScenarioNode)     · integrity refers to rev N
  · bindings (anchorText/constant)    · corrections[], revisionInfo.anchorMap
                                      · integrity.canonicalSha256
                     └────────────▶  ScrollProvenance rev N (backend only): bindings with ranges, claims, checks,
                                      attempts, review, media rights — never in packages/contracts
```

### C3. Top-level document

```ts
export const ScrollDocumentV1 = z.strictObject({
  schemaVersion: z.literal('scroll-document.v1'),
  assetId: z.string().regex(/^scr_[a-z0-9_]{3,40}$/),
  revision: z.number().int().min(1),                  // immutable: a change is a new revision
  language: z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/),
  explanationUnitId: z.string(),                       // shared with the Reel variant (E06: no double counting)
  topicIds: z.array(z.string()).min(1).max(4),         // canonical topics; the UI derives the kicker label
  header: z.strictObject({
    title: plain(8, 90), dek: plain(20, 200),
    form: z.enum(['explainer', 'essay', 'walkthrough', 'comparison', 'perspective', 'what_if']),
    estimatedReadingMinutes: z.number().int().min(1).max(30), // computed: reading-estimate.v1
  }),
  framing: z.discriminatedUnion('kind', [               // copied from the brief / ScenarioNode, never model-authored
    z.strictObject({ kind: z.literal('standard') }),
    z.strictObject({ kind: z.literal('perspective'), lens: plain(3, 80) }),
    z.strictObject({ kind: z.literal('what_if'), truthStatus: z.enum(['hypothetical', 'speculative']),
                     changed: z.array(plain(3, 120)).min(1).max(4), kept: z.array(plain(3, 120)).max(4),
                     scenarioNodeId: z.string() }),
  ]),
  presentation: z.strictObject({ theme: z.enum(['poster', 'editorial', 'night', 'field']), dropCap: z.boolean() }),
  sections: z.array(z.strictObject({ id: Id, heading: plain(2, 80).nullable(), blocks: z.array(Block).min(1).max(30) })).min(1).max(12),
  corrections: z.array(z.strictObject({ on: IsoDate, summary: plain(10, 200) })).max(10),   // "Corrected 14 Oct. One claim was revised."
  revisionInfo: z.strictObject({ previousRevision: z.number().int().nullable(),
    anchorMap: z.array(z.strictObject({ from: Id, to: Id.nullable(), text: z.enum(['same', 'remap_by_quote', 'changed']) })).max(200) }),
  integrity: z.strictObject({ canonicalSha256: Sha256, limitsVersion: z.literal('scroll-limits.v1'),
                              coverageWeightsVersion: z.literal('coverage-weights.v1') }),
});
```

**Rendering rules for the header and framing:**

- Only the first section may have `heading: null` (the intro).
- `framing.kind === 'what_if'` must render a persistent, non-dismissable banner. Examples: "Hypothetical · Changed: traffic ×10 · Kept: same model", or "Speculative scenario · not established science".
- `perspective` renders "Another perspective · {lens}".
- These are words, not colours (X02/X03 accessibility).

**Fields deliberately absent from the consumer document:**

- sources, claims and quotes;
- model, prompt, run and reviewer;
- counts of anything;
- navigation (Part 2, Related and the end card are app chrome built from `ContinuityLink`);
- per-reader state.

### C4. Text, IDs and the block envelope

```ts
const Id  = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/);   // blocks, sections, nodes, edges, frames, items (URL-safe: /s/:id#why-squared)
const Key = z.string().regex(/^[a-z][a-zA-Z0-9_]{0,23}$/)  // params / constants / derives = expression identifiers
             .refine(k => !(k in Object.prototype) && !['x','i','j','pi'].includes(k));
const plain = (min, max) => z.string().min(min).max(max)    // single-line display text: trimmed, NFC, no control chars, no web address
const Span = z.strictObject({ t: z.string().min(1).max(1200), m: z.array(z.enum(['em','strong','code'])).optional(), ref: Id.optional() });
const RichText = (maxChars) => z.array(Span).min(1).max(40);   // + Σ t.length ≤ maxChars
// Producer drafts may write a bare string for unmarked text; normalise.v1 converts it to [{t}].

const envelope = {
  id: Id,                                   // unique across the document; stable across revisions while the block "means the same"
  a11y: z.strictObject({ label: plain(2, 120), description: plain(10, 600).optional() }).optional(), // required for non-text blocks
  fallback: RichText(1200).optional(),     // required for non-text blocks; also the "Describe"/text-version body
  essential: z.boolean().optional(),       // central to the argument: a fallback substitution is shown prominently and reported
};
// block = z.strictObject({ ...envelope, type: z.literal('<type>'), v: z.literal(1), data: <TypeData> })
```

**Text projection** (`text-projection.v1`) is the plain string that offsets index into:

- `paragraph`, `quote`, `callout` and `predict_reveal.reveal`: the concatenation of the span `t` values.
- `list`: the items joined with `\n`.
- `comparison`: the label and points per column.
- `sequence`: the step title and text.
- `timeline`: the label, title and detail.
- `table`: the cells joined with tab and newline.

Other blocks do not project, so passages cannot target them. They are shared as `scroll_block` snippets instead.

### C5. Block registry v1 (18 types)

The gesture, state, interaction kinds and text alternative are **registry functions of the block's data**. They are not fields the model writes.

| `type@v` | Purpose (design source) | Key typed data (bounds) | Persisted state | Gesture | `interactionKinds` | Text alternative / reduced motion |
|---|---|---|---|---|---|---|
| `paragraph@1` | Prose (E02) | `text: RichText(≤1,200)` | — | none | — | itself |
| `subheading@1` | h3 inside a section | `text: plain ≤80` | — | none | — | itself |
| `list@1` | Bullet or numbered list | `style`, `items 2–8 × RichText ≤400` | — | none | — | itself |
| `quote@1` | Pull quote or quotation | `kind: pull\|quotation`, `text ≤400`, `attribution?` (quotation only) | — | none | — | itself |
| `callout@1` | Note, example, limits ("What it can't do"), key idea, **try_it** prompt | `kind`, `title?`, `text ≤600` | — | none | — | itself |
| `disclosure@1` | Reveal (E03-3) | `summary ≤100`, `blocks 1–6` of paragraph, list, code, table, figure or callout | `{expanded}` | tap | expanded, collapsed | children |
| `code@1` | Static code (E03-3) | `language` (15-value enum), `title`, `code ≤4,000 chars / 120 lines / 160 per line`, `highlightLines ≤12`, `caption?`, `copyable` | — | horizontal when lines overflow | copied, scrolled_horizontally | `fallback` (what the code does) |
| `table@1` | Table (E03-4) | `caption`, `columns 2–5 {label, align, unit?}`, `rows 1–12 × cells (plain ≤120 \| number)`, `rowHeader` | — | none | — | itself |
| `figure@1` | Illustration (E09-2) | `media: {mediaId, revision}` (admitted asset only), `decorative`, `alt 10–300` (unless decorative), `caption?`, `fit` | — | none | zoomed | alt + caption. Animated assets use the asset's poster frame. |
| `media@1` | Short video or audio loop | admitted `media`, `kind`, `captionsTrackId` (required), `transcript ≤1,200`, `loop`, `maxDurationMs ≤60,000`; never autoplays with sound | — | tap | played, paused, captions_toggled | transcript. Reduced motion: poster, no autoplay. |
| `comparison@1` | Two or three ways (E03-2) | `title`, `columns 2–3 {label, glyph?, points 1–5}`, `caption?` | — | none | — | itself. Glyphs are decorative. |
| `timeline@1` | Ordered events | `scale: ordinal\|linear`, `events 2–12 {id, when{label, sort}, title, detail?}`, `interaction: none\|focus` | `{focus}` | tap (focus) | event_focused | the list of events |
| `sequence@1` | Step-through text | `steps 2–8 {id, title, text ≤500, media?, mediaAlt?}` | `{step}` | tap | step_changed | all steps as a list. Reduced motion: no slide. |
| `diagram@1` | Bounded diagram, step-through, draggable (E02, E03-1) | `layout` (flow_lr, flow_tb, radial, cycle, layers, grid), `nodes 2–16 {id, label ≤32, kind, group?, cell?}`, `edges ≤24 {id, from, to, label?, directed, style, weight 0..1}`, `groups ≤4`, `frames ≤8 {id, label, description, emphasis, edgeWeights?, hidden?}`, `interaction: none\|step\|select\|drag_to_target{token, targets 2–6 →frame, initialFrame}` | `{frame}` | pan2d (drag), tap (step or select), none | frame_changed, token_dropped, reset, described | a table of frames and their edge weights, plus each frame's `description`. Reduced motion: the frame switches with no tween. |
| `chart@1` | Data figure, heat grid (E02) | `spec: bar{categories ≤24, series ≤4} \| line/scatter{series ≤4 × points ≤60, ≤200 total} \| heatmap{≤12×12, values 0..1, highlightRow?}`, axes `{label, unit?, scale, domain?}`, `annotations ≤6`, `interaction: none\|inspect` | — | tap (inspect) | point_inspected, text_version_opened | a data table generated from the data |
| `simulation@1` | Parameterised simulation (E03-2, E09-4) | see C6 | `{param: value}` | horizontal (slider), tap otherwise | param_changed, reset, text_version_opened | a table of outputs at the current state, plus the stepper control. Reduced motion: no curve morphing. |
| `predict_reveal@1` | Quiz-free "try it": guess, then see | `prompt`, `guess: Param` (number or enum), `control: slider\|segmented\|stepper`, `answer{value, display}`, `reveal ≤600` | `{guess, revealed}` | horizontal or tap | guess_changed, revealed | `fallback`. No right/wrong wording or score, and the guess never leaves the device. |
| `fallback@1` | **Server-emitted only** in place of an unsupported block | `{original: 'chart@2', reason, text}` | — | none | — | itself |

Deferred, and why:

- inline math and formulas: plain Unicode "n × n" covers v1;
- glossary terms;
- embedding a Reel range inside a Scroll: it would blur Reel evidence;
- maps;
- 3D;
- cross-block reactive state;
- external links: none are allowed in v1, consistent with hidden sources.

### C6. Interactive state, controls and computation

```ts
const Param = z.discriminatedUnion('type', [
  z.strictObject({ key: Key, type: z.literal('number'), label, unit?, min, max, step, default,
                   scale: z.enum(['linear','log']), format: NumberFormat,
                   sensitivity: z.enum(['none','personal']) }),           // personal: body weight, age, income…
  z.strictObject({ key: Key, type: z.literal('enum'), label, options: [{value: Key, label}] /*2–6*/, default, sensitivity }),
  z.strictObject({ key: Key, type: z.literal('boolean'), label, default: z.boolean(), sensitivity }),
]);
const Control = z.discriminatedUnion('kind', [               // all bound to a declared param of the SAME block
  { kind: 'slider', param: Key, valueText: Template },        // number; arrows = 1 step, Home/End; valuetext spoken
  { kind: 'stepper', param: Key, stepMultiplier: 1..10, valueText: Template },  // number; the accessible twin of a slider
  { kind: 'number_input', param: Key },                       // number; numeric keyboard; clamps to [min,max] on the step grid
  { kind: 'segmented', param: Key },                          // enum
  { kind: 'toggle', param: Key },                             // boolean
]);
const NumberFormat = z.strictObject({ decimals: 0..4, grouping: z.boolean(), approx: z.boolean() /* "~" */, suffix: plain(1,8).optional() /* "×" */ });
const Template = plain(1,160) /* literal text + {key} placeholders only; keys must be declared params/constants/derives */;

const Formula = z.discriminatedUnion('kind', [               // closed kinds, evaluated by application code
  { kind: 'linear', x, a, b },                 // a·x + b
  { kind: 'product', of: Operand[2..4] },
  { kind: 'ratio', num, den },
  { kind: 'power', x, base, exponent: -4..4, scale },   // scale·(x/base)^exponent  ← "~64× the work"
  { kind: 'exponential', x, rate, initial },
  { kind: 'inverse_square', r, k },
  { kind: 'lookup', param: Key /*enum*/, values: Record<option, number> },
  { kind: 'expr', v: 1, expression: string /* ≤160, tiny grammar below */ },
]);                                            // Operand = number | Key (a string is a key reference)

const Simulation = { title, prompt?,
  params: Param[1..4], constants: {key, label, value, unit?}[0..12],
  derive: {key, label, unit?, formula: Formula, format: NumberFormat}[0..6],   // evaluated in order; may use earlier derives
  view: z.discriminatedUnion('kind', [                                         // closed visual templates
    { kind: 'readout', primary: Key, secondary?: Key },                        // big number + band sentence (E03-2)
    { kind: 'factor_cards', input: Key, outputUnit, items: {id,label,factor: Operand,glyph?,note?}[2..8], barMax, format }, // input × factor (E09-4)
    { kind: 'function_plot', curve: Key /* derive using x */, x: {from,to,label,unit?}, y: {label,unit?,domain}, marker?: Key, samples: 8..200 },
    { kind: 'grid_matrix', size: Key /* integer 2..12 */, labels?: plain[≤12], highlightRow?, count: Key },  // E02 n×n grid
  ]),
  controls: Control[1..4],
  readout?: { template: Template, bands: {output: Key, min?, max?, text}[0..6] },  // "Eight times longer, about sixty-four times the work."
  modelNote: plain(10,240),       // required: units, assumptions, "illustrative, not a forecast"
  illustrative: z.boolean(),      // false ⇒ every constant must be bound to a claim and no empirical literal may hide in a formula
};
```

**The tiny expression grammar `expr@1`.** It is optional. A client advertises it separately, and the server substitutes a fallback for clients that lack it.

```text
expr    := sum
sum     := product (('+' | '-') product)*
product := unary (('*' | '/') unary)*
unary   := '-' unary | power
power   := primary ('^' unary)?                    right-associative
primary := NUMBER | IDENT | FUNC '(' expr (',' expr)* ')' | '(' expr ')'
NUMBER  := digits ('.' digits)? (('e'|'E') ('+'|'-')? d d?)?
IDENT   := declared param / constant / earlier derive, or reserved x (plot variable), i, j (grid), pi
FUNC    := min max (2–4 args) | abs sqrt exp ln log10 sin cos rad round floor ceil (1) | clamp (3)
```

**What the grammar excludes:** strings, comparisons, conditionals, assignment, member access, indexing and user functions. Conditional wording uses `bands` instead.

**Limits:**

| Limit | Value |
|---|---|
| Length | 160 characters |
| Tokens | 64 |
| AST depth | 8 |
| Function calls | 6 |
| Literal exponent | ≤ 10 in absolute value |
| Numbers | finite, ≤ 1e15 in absolute value |

**How it is implemented and verified:**

- It is a hand-written Pratt parser in `scroll-model`.
- Function lookup uses a **null-prototype table with own-property checks only**. The sketch first resolved `constructor(1)` through `Object.prototype`. That is the same class of bug ADR-0041 already guards against for host names, and the test now covers it.
- Evaluation uses float64. A non-finite result renders "—".
- The validator evaluates every derive on a deterministic grid of up to 256 parameter combinations: min, max, default and evenly spaced steps. For a plot it also evaluates every x sample. It refuses `output_not_finite` and `plot_out_of_domain`.
- Each formula kind is versioned (`power@1`, `expr@1`) and advertised by the client.

**Honesty rules enforced by checks:**

- A non-illustrative simulation must bind every constant to a claim (`constant_unbound`).
- An empirical number may not hide as a literal (`literal_not_declared`). Only 0, ±1, 2 and 0.5 are allowed bare.
- `modelNote` is required and is rendered under the view.
- Parameter values from a `personal` parameter are never sent in telemetry. They enter a snippet only through explicit inclusion (C9).

### C7. Limits (`scroll-limits.v1`; bench values, and a change is a new version)

| Limit | Value | Reason |
|---|---|---|
| Document size (canonical UTF-8 JSON) | **128 KiB** | One cacheable fetch. The examples are 4–9 KB. A 6-minute, 24-block Scroll is estimated at 25–40 KB. |
| Sections / blocks per section / blocks in total (nested included) | 12 / 30 / **80** | About 2.5× the E02 article. |
| Interactive blocks / figure and media blocks | **8** / 8 | Attention and memory per article. |
| Visible text | 24,000 characters (about 4,000 words) | Larger than any Scroll the product has made: today's largest is 300 words. |
| Paragraph / span count / list item | 1,200 characters / 40 / 400 | Readable rhythm. |
| Parameters per simulation / in total / controls per block | **4** / 16 / 4 | |
| Derives / constants per simulation | 6 / 12 | |
| Slider positions ((max−min)/step) | ≤ 1,000 | |
| Chart series / points per series / points in total / heatmap side | 4 / 60 / **200** / 12 | |
| Diagram nodes / edges / frames / groups | **16** / 24 / 8 / 4 | Phone width; the E03 design uses 5. |
| Table columns / rows | 5 / 12 | |
| Code characters / lines / line length | 4,000 / 120 / 160 | |
| Expression characters / tokens / depth / calls | 160 / 64 / 8 / 6 | |
| Plot samples / validator grid | 200 / 256 combinations | |
| Passage quote / block-state snapshot | **600 characters** / **1 KiB** | |
| Corrections / anchor-map entries | 10 / 200 | |

### C8. Version compatibility

- **What the client advertises.** On session start and on the experience request, the client sends `ClientScrollCapabilities`:
  - `documentSchemas: ['scroll-document.v1']`;
  - `blocks: ['paragraph@1', …, 'fallback@1']`;
  - `simulationViews: ['readout@1', …]`;
  - `formulaKinds: ['power@1', 'expr@1', …]`.

  These are registered per client build, so the server can also decide from the build alone. `fallback@1`, `paragraph@1` and `subheading@1` are mandatory.
- **The server chooses the rendition.** `adaptForClient(doc, caps)` replaces each unsupported block (wrong `type@v`, view or formula kind) with a `fallback@1` block. That block keeps the same `id` and `a11y`, the original `type@v` and the block's `fallback` text. Each substitution is returned for a diagnostic record (`scroll.render_fallback{assetId, revision, blockId, original, reason: unsupported_by_client}`).
  - In the examples, a client without `function_plot` and `expr` gets the tides simulation as text. A client without `predict_reveal` gets the Mars guess as text.
- **Essential blocks.** If an `essential` block is substituted, the Composer is told (`essentialFallbacks > 0`). It can then prefer the Reel variant or another Scroll for that client, so a central argument is never silently replaced by a paragraph. When shown anyway, the UI labels it "This part needs an app update · text version".
- **The client stays defensive.** It parses the envelope first, then the block data through its registry. Invalid data, a render error or failed media produce the **per-block** fallback, with a Retry for transient media, and a client diagnostic. The rest of the article renders. This is the reverse of today's all-or-nothing rule.
- **Schema evolution.** Additive change is not allowed within a block version: the schemas are strict. Block `chart@2` can ship beside `chart@1`. The producer is offered the newest versions. A stored revision is never rewritten, and the integrity hash refers to the stored revision, not to a client rendition. A new document envelope (`scroll-document.v2`) is needed only for top-level changes.
- **Reader state across revisions.** Local block state is stored under `(accountScope, privacyEpoch, assetId, revision, blockId)` with the block's `stateFingerprint`. A fingerprint is a hash of the parameter, frame, step or event declarations.
  - When a newer revision arrives, the old state is restored if the block ID is the same and the fingerprint is unchanged.
  - If the same keys have new ranges, the value is clamped onto the new grid. This is the only automatic migration.
  - Otherwise the state resets with the notice "This diagram was updated; settings were reset" (E03).

### C9. Anchors, snippets and revision mapping

```ts
const ScrollLocator = z.discriminatedUnion('kind', [
  { kind: 'scroll_position', assetId, revision, blockId, offset: { unit: 'utf16', at } | { unit: 'fraction', at: 0..1 } }, // resume
  { kind: 'scroll_passage',  assetId, revision, blockId, range: [start, end],            // UTF-16 on the block's text projection
    quote: { text: string(≤600), sha256, prefix: string(≤32), suffix: string(≤32) } },
  { kind: 'scroll_block',    assetId, revision, blockId, blockType: 'simulation@1',
    state: { fingerprint, values: Record<key, number|string|boolean>, includesPersonal: boolean } | null },
]);
```

**Server validation of `POST /v1/snippets`** (`validateLocator` in the sketch):

1. Recheck access to the source and the destination.
2. The block exists in that exact revision.
3. For a passage, the block must project text, `0 ≤ start < end ≤ length`, `end − start ≤ 600`, `text.slice(start, end) === quote.text`, and the SHA-256 must match.
4. For a block, `blockType` must equal the block's current `type@v`, or the reason is `block_type_changed`. The state fingerprint must match, or the reason is `state_incompatible`. Values must pass the derived state schema, including the step grid (`state_invalid`). The state must be ≤ 1 KiB.
5. A **personal** parameter value is refused unless the sender explicitly chose to include it (`personal_state_not_confirmed`).
6. The card text is **rendered by the server**:
   - A passage card shows the quote plus "Attention, slowly · Scores become weights" (title · section heading).
   - A block card shows the block's `a11y.label` plus `stateSummary`, for example "Sentence length · 4,096 words".

   Client text is never shown on a card.

**When the source is corrected.** The new revision carries `revisionInfo.anchorMap`. This is consumer-safe: it contains block IDs only.

- An unchanged block keeps its anchor (implicit `same`).
- A changed text block maps by exact quote search in the new projection. Found means "moment found", shown with the mapped range. Not found means "this passage changed", with an offer to read the revised Scroll.
- A removed block (`to: null`) falls back to its section heading for resume. Its snippet says the passage changed.
- The server never moves a reference silently.

**Inside the provenance.** "Seems wrong" on a passage is resolved there. The passage's `(blockId, range)` overlaps one or more claim bindings, and the claim is never named to the reader. This replaces today's passage = claim shortcut.

### C10. Renderer contract

```ts
interface BlockRenderer<B> {
  typeVersion: `${string}@${number}`;          // 'diagram@1'
  data: ZodType<B['data']>;                    // shared from scroll-model
  Component: (p: { block: B; state: S | undefined; setState(s: S): void; textVersion: boolean;
                   reducedMotion: boolean; onInteraction(kind: string): void }) => ReactNode; // .web.tsx / .native.tsx where needed
  textAlternative(block: B): { kind: 'table'; caption; columns; rows } | { kind: 'paragraphs'; text: RichText[] };
  gesture(block: B): 'none' | 'tap' | 'horizontal' | 'pan2d';
  stateSchema(block: B): ZodType | null;  defaultState(block: B): S | null;  stateFingerprint(block: B): string;
  interactionKinds: readonly string[];
  readingWeight(block: B): number;             // coverage-weights.v1
}
```

**Host (`ScrollReader`) obligations:**

1. **Parsing.** Parse the envelope, then look up `type@v` in the registry. If it is missing → fallback. If the data is invalid → fallback plus a diagnostic. If the component throws → an error boundary shows the block's fallback plus a diagnostic. Never show a blank or skeleton block as if it had rendered.
2. **Global text-version mode.** The toggle in E03-4 renders `textAlternative` for every visual block and the stepper twin for every slider.
3. **Gesture regions.** These come from `gesture(block)`. The article scroll yields to `horizontal` only after the axis locks, and `pan2d` owns the drag until release. `tap` never blocks vertical reading. The native back edge stays with the platform (N01).
4. **State.** State lives in the account-scoped store keyed as in C8. It is restored on Back, Share or Ask return and purged on account or epoch change. Reset is a host affordance on every stateful block.
5. **Reduced motion and larger text.** These come from the OS or P01. Layout uses no pixel positions: diagram `cell` coordinates are a 6×6 grid, and layouts are relative.
6. **Framing and correction banners** render above the first section and cannot be hidden.
7. **The end of the article is a boundary** (E02-3). Continuation chrome is outside the document.

### C11. Telemetry and coverage

**What the client reports:**

- **`reading_summary`.** Visible block IDs, meaning at least 50% of the block visible for at least 600 ms with the reader active, plus active dwell per section and the deepest stable anchor.
- **`component_interaction`.** `{blockId, typeVersion, kind ∈ interactionKinds}`, summarised. It never carries parameter values, pointer paths or text.

**What the server computes.** Section coverage is computed with `readingWeight` (word-equivalents):

| Block | Weight |
|---|---|
| Text | its word count |
| Code | 10 + 3 per line |
| Table | 10 + 2 per cell |
| Figure | 20 |
| Diagram | 40 + 10 per frame |
| Chart | 45 |
| Simulation | 60 + 15 per parameter |
| Disclosure | 5 + 30% of its children |

This satisfies the blueprint's "weighted by meaningful content size", so passing several headings does not count. The same function gives `estimatedReadingMinutes` at 200 word-equivalents per minute, which makes the "6 min" honest and reproducible.

---
## D. Producer contract: the `scroll_writer` role

This follows the blueprint's §11 pipeline: research → claim/evidence package → angle and outline → compose → check → declarative Scroll → validate rendering → publish an immutable revision. It runs through §15's harness, with one bounded call per admitted attempt and no tool loop. The writer is one stage. It does not research and it does not decide publication.

### D1. What the writer is given (`ContextBundle`, `scroll-writer-context.v1`; frozen and hashed)

| Input | Content | Notes |
|---|---|---|
| Brief | explanation unit, angle or lens, depth, language, `targetMinutes [min, max]`, suggested `form`, topic **names** | From the `ContentDemand`'s public canonical brief. Never the reader's words or universe. |
| Framing | `standard`, `perspective{lens}` or `what_if{truthStatus, changed[], kept[]}` | Copied from the `ScenarioNode`. The writer writes *within* it. The publisher copies it into the document, so the model cannot alter it. |
| Continuity | series position "Part 2 of 3", previous part's title and a two-line gist, next part's topic; or "format variant of Reel X" with its script outline | Avoids repetition across parts and keeps one explanation identity. |
| Evidence package | ≤ 24 claims `{claimId, statement, truthState, quote}`, plus optional bounded research excerpts (≤ 8 KB) | Built and checked by the research stage. **No URLs, publishers or source titles** (the hidden-sources rule, and it removes any temptation to cite). |
| Block catalogue | A compact, hand-written description of the 17 producer blocks, formula kinds, views and limits, with two short exemplars (≈ 6–8 KB) | The full JSON Schema generated from the Zod draft schema is **61 KB** (measured), about 15k tokens, too large per call. Use it only for provider-side constrained decoding where the provider supports it, and cache it. |
| Admitted media | `[{mediaId@revision, description, suggested alt}]` | `figure` and `media` may only reference these (`media_not_offered`). |
| Previous revision (corrections only) | The prior document plus the list of blocks that must change | "Keep IDs of unchanged blocks." The anchor map is derived by code. |
| Budget | `max_output_tokens` and thinking policy from the role policy | Measured draft sizes are 4.5–9.2 KB for 1–2 minute examples. A 6-minute, about 24-block Scroll is roughly 25–35 KB, or 7–10k output tokens. Today's 4,096 cap is too small. Proposal: 12k. Option: a separate **outline** attempt first (sections, block plan, claim allocation), then the draft attempt. Both stay bounded. |

### D2. What the writer is asked to return

Exactly one JSON object matching `ScrollDraftV1`. Any `<think>` blocks are dropped by the adapter and never stored as memory.

```ts
ScrollDraftV1 = {
  draftVersion: 'scroll-draft.v1',
  header: { title, dek, form },
  presentation: { theme, dropCap },
  sections: [{ id, heading /* null only for the first */, blocks: DraftBlock[] }],   // text fields may be plain strings
  bindings: [
    { claimId, blockId, anchorText },     // anchorText: an exact, unique substring of that block's text
    { claimId, blockId, constantKey },    // a simulation constant rests on this claim
    { claimId, blockId, wholeBlock: true } // a diagram/chart/simulation as a whole relies on this claim
  ],
}
```

**Instructions to the model.** These become `scroll-writer-prompt.v1`; each line maps to a check.

1. Write an explanation, not a summary of the material. Give it an opening, a mechanism, an example and its limits. A closing `callout{kind:'limit'}` is recommended.
2. Use your own words. Never repeat 9 or more consecutive words from any quote or excerpt (`copied_passage`).
3. Mention no source, publisher, website or URL (`mentions_web_address`). Never describe or address the reader's identity.
4. Every sentence that contains a number must be covered by a binding to an offered claim (`numeric_unbound`). Every claim you rely on gets a binding whose `anchorText` is copied exactly from your own block text (`binding_anchor_not_found` / `binding_anchor_ambiguous`). Never invent a claim ID (`binding_claim_unknown`).
5. Use an interactive block only where doing something explains better than reading. Each one needs:
   - an `a11y.label`;
   - a standalone `fallback` text version of at least 40 characters;
   - for simulations, a `modelNote`, and `illustrative` set truthfully.

   Keep the total at 8 or fewer.
6. Simulations use only the listed formula kinds and views. Use `expr` only when no closed kind fits. When `illustrative` is false, every constant must be bound to a claim, and no empirical number may be written as a literal.
7. For a what-if, write conditionally ("if…, then in this model…"). Never present a consequence as an established fact. Speculative premises are named as speculative.
8. IDs are lowercase-hyphenated, meaningful (`why-squared`) and unique. When revising, reuse the IDs of unchanged blocks.
9. Stay within `targetMinutes`. The code computes this; the model does not state it.

### D3. Validation pipeline (pure; `scroll-checks.v1`)

| Stage | What | Reason codes (examples; the full list is in the sketch) | Repairable |
|---|---|---|---|
| 0 Adapter | Drop exposed thinking blocks; exactly one JSON object; raw reply ≤ 256 KB | `not_one_json_object`, `reply_too_large` | yes |
| 1 Schema | `ScrollDraftV1` strict (unknown keys, lengths, enums, plain-text rules) | `schema:<zod code>[:plain_text\|mentions_web_address]` + path | yes |
| 2 Normalise | `normalise.v1`: string → spans, NFC, whitespace. Recorded, never a refusal. | — | — |
| 3 Structure | Unique IDs; refs; edges and frames → nodes; grid cells; table shape; timeline order; code shape; heading rules; fallback and a11y present; counts and limits; producer may not emit `fallback` | `id_duplicate`, `ref_unknown`, `diagram_edge_node_unknown`, `diagram_frame_ref_unknown`, `diagram_target_invalid`, `table_shape`, `timeline_order`, `fallback_missing`, `a11y_label_missing`, `fallback_reserved`, `too_many_interactive`, `text_too_long` … | yes |
| 4 State and computation | Parameter ranges and defaults on the grid; control ↔ parameter type; every parameter has a control; template keys exist; formula scope (no forward refs, so no cycles); expression parse and limits; finiteness on the sampled grid; plot within its y domain; lookups complete | `param_range_invalid`, `param_default_invalid`, `control_param_unknown`, `control_param_type`, `param_without_control`, `template_key_unknown`, `formula_ref_unknown`, `expr_*`, `output_not_finite`, `plot_out_of_domain`, `view_*` | yes |
| 5 Evidence | Bindings resolve (claim offered, block exists, anchor exact and unique); numbers in prose bound; constants bound and no hidden literals; numeric charts and tables bound; copy check against quotes and excerpts; media offered | `binding_*`, `numeric_unbound`, `constant_unbound`, `literal_not_declared`, `numeric_block_unbound`, `copied_passage`, `media_not_offered` | yes (by removing or rebinding, never by inventing claims) |
| 6 Brief fit | Reading estimate within `targetMinutes`; `form` consistent with framing (what-if/perspective) | `reading_length_out_of_brief`, `framing_form_mismatch` | yes |
| 7 Publish and render | `publish()` (identity, framing copy, reading time, anchor map, integrity, ≤ 128 KiB); every block passes its registry `data` parse; `textAlternative()` succeeds; `adaptForClient()` against the oldest supported build. New block *versions* also get a headless RN-web render test in CI, not per document. | `doc_too_large`, `render_*` | no (an internal bug, so escalate) |
| 8 Content review | **A separate role and attempt, not the writer:**<br>• an LLM support check: does each anchored sentence say what its claim says, are the numbers consistent, are the limits present, is the what-if conditional;<br>• human sampling by risk class. | `support_weak`, `overclaim`, `framing_leak` … | no (the run ends `held` or `refused`; the Quartermaster decides) |

What validation cannot do (blueprint §11, §21): a schema pass proves the renderer can interpret the document. It does not prove the argument true or engaging. Stage 8 and human sampling exist for that.

### D4. At most one repair

- **When.** If stages 0–6 fail, the harness may send **one** repair attempt.
  - The request contains the identical frozen bundle (same hash), the failed draft and ≤ 32 `{code, path, hint}` items. Hints come from a fixed catalogue, so the validator never produces free text.
  - The model returns a **complete** new draft, not a patch, so that ID and binding consistency is re-validated as a whole.
- **Accounting.** The repair is its own admitted `ExternalAttempt` with a budget reservation (`purpose: 'repair'`, `parentAttemptId`).
- **Exclusions.** No repair is sent for:
  - transport failure or an unknown outcome: reconcile, never resend;
  - budget refusal;
  - stage 7 or 8.
- **Outcome.** If the repaired draft fails anything, the run ends `refused` with both attempts' codes. A decided bundle hash is never sent again (ADR-0041's identity rule). The Quartermaster may fund a *different* brief or evidence package.
- **Expected effect.** Today half the paid requests are refused, mostly for one quote mismatch (A3). In v1 the model no longer copies quotes at all: the evidence stage owns them. Most remaining failures (anchors, IDs, ranges) are mechanical and suit a single repair.

### D5. Where internal sourcing and checks live (never in the consumer document)

| Store (backend `content` module unless noted) | Holds | Served to clients? |
|---|---|---|
| `scroll_revision` | `document` (JSONB `ScrollDocumentV1`), `document_sha256`, `schema_version`, `block_types[]`, `essential_block_types[]`, `estimated_minutes`, `status (published\|corrected\|withdrawn)`, `previous_revision`; immutable rows | **Yes.** `packages/contracts/content.ts` re-exports `ScrollDocumentV1` from `scroll-model`. |
| `scroll_provenance` (1:1 with revision) | Bindings with resolved ranges, constant keys and whole-block links; evidence package ID; checks (name, version, verdict, codes); review decision; media rights; production run ID | No. A dependency rule forbids importing provenance schemas into `contracts` or HTTP controllers, and a journey test asserts no response contains `claimId`, `binding` or `evidencePackage`. |
| `evidence_claim`, `source_snapshot`, `source_material` | Claims with verbatim quotes on hashed snapshots, and the private material (as today, ADR-0031/0041) | No |
| Harness `external_attempt` (+ protected payload store) | Request hash, protected request reference, reply hash, usage, outcome, reason codes | No. **Proposal:** keep refused draft text in the protected store for **14 days** (access-logged) so failures can be diagnosed. ADR-0041 kept nothing, which made #181 impossible to diagnose. Owner decision. |
| Correction workflow | New revision; consumer `corrections[]` gets `{on, summary}`; provenance records which claims changed; the anchor map is derived | Only the summary and the new document |
| Reader block state | Device only (account and epoch scoped); a snippet's validated snapshot is owned by the social module and erased with the message | Only to authorised thread members, as the server-rendered summary plus values |

The consumer document is free of personal data. Personal values exist only in local state and explicitly shared snippets. Export, Clear, Reset and deletion therefore touch the snippet and local stores, not the shared library.

---
## E. Worked examples (published consumer documents)

Each example below is the **output of `publish()`** over a writer-style draft. The drafts, briefs and documents are in `agents/scroll-model/sketch/examples/`. Each passed every check in `check.ts`.

The evidence quotes in the briefs marked `ILLUSTRATIVE PLACEHOLDER` are stand-ins, not checked sources. The tides quotes about the bulges and the Sun's share are the real NASA passages from today's library pack `1aca9029bc97…`.

| Example | Size | Blocks | Reading estimate | Interactive blocks | Gesture owners |
|---|---|---|---|---|---|
| 1 Attention, slowly | 9.2 KB | 14 | 2 min | drag-to-target diagram, grid simulation, length simulation, disclosure | `it-diagram` = pan2d, both simulations = horizontal, code = horizontal |
| 2 Weight on other worlds | 4.4 KB | 5 | 1 min | factor-card simulation with a **personal** input, predict-then-reveal, inspectable chart | `mars-guess` = horizontal, the others = tap |
| 3 Why some tides are bigger | 6.1 KB | 6 | 1 min | step-through diagram, function-plot simulation using `expr@1` | `range-sim` = horizontal, diagram = tap |

The reading estimates are short because the examples are deliberately short. A full E02-style Scroll would have about 3× the prose.

### E1. "Attention, slowly" (E02/E03 content), abridged to its three richest blocks

The full document is `01-attention.document.json`, 14 blocks in 4 sections. The blocks shown here:

- `crowd-p1` uses inline `em`.
- `it-diagram` uses `drag_to_target`.
- `length-sim` uses a `power` formula with a slider, a stepper twin and band sentences.

The blocks omitted here:

- `grid-sim`: the n×n `grid_matrix`, n from 2 to 11, highlighting the row "it".
- `squared-more`: a disclosure holding a paragraph, a Python `code` block and a paragraph with an inline `code` mark and a `ref` to `grid-sim`.
- `it-table`: a table.
- `limits-callout`: a `limit` callout.

```json
{
  "schemaVersion": "scroll-document.v1",
  "assetId": "scr_attention_slowly",
  "revision": 1,
  "language": "en",
  "explanationUnitId": "eu_attention_mechanism",
  "topicIds": ["top_ml.attention"],
  "header": {
    "title": "Attention, slowly",
    "dek": "The same idea as the Reel, with room to try it yourself.",
    "form": "explainer",
    "estimatedReadingMinutes": 2
  },
  "framing": {"kind":"standard"},
  "presentation": {"theme":"poster","dropCap":false},
  "sections": [
    {
      "id": "crowd",
      "heading": null,
      "blocks": [
        {
          "id": "crowd-p1",
          "type": "paragraph",
          "v": 1,
          "data": {
            "text": [
              {"t":"Read this: "},
              {"t":"the animal didn’t cross the street because it was too tired.","m":["em"]},
              {"t":" You knew instantly that “it” meant the animal, not the street."}
            ]
          }
        },
        {
          "id": "it-diagram",
          "a11y": {
            "label": "Where “it” looks",
            "description": "The word “it” is linked to animal, street, tired and cross. Line thickness shows how much attention “it” pays to each word."
          },
          "fallback": [
            {
              "t": "Text version: in “because it was too tired”, the word “it” pays most attention to animal and some to tired. Change the ending to “too wide” and most attention moves to street."
            }
          ],
          "essential": true,
          "type": "diagram",
          "v": 1,
          "data": {
            "title": "Where “it” looks",
            "instruction": "Drag “it” onto the word you think it means",
            "layout": "radial",
            "nodes": [
              {"id":"it","label":"it","kind":"token"},
              {"id":"animal","label":"animal","kind":"entity"},
              {"id":"street","label":"street","kind":"entity"},
              {"id":"tired","label":"tired","kind":"entity"},
              {"id":"wide","label":"wide","kind":"entity"},
              {"id":"cross","label":"cross","kind":"entity"}
            ],
            "edges": [
              {"id":"e-animal","from":"it","to":"animal","directed":true,"style":"solid","weight":0.8},
              {"id":"e-street","from":"it","to":"street","directed":true,"style":"solid","weight":0.1},
              {"id":"e-tired","from":"it","to":"tired","directed":true,"style":"solid","weight":0.45},
              {"id":"e-wide","from":"it","to":"wide","directed":true,"style":"solid","weight":0.45},
              {"id":"e-cross","from":"it","to":"cross","directed":true,"style":"solid","weight":0.05}
            ],
            "groups": [],
            "frames": [
              {
                "id": "means-animal",
                "label": "…because it was too tired",
                "description": "With “too tired”, “it” pays most attention to animal, some to tired, and very little to street or cross.",
                "emphasis": {"nodes":["animal","tired"],"edges":["e-animal"]},
                "edgeWeights": {"e-animal":0.8,"e-tired":0.45,"e-street":0.1,"e-cross":0.05},
                "hidden": ["wide","e-wide"]
              },
              {
                "id": "means-street",
                "label": "…because it was too wide",
                "description": "Change one word to “too wide” and “it” now points mostly at street: the ending decides what “it” means.",
                "emphasis": {"nodes":["street","wide"],"edges":["e-street"]},
                "edgeWeights": {"e-street":0.8,"e-wide":0.45,"e-animal":0.1,"e-cross":0.05},
                "hidden": ["tired","e-tired"]
              }
            ],
            "interaction": {
              "kind": "drag_to_target",
              "token": "it",
              "targets": [{"node":"animal","frame":"means-animal"},{"node":"street","frame":"means-street"}],
              "initialFrame": "means-animal"
            }
          }
        }
      ]
    },
    {
      "id": "why-squared",
      "heading": "Why squared?",
      "blocks": [
        {
          "id": "length-sim",
          "a11y": {
            "label": "Sentence length and the work of attention",
            "description": "Choose a sentence length between 512 and 4,096 words to see how much more work attention needs than at 512 words."
          },
          "fallback": [
            {
              "t": "Text version: the work grows with the square of the length. Twice as long is about four times the work; eight times as long is about sixty-four times the work."
            }
          ],
          "essential": true,
          "type": "simulation",
          "v": 1,
          "data": {
            "title": "Try a longer sentence",
            "prompt": "Sentence length",
            "params": [
              {
                "key": "len",
                "type": "number",
                "label": "Sentence length",
                "unit": "words",
                "min": 512,
                "max": 4096,
                "step": 512,
                "default": 512,
                "scale": "linear",
                "format": {"decimals":0,"grouping":true,"approx":false},
                "sensitivity": "none"
              }
            ],
            "constants": [],
            "derive": [
              {
                "key": "work",
                "label": "Work compared with 512 words",
                "formula": {"kind":"power","x":"len","base":512,"exponent":2,"scale":1},
                "format": {"decimals":0,"grouping":true,"approx":true,"suffix":"×"}
              },
              {
                "key": "longer",
                "label": "Times longer",
                "formula": {"kind":"ratio","num":"len","den":512},
                "format": {"decimals":0,"grouping":false,"approx":false,"suffix":"×"}
              }
            ],
            "view": {"kind":"readout","primary":"work","secondary":"longer"},
            "controls": [
              {"kind":"slider","param":"len","valueText":"{len} words, {work} the work of 512"},
              {"kind":"stepper","param":"len","stepMultiplier":1,"valueText":"{len} words"}
            ],
            "readout": {
              "template": "{work} the work of 512 words",
              "bands": [
                {"output":"work","max":1.5,"text":"Same length, same work."},
                {"output":"work","min":1.5,"max":20,"text":"The work grows much faster than the length."},
                {
                  "output": "work",
                  "min": 20,
                  "text": "Eight times longer is about sixty-four times the work: long prompts cost far more to process."
                }
              ]
            },
            "modelNote": "Counts only the comparisons, relative to a 512-word sentence. Other costs grow more slowly.",
            "illustrative": true
          }
        }
      ]
    }
  ],
  "corrections": [],
  "revisionInfo": {"previousRevision":null,"anchorMap":[]},
  "integrity": {
    "canonicalSha256": "d372ad49568fb7f5823639f7aa6e1e76db3e5396fa0c79a1cab79995bd837f49",
    "limitsVersion": "scroll-limits.v1",
    "coverageWeightsVersion": "coverage-weights.v1"
  }
}
```

**What the renderer must display:**

- **The diagram.** "It" sits at the centre with five labelled words. "Wide" is hidden in the initial frame. Dragging "it" onto *street* switches to frame `means-street`: edge weights move, *tired* hides and *wide* appears, and the frame description is announced. Dropping anywhere else snaps back. Reset returns to `means-animal`. "Describe this diagram" reads the current frame's description. In text-version mode the diagram becomes a two-row table of frames × weights.
- **The length simulation.** It shows "~64× the work of 512 words" at 4,096. The band sentence changes at 1.5× and 20×. The stepper moves by 512. The state `{len}` persists per revision and block, and it shares as "Sentence length · 4,096 words".

### E2. "How heavy would you be on other worlds?" (E09-4)

```json
{
  "schemaVersion": "scroll-document.v1",
  "assetId": "scr_weight_other_worlds",
  "revision": 1,
  "language": "en",
  "explanationUnitId": "eu_surface_gravity",
  "topicIds": ["top_astro.gravity"],
  "header": {
    "title": "How heavy would you be on other worlds?",
    "dek": "Put in your weight and see what a bathroom scale would read.",
    "form": "comparison",
    "estimatedReadingMinutes": 1
  },
  "framing": {"kind":"standard"},
  "presentation": {"theme":"poster","dropCap":false},
  "sections": [
    {
      "id": "scales",
      "heading": null,
      "blocks": [
        {
          "id": "weight-sim",
          "a11y": {
            "label": "Your weight on four worlds",
            "description": "Enter your weight on Earth; four cards show what a scale would read on the Moon, Mars, Earth and Jupiter."
          },
          "fallback": [
            {
              "t": "Text version: a scale reads your Earth weight times the world’s gravity. Someone who weighs 60 kg on Earth would read about 10 kg on the Moon, 23 kg on Mars and 152 kg at Jupiter’s cloud tops."
            }
          ],
          "essential": true,
          "type": "simulation",
          "v": 1,
          "data": {
            "title": "Your weight on other worlds",
            "params": [
              {
                "key": "weightKg",
                "type": "number",
                "label": "Your weight on Earth",
                "unit": "kg",
                "min": 20,
                "max": 200,
                "step": 1,
                "default": 60,
                "scale": "linear",
                "format": {"decimals":0,"grouping":false,"approx":false},
                "sensitivity": "personal"
              }
            ],
            "constants": [
              {"key":"gMoon","label":"Moon gravity","value":0.165},
              {"key":"gMars","label":"Mars gravity","value":0.38},
              {"key":"gJupiter","label":"Jupiter gravity","value":2.53}
            ],
            "derive": [],
            "view": {
              "kind": "factor_cards",
              "input": "weightKg",
              "outputUnit": "kg",
              "items": [
                {"id":"moon","label":"Moon","factor":"gMoon","glyph":"planet"},
                {"id":"mars","label":"Mars","factor":"gMars","glyph":"planet"},
                {"id":"earth","label":"Earth","factor":1,"glyph":"planet"},
                {
                  "id": "jupiter",
                  "label": "Jupiter",
                  "factor": "gJupiter",
                  "glyph": "planet",
                  "note": "Jupiter has no ground to stand on; this is at its cloud tops."
                }
              ],
              "barMax": 510,
              "format": {"decimals":0,"grouping":false,"approx":false}
            },
            "controls": [
              {"kind":"number_input","param":"weightKg"},
              {"kind":"stepper","param":"weightKg","stepMultiplier":1,"valueText":"{weightKg} kg"}
            ],
            "modelNote": "Scale reading = your Earth weight × the world’s surface gravity compared with Earth. Rounded to the nearest kilogram.",
            "illustrative": false
          }
        },
        {
          "id": "scales-p1",
          "type": "paragraph",
          "v": 1,
          "data": {
            "text": [
              {"t":"What changes is "},
              {"t":"surface gravity","m":["strong"]},
              {
                "t": " — how hard each world pulls on you. You’re made of the same stuff everywhere; the scale just feels a different pull."
              }
            ]
          }
        }
      ]
    },
    {
      "id": "guess",
      "heading": "Before you look",
      "blocks": [
        {
          "id": "mars-guess",
          "a11y": {"label":"Guess the Mars reading"},
          "fallback": [
            {
              "t": "On Mars a 60 kg person’s scale reads about 23 kg, because Mars pulls with about 38% of Earth’s gravity."
            }
          ],
          "type": "predict_reveal",
          "v": 1,
          "data": {
            "prompt": "A 60 kg person steps on a scale on Mars. What does it read?",
            "guess": {
              "key": "marsGuess",
              "type": "number",
              "label": "Your guess",
              "unit": "kg",
              "min": 0,
              "max": 120,
              "step": 5,
              "default": 60,
              "scale": "linear",
              "format": {"decimals":0,"grouping":false,"approx":false},
              "sensitivity": "none"
            },
            "control": "slider",
            "answer": {"value":23,"display":"about 23 kg"},
            "reveal": [
              {
                "t": "Mars pulls with about 38% of Earth’s gravity, so the scale reads about 23 kg. You would feel light, but you would not have lost any of yourself."
              }
            ]
          }
        },
        {
          "id": "mass-callout",
          "type": "callout",
          "v": 1,
          "data": {
            "kind": "key_idea",
            "title": "Weight is not mass",
            "text": [
              {
                "t": "Your mass, how much stuff you’re made of, is the same on every world. A scale measures the pull on that mass, so only the reading changes."
              }
            ]
          }
        },
        {
          "id": "gravity-chart",
          "a11y": {"label":"Surface gravity compared with Earth"},
          "fallback": [
            {
              "t": "Surface gravity compared with Earth: Moon about 0.17, Mars about 0.38, Earth 1, Jupiter about 2.53 at its cloud tops."
            }
          ],
          "type": "chart",
          "v": 1,
          "data": {
            "title": "How hard each world pulls",
            "spec": {
              "kind": "bar",
              "orientation": "horizontal",
              "categories": ["Moon","Mars","Earth","Jupiter"],
              "series": [{"id":"gravity","label":"Gravity (Earth = 1)","values":[0.165,0.38,1,2.53]}],
              "y": {"label":"Surface gravity","unit":"× Earth","scale":"linear","domain":[0,3]}
            },
            "annotations": [{"kind":"y_line","at":1,"label":"Earth"}],
            "interaction": "inspect"
          }
        }
      ]
    }
  ],
  "corrections": [],
  "revisionInfo": {"previousRevision":null,"anchorMap":[]},
  "integrity": {
    "canonicalSha256": "f510a36ae2152b5a13221b035317fc8e12efa250cdd8d3a73a966db8fc6322e8",
    "limitsVersion": "scroll-limits.v1",
    "coverageWeightsVersion": "coverage-weights.v1"
  }
}
```

**What the renderer must display:**

- **The weight simulation.** A number field with − and + buttons controls `weightKg`, which is **personal**. Four cards each show the factor and `round(weightKg × factor)` kg, with a bar scaled to `barMax`. Jupiter's card carries its note. `modelNote` appears under the cards.
- **The weight never leaves the device in telemetry.** A snippet may include it only when the sender ticks "Include how I set it". The server then refuses unconfirmed personal values (`personal_state_not_confirmed`, tested).
- **The guess.** `mars-guess` shows a slider guess, then *Reveal* shows "about 23 kg" and the explanation. There is no right/wrong wording, and the guess is not stored server-side.
- **The chart.** Inspect is tap-only, and a data table is the text alternative.
- **On an older client without `predict_reveal@1`,** the guess arrives as a `fallback@1` block carrying its text.

### E3. "Why some tides are bigger" (step-through + `expr@1`)

```json
{
  "schemaVersion": "scroll-document.v1",
  "assetId": "scr_spring_neap_tides",
  "revision": 1,
  "language": "en",
  "explanationUnitId": "eu_spring_neap",
  "topicIds": ["top_earth.tides"],
  "header": {
    "title": "Why some tides are bigger",
    "dek": "The Moon does most of the lifting. Twice a month the Sun helps, and twice a month it gets in the way.",
    "form": "walkthrough",
    "estimatedReadingMinutes": 1
  },
  "framing": {"kind":"standard"},
  "presentation": {"theme":"night","dropCap":false},
  "sections": [
    {
      "id": "two-pulls",
      "heading": null,
      "blocks": [
        {
          "id": "pulls-p1",
          "type": "paragraph",
          "v": 1,
          "data": {
            "text": [
              {
                "t": "The Moon raises two bulges of ocean, one on the side facing it and one on the far side. As Earth turns through them, a coast gets two high tides a day."
              }
            ]
          }
        },
        {
          "id": "pulls-p2",
          "type": "paragraph",
          "v": 1,
          "data": {
            "text": [
              {"t":"The Sun raises bulges too, but smaller ones: its tidal pull is "},
              {"t":"a little less than half","m":["em"]},
              {"t":" the Moon’s. What matters is where those two sets of bulges point."}
            ]
          }
        },
        {
          "id": "align-diagram",
          "a11y": {
            "label": "Sun, Earth and Moon in three arrangements",
            "description": "Three steps: the Moon alone, the Sun and Moon in a line, and the Moon at a right angle to the Sun."
          },
          "fallback": [
            {
              "t": "Text version: with the Moon alone, Earth has two bulges. When the Sun and Moon line up, their bulges add and tides are biggest: spring tides. When they are at a right angle, the Sun’s bulges fill the Moon’s low tides and tides are smallest: neap tides."
            }
          ],
          "essential": true,
          "type": "diagram",
          "v": 1,
          "data": {
            "title": "Line up, or cross",
            "layout": "grid",
            "nodes": [
              {"id":"sun","label":"Sun","kind":"entity","cell":{"col":0,"row":2}},
              {"id":"earth","label":"Earth","kind":"entity","cell":{"col":3,"row":2}},
              {"id":"moon-line","label":"Moon","kind":"entity","cell":{"col":5,"row":2}},
              {"id":"moon-cross","label":"Moon","kind":"entity","cell":{"col":3,"row":0}}
            ],
            "edges": [
              {
                "id": "pull-sun",
                "from": "sun",
                "to": "earth",
                "label": "smaller pull",
                "directed": true,
                "style": "dashed",
                "weight": 0.45
              },
              {
                "id": "pull-moon-line",
                "from": "moon-line",
                "to": "earth",
                "label": "bigger pull",
                "directed": true,
                "style": "solid",
                "weight": 1
              },
              {
                "id": "pull-moon-cross",
                "from": "moon-cross",
                "to": "earth",
                "label": "bigger pull",
                "directed": true,
                "style": "solid",
                "weight": 1
              }
            ],
            "groups": [],
            "frames": [
              {
                "id": "moon-only",
                "label": "The Moon alone",
                "description": "Only the Moon pulls: two bulges, one facing the Moon and one on the far side.",
                "emphasis": {"nodes":["moon-line"],"edges":["pull-moon-line"]},
                "hidden": ["sun","pull-sun","moon-cross","pull-moon-cross"]
              },
              {
                "id": "spring",
                "label": "In a line: spring tides",
                "description": "Sun, Earth and Moon in a line. The two sets of bulges add up: higher highs and lower lows.",
                "emphasis": {"nodes":["sun","moon-line"],"edges":["pull-sun","pull-moon-line"]},
                "hidden": ["moon-cross","pull-moon-cross"]
              },
              {
                "id": "neap",
                "label": "At a right angle: neap tides",
                "description": "The Moon is at a right angle to the Sun. The Sun’s bulges fill the Moon’s lows, so the tide range shrinks.",
                "emphasis": {"nodes":["sun","moon-cross"],"edges":["pull-sun","pull-moon-cross"]},
                "hidden": ["moon-line","pull-moon-line"]
              }
            ],
            "interaction": {"kind":"step"}
          }
        }
      ]
    },
    {
      "id": "how-much",
      "heading": "How much bigger?",
      "blocks": [
        {
          "id": "much-p1",
          "type": "paragraph",
          "v": 1,
          "data": {
            "text": [
              {
                "t": "Turn the angle between the Sun and the Moon, as seen from Earth, and watch the tide range change. In a line, the two pulls add; at a right angle, the Sun takes some away."
              }
            ]
          }
        },
        {
          "id": "range-sim",
          "a11y": {
            "label": "Tide range and the Sun–Moon angle",
            "description": "A curve of tide range against the angle between the Sun and the Moon, from 0 to 90 degrees, with a marker at the chosen angle."
          },
          "fallback": [
            {
              "t": "Text version: with the Sun and Moon in a line, the idealised tide range is about 1.46 times the Moon’s alone. At a right angle it falls to about 0.54 times, so spring tides are roughly two and a half to three times the range of neap tides in this idealised picture."
            }
          ],
          "essential": true,
          "type": "simulation",
          "v": 1,
          "data": {
            "title": "Turn the Sun",
            "params": [
              {
                "key": "angle",
                "type": "number",
                "label": "Angle between Sun and Moon",
                "unit": "°",
                "min": 0,
                "max": 90,
                "step": 5,
                "default": 0,
                "scale": "linear",
                "format": {"decimals":0,"grouping":false,"approx":false},
                "sensitivity": "none"
              }
            ],
            "constants": [{"key":"r","label":"Sun’s tidal pull compared with the Moon’s","value":0.46}],
            "derive": [
              {
                "key": "curve",
                "label": "Tide range",
                "formula": {"kind":"expr","v":1,"expression":"sqrt(1 + r^2 + 2*r*cos(2*rad(x)))"},
                "format": {"decimals":2,"grouping":false,"approx":false,"suffix":"×"}
              },
              {
                "key": "rangeNow",
                "label": "Tide range now",
                "formula": {"kind":"expr","v":1,"expression":"sqrt(1 + r^2 + 2*r*cos(2*rad(angle)))"},
                "format": {"decimals":2,"grouping":false,"approx":true,"suffix":"×"}
              }
            ],
            "view": {
              "kind": "function_plot",
              "curve": "curve",
              "x": {"from":0,"to":90,"label":"Angle between Sun and Moon","unit":"°"},
              "y": {"label":"Tide range (Moon alone = 1)","domain":[0,1.6]},
              "marker": "angle",
              "samples": 46
            },
            "controls": [
              {"kind":"slider","param":"angle","valueText":"{angle} degrees: {rangeNow} the Moon’s tide alone"},
              {"kind":"stepper","param":"angle","stepMultiplier":3,"valueText":"{angle} degrees"}
            ],
            "readout": {
              "template": "{rangeNow} the Moon’s tide alone",
              "bands": [
                {"output":"rangeNow","min":1.3,"text":"Close to a line: spring tides."},
                {"output":"rangeNow","max":0.7,"text":"Close to a right angle: neap tides."}
              ]
            },
            "modelNote": "Idealised equilibrium tide, relative to the Moon’s tide alone. It ignores coastlines, ocean depth and timing lags; real tide tables differ by place.",
            "illustrative": false
          }
        }
      ]
    },
    {
      "id": "real-coasts",
      "heading": "Real coasts",
      "blocks": [
        {
          "id": "coasts-callout",
          "type": "callout",
          "v": 1,
          "data": {
            "kind": "limit",
            "text": [
              {
                "t": "Coastline shape, ocean depth, wind and storms bend the real pattern away from this picture, so a local tide table matters more than the Moon alone."
              }
            ]
          }
        }
      ]
    }
  ],
  "corrections": [],
  "revisionInfo": {"previousRevision":null,"anchorMap":[]},
  "integrity": {
    "canonicalSha256": "61aab930c3171ed9349321c7075861e8641416aa6ac353cadbfe340b844a8ac0",
    "limitsVersion": "scroll-limits.v1",
    "coverageWeightsVersion": "coverage-weights.v1"
  }
}
```

**What the renderer must display:**

- **The step-through diagram.** Three frames ("The Moon alone", "In a line: spring tides", "At a right angle: neap tides") on a 6×6 grid layout, with Previous and Next. Hidden nodes and edges disappear without tweening when reduced motion is on.
- **The simulation.** A curve of `sqrt(1 + r² + 2r·cos(2θ))` for θ from 0 to 90°, evaluated by the closed grammar. The constant `r = 0.46` is bound to the claim "a little less than half". There is a marker at `angle`. The readout reads "~1.46× the Moon's tide alone" at 0° and "~0.54×" at 90°. Bands label spring and neap.
- **On a client without `function_plot@1` or `expr@1`.** The whole simulation is replaced by its fallback text. Because it is `essential`, the substitution is reported and the Composer may prefer the Reel for that client (tested).

### E4. Snippet locators and provenance for E3

A passage snippet ("Share passage" on native text selection), with the result of server validation and the card label it produces:

```json
{
  "kind": "scroll_passage",
  "assetId": "scr_spring_neap_tides",
  "revision": 1,
  "blockId": "pulls-p2",
  "range": [45,97],
  "quote": {
    "text": "its tidal pull is a little less than half the Moon’s",
    "sha256": "427131831a0f7776684ccee0c0b6fd46fd12080d2f3e0d875b18b186967a174e",
    "prefix": "s bulges too, but smaller ones: ",
    "suffix": ". What matters is where those tw"
  }
}
```
→ `{"ok":true,"summary":"Why some tides are bigger"}`

A block snippet with its state included ("Share this diagram · Include how I set it"):

```json
{
  "kind": "scroll_block",
  "assetId": "scr_spring_neap_tides",
  "revision": 1,
  "blockId": "range-sim",
  "blockType": "simulation@1",
  "state": {"fingerprint":"964d67eccb567372","values":{"angle":90},"includesPersonal":false}
}
```
→ `{"ok":true,"summary":"Angle between Sun and Moon · 90°"}`

The internal provenance excerpt for the same revision. This is stored in `scroll_provenance` and never served. A correction to `clm_tide_sun_ratio` therefore finds the passage `pulls-p2[45,97)` and the simulation constant `r`:

```json
{
  "schemaVersion": "scroll-provenance.v1 (excerpt)",
  "assetId": "scr_spring_neap_tides",
  "revision": 1,
  "documentSha256": "61aab930c3171ed9349321c7075861e8641416aa6ac353cadbfe340b844a8ac0",
  "bindings": [
    {"claimId":"clm_tide_bulges","blockId":"pulls-p1","range":[0,87]},
    {"claimId":"clm_tide_sun_ratio","blockId":"pulls-p2","range":[45,97]},
    {"claimId":"clm_tide_spring_neap","blockId":"align-diagram","wholeBlock":true},
    {"claimId":"clm_tide_sun_ratio","blockId":"range-sim","constantKey":"r"},
    {"claimId":"clm_tide_spring_neap","blockId":"range-sim","wholeBlock":true},
    {"claimId":"clm_tide_local","blockId":"coasts-callout","range":[0,90]}
  ]
}
```

**A what-if variant of the same Scroll.** In `check.ts`, a brief carrying `framing: {kind:'what_if', truthStatus:'hypothetical', changed:['The Moon were twice as far away'], kept:['Same Sun','Same oceans']}` was run twice:

- with `form: 'explainer'`, it is refused `framing_form_mismatch`;
- with `form: 'what_if'`, it passes, and the publisher copies the framing verbatim into the document.

The renderer must then show the persistent "Hypothetical · Changed: The Moon were twice as far away · Kept: Same Sun, Same oceans" banner on this item and on every continuation of the branch.

**A revision 2 of example 1** changes one paragraph, removes `grid-sim` and edits the paragraph that referenced it. It publishes with:

```json
"anchorMap": [{"from":"grid-sim","to":null,"text":"changed"},
              {"from":"squared-more-p2","to":"squared-more-p2","text":"remap_by_quote"},
              {"from":"weights-p1","to":"weights-p1","text":"remap_by_quote"}]
```

Old passage snippets on `weights-p1` re-anchor if their quote still occurs; otherwise they say the passage changed. State saved for `grid-sim` is dropped with a notice.

---

## Open questions for the owner and architect

1. **Repair transcripts.** Keep refused draft text for 14 days in the protected payload store (D5), or keep today's no-text rule?
2. **Output budget.** Raise `max_output_tokens` to about 12k, or split into an outline attempt and a draft attempt (D1)? Either way, one bounded call per attempt.
3. **`expr@1` on day one,** or start with closed formula kinds only and add the grammar after fuzz tests? E3 needs it; E1 and E2 do not.
4. **`predict_reveal`.** It is a guess with no score. Is it acceptable under "no routine quizzes", or should it stay `callout{try_it}` only?
5. **Partial document delivery** (E02-4 "rest will load when online"). Is one bounded JSON fetch acceptable (proposed), or are streamed sections required?
6. **Labelling model-written Scrolls.** Should they be labelled `synthesis` in v2? The truth-state vocabulary exists. Today's `documented` overstates what is checked (ADR-0041 §9).
7. **Material allowlist.** The public-domain allowlist confines topics to NASA, NOAA and USGS (A4). Should the v2 research stage add licensed or other open sources so ML, history and football (E09) can be written at all?
