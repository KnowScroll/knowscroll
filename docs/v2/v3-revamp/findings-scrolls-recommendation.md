# V3 Scrolls vs. `origin/dev`: recommendation algorithm and Scroll pipeline

> **Read with CHANGE-MAP.md.** A Sonnet 5.5 subagent of the owner's coordinating session wrote this file on 29 Oct 2026 by reading the code of `dev` at `5d1271d5`; nothing was run. Verify a claim before you build on it.
> **Owner ruling after this was written:** every design is final, including the PDFs' picks and "LEANING" answers, and the newer design wins where two overlap. Where this file says "not locked", "owner question" or recommends against a leaning, **CHANGE-MAP.md §4 governs**.

Analysis only. Read-only worktree: `a read-only worktree of origin/dev at 5d1271d5` (paths below are relative to it).
Inputs: AGENTS.md, docs/STATUS.md (2026-10-25), docs/v2/handover.md, docs/v2/operations/scroll-production.md, blueprint 02d (§§8-12, 18), decisions D-032..D-059, module READMEs, and the V3 PDF (`scrolls-v3-pdf.txt`, text of the 11 pages).
Legend: **S** under ~1 day / one PR, **M** 1-3 PRs, **L** a phase of its own.

---

## 1. Today on dev: the Scroll pipeline end to end

### 1.1 Document model (`packages/scroll-model`)
- Schema `scroll-document.v1` (`src/document.ts`). Header: `assetId, revision, language, explanationUnitId, series?{seriesId,part}, template(poster|editorial), theme.family, kicker, title, dek, framing(factual|hypothetical|perspective), sections[{id,heading,blocks[]}], corrections[], limitsVersion, measures, integrity`.
- **16 authored block types** (`src/blocks/catalog.ts`): paragraph, subheading, list, quote, callout(note|example|limit|key-idea|try-it), disclosure, code, table, figure, media, comparison, timeline, sequence (stepper), diagram (frames, steps/toggle/drag-to-target), chart, simulation (closed formula set: linear, product, ratio, power, exponential, inverse-square, lookup; no sin/cos), plus server-only `fallback`. Every non-text block has an envelope: `id, type, version(=1), a11y, fallbackText, essential, gesture(none|horizontal|two-axis), data`.
- **Limits** `scroll-limits.v1` (`src/limits.ts`): 128 KiB doc, 12 sections, 80 blocks, **8 interactive blocks** (`isInteractiveBlock` = simulation, sequence, media, non-static diagram; `src/registry.ts`), 24,000 visible chars, 12 media, 16 sim params. Fields: paragraph 1,200 chars, callout 600, etc.
- Code (not the model) sets ids, versions, gestures, a11y labels, illustrative notice, framing, template, theme, series, reading time, coverage weights, integrity hash.
- Reader state is on device only (`src/state.ts` `BlockState`: simulation params, diagram frame, sequence step, disclosure). Observation payloads carry block ids + interaction **kinds**, never values (`INTERACTION_KINDS` in `src/registry.ts`; `packages/contracts/src/interactions.ts`).
- Version negotiation: client advertises `ClientCapabilities{documentSchemas, blocks}`; server `negotiate()` swaps unsupported blocks for `fallback` (`src/negotiation.ts`). Only one schema version (`scroll-document.v1`) exists; `v1` is hard-coded in `content/adapters/render-scroll.ts` (parseDocument), `snippet-anchors.ts`, `keep-position-target.ts`, `region-candidates.ts`, `planner/adapters/nest-providers.ts`, `composer/application/vertical-candidates.ts` (`renderableFormats` checks `${format}-document.v1`).

### 1.2 Writer, harness, validation, admission
- Recipe = library plan entry (`packages/backend/src/modules/content/domain/library/{earth,space,machine-learning,human-body,computing,history}.ts`, shapes in `plan.ts`): `explanationUnitId, assetId, systemId, topicId (planet), facetId (+supportingFacetId), brief (2-4 sentences), pages (1-3 allowlisted research URLs), interactive + interactiveKind`. **54 recipes**, 32 interactive: diagram 12, sequence 7, chart 5, simulation 4, comparison 2, timeline 2; 22 plain. Recipes have **no misconception field**.
- Writer = `packages/backend/src/modules/content/production/writer.ts`. Role `content.scroll-writer`, prompt `scroll-writer.v13` (`WRITER_PROMPT_VERSION`), recipe version `scroll-production.v14`. One call + at most one repair, MiniMax-M3.1-Flash, effort `medium`, 16,000 token ceiling, plain-text JSON (D-032). `writerInstructions(format, mode)` is a hand-written prompt; 450-600 words in 2-3 sections, ends with a `limit` callout, only heading/paragraph/list/callout + ONE rich block named by the recipe (`FORMAT_BLOCKS`, `FORMAT_GUIDANCE`). Scenario modes (`what_if`, `perspective`) append `SCENARIO_RULES` (`scenario-writer.v1`).
- The model writes **`scroll-authoring.v1`** (`packages/scroll-model/src/producer/authoring-schema.ts`): a flat list `{title, dek, blocks[]}` with `cites:[e1..]` per block; only 11 authored types (heading, paragraph, list, callout, comparison, timeline, sequence, diagram, bar-chart, line-chart, simulation). `authoring-convert.ts` -> canonical draft; `compile.ts` -> document + internal provenance.
- Validation in order: authoring schema -> `compileAuthored` (structure, simulation grid proof, **every figure must be in a cited passage**, **no 9-word run copied from a source**, 2-8 min reading length, no source names, requested block present, `admitDocument`) -> `moduleIssues` in writer.ts (`format_required`, `block_type_not_allowed`, banned publisher names). Findings reach the single repair as fixed path-located hints (`REPAIR_HINTS`, `WRITER_SAFE_ISSUES`).
- Admission = `admitDocument` (`packages/scroll-model/src/admission`), full-grid proof of simulations; stored immutable in `content.asset_revisions` with private provenance in `asset_provenance`.

### 1.3 Production jobs
- Job `content.produce-scroll` (`production/job.ts`, `produce.ts`), one per recipe + recipe version + take (max 3 takes). Stages `research -> writer -> published|rejected|unknown`. Research is fetched by code, frozen, cut into passages `e1..e64` (`production/evidence.ts`).
- Senders: Quartermaster **Create** (priority 10) and the operator (`content produce-library`, `produce-scroll`, `production-status`, `admit-continuity`, `readmit-coverage`). Doc: `docs/v2/operations/scroll-production.md`. Caps: `KS_SUPPLY_CREATE_DAILY_CAP` etc.
- Publication hook `completeWriterPublication` (`production/publication-topic.ts`): in the same transaction projects the planet (one primary topic, weight 1) and writes **coverage** `scroll-recipe-coverage.v1` (`domain/recipe-coverage.ts`): eligible blocks are **top-level paragraph/quote/callout** with documented claims (`COVERAGE_LOCATOR_TYPES` in `domain/coverage.ts`); primary facet needs first, middle, last eligible block, supporting facet the last two; fewer than 3 eligible blocks = no coverage.
- Made-to-order Scrolls (What-if / Another perspective) use the same pipeline, key `order-<32 hex>`, no coverage and no topic attribution (D-049).
- Series / Part / Related: declared in `domain/library/continuity.ts` (11 series of 2-4 parts, 25 related moves), admitted only by `content admit-continuity` (D-059). Seasons is `seasons -> seasons-hemispheres -> seasons-limits`.

### 1.4 Renderer (`packages/ui/src/scroll`)
- `article.tsx` (332 lines) renders sections/blocks in one vertical `ScrollView`; block registry `blocks/registry.tsx` (`IMPLEMENTED` table drives advertised capabilities); views per block under `blocks/` (diagram, chart, simulation have their own sub-folders); templates `templates/{headers,notices,end-mark,text-version-toggle}.tsx` (poster/editorial headers, framing notice, "Text version of diagrams" toggle at top); gestures `gestures/arbitration.ts` (blocks with `gesture != none` own horizontal/two-axis drags; vertical reading always passes through). Web and native share the code (`.web.ts` variants for viewport/activity).
- No stage, no pinned layer, no spine, no game state. Charts/diagrams are SVG inside blocks.

### 1.5 Reading activity -> evidence
- Reader reports through `ScrollReadingObserver` (`ui/src/scroll/observer.ts`): `onBlockVisibility`, `onBlockInteraction{blockId,blockType,kind}`, `onActivity`. Recorder is `createScrollRecorder` in `packages/client-core` (batches `scroll.block_coverage`, `scroll.active_dwell`, `scroll.block_interaction`, 50 events/48 KiB per batch).
- Server: `evidence` module. Intake `ingest-observations.ts` validates exposure, lineage, block ids exist in the immutable revision, **interaction kind must be declared by `INTERACTION_KINDS` for that block's type**. Projection `project-scroll-reading.ts` -> `domain/qualification.ts` policy `scroll-qualification.v0`: `q = 0.5 * weighted coverage + 0.5 * min(1, dwell / reading estimate)`; **qualified = at least one block seen, q >= 0.6, coverage >= 0.5**; "seen block" = >= 500 ms visible while active and peak visible fraction >= 0.5. Weights per top-level block come from `scroll-measures.v1` (`measures.ts`, word-equivalents; diagram 40+10/frame, simulation 60+15/param, etc.), frozen as `content.asset_revisions.reading_facts` v2.
- Interactions are counted once per block+kind and do **not** raise q today (only visibility and dwell do). `activity.v0` (`evidence/domain/activity.ts`): `a = min(3, q + .5L + 1.5B + 1.0S + 1.5H + 2R)`; H = deliberate horizontal continuation (series/related), R = separated return (>= 30 min).
- `personal-context` projects qualified contribution (`coveredFacets` from content coverage) -> Cartographer (`geography`, passive formation `geography-passive.v1`: system = 2 units, planet = 3 units over 2 facets) -> `scenes` (Universe).

### 1.6 Series, Part, Related navigation
- Server: Experience navigation intents `{mode: vertical|series|related|variant|return}` (`packages/contracts/src/navigation.ts`); client `encounter-session.ts` (`navigate`, `gesture(move)`), `continuation-intent.ts`. Context carries `continuations{seriesNext, seriesPrevious, related}` each `ready|pending|none` with an expected link id. **The context has a part number but no series total** (D-059: "Part 2", never "2 of 3").
- Reels: swipe sideways = continue (`encounter-reel.tsx`, `gestures/arbitration.ts`: horizontal >= 64 px next/previous, vertical >= 64 px = subject next/previous; native edge 24 px reserved for platform back), yellow Part tab, dashed Related tab (`explore/thread-aside.tsx`).
- **Scrolls have no swipe at all** (D-040: "A Scroll has no edge tab: its continuation is the end-of-article card and the more menu"; vertical reading never navigates). The only gesture is the platform Back.

### 1.7 End card
- `apps/client/features/encounter/scroll-end.tsx` (E02-3): "End of this Scroll", panel "Continue this idea" with a Part row (solid) and a Related row (dashed), "Next subject" button (`navigate({mode:'vertical',direction:'next'})`), action strip. Exhausted/ended threads show `encounter-ending.tsx` (E08 yellow card "Keep a way back / Something different / Done for now"). "Nothing more ready" (E07) says "You've seen what's ready for now" (no counts, no grades).

### 1.8 Ask / request (E04, E06, E07)
- Ask = action `ask` in `EncounterStrip` -> `session.openRequest()` -> `RequestPanel` (`apps/client/features/requests/request-panel.tsx`, `request-session.ts`). Modes `topic | reel | scroll` (the last two are format-variant requests, E06). The sheet shows "Ask for something", free text up to 500 chars + suggested catalogue topics + "As a" Reel/Scroll/Either + "This is" (about this / something new).
- Backend `supply` (Quartermaster; `packages/backend/src/modules/supply/README.md`): Reuse -> Join -> Create. Free text is matched by a model **to an exact catalogue topic+facet** only (`supply/application/match-role.ts`). **A context-bearing text ask ("about this encounter") is not matched and closes as `unsupported`.** Create picks a **library recipe** by code; it cannot write a brand-new question Scroll. Reel and variant asks are `budget_unavailable` (no production path). States: requested, preparing, ready, unavailable(coarse reason), cancelled; retry (3x) for `could_not_prepare`.
- Request context passed from the client is the **exposure** only (`context: source`), never a stop, block, or selected passage.

### 1.9 Next-subject
- Reel: swipe up = `vertical next`. Scroll: only via end-card button or the more menu (`encounter-session.gesture('subjectNext')` exists but is only reachable from Reels). Composer serves it from a worker-prepared buffer when valid.

---

## 2. Recommendation / personal algorithm today

Module map: `packages/backend/src/modules/{composer,personal-context,evidence,planner,supply,experience,content,geography,scenes}`. Blueprint §8-§12.

### 2.1 Composer (`modules/composer`)
- **Pure policy** `composeEncounter(snapshot)` in `application/compose.ts`; policy `composer-policy.v0` (`domain/policy.ts`: max 100 candidates, up to 3 offers, MMR lambda 0.2, exploration 0.10, last 20 encounters within 24 h). Four modes: `vertical | horizontal | return | variant` (`ComposerSnapshot.mode`). Horizontal = series/related continuation via an admitted link.
- **Candidate sources** (vertical): `content/adapters/discovery-store.ts` `readDiscoveryCandidates`, three lanes merged: same-topic as the source (up to 40, ordered by asset id), full-text (30, needs `text`, which vertical does not pass), and any admitted asset (100). Always current admitted revision only (`r.revision = a.revision`), excludes made-to-order Scrolls, filtered by `canRender` (parses the doc with scroll-model v1 and `negotiate`). Format list = `renderableFormats(documentSchemas)` ("`scroll-document.v1`"/"`reel-document.v1`").
- **Eligibility before scoring** (`exclusionsOf`): admitted, accessible, renderable, language, explicit format, exact target, variant same unit, **vertical never offers the current explanation unit** (`current_explanation`), required topics, exact link, horizontal needs an admitted link, hidden. No series or "same planet" exclusion exists.
- **Features** (`domain/features.ts`, all in [0,1]): `intent` (1 if candidate has a non-incidental topic among the source's topics, 0.5 if none known, else 0), `interest` (per-topic decayed activity A/(1+A), weighted by topic share), `format` ((1+Q)/(2+O) per **topic x kind(reel|scroll)**, 0.5 when unknown), `novelty` (1 - max(established repetition, recent repetition) by explanation unit and facets), `semanticFit` (Jev combination or lexical Jaccard fallback), `continuity` (admitted link strength), `recentRepetition`.
- **Scores**: Vertical `0.35 Intent + 0.20 Interest + 0.15 Format + 0.15 Novelty + 0.15 SemanticFit - 0.25 Repetition`. Horizontal `0.45 Continuity + 0.25 Intent + 0.15 Format + 0.15 SemanticFit - 0.25 Repetition` (`score()` in features.ts).
- **Choosing**: sort by score (ties by asset/revision key). First slot of a vertical move is a seeded mixture: 90% ranked winner, 10% uniform pick from the exploration pool (the pool is **all** candidates, `snapshot-assembly.ts`). Slots 2-3 by MMR (`score - 0.2 * similarity`, same explanation unit deduplicated, twins count as one). Decision (inputs, features, probabilities) stored in `composer.decisions` (30-day retention).
- **Plan lift** (`domain/plan.ts`): Planner opportunities add `+0.15 * agreement` to Intent (vertical) or Continuity (horizontal), only among candidates tied for the best base value (within 0.01).
- **Buffers** (`application/prepare-buffer.ts`, job `composer.prepare-buffer`): on every activation the worker pre-ranks the next vertical move (3 offers), stores one row per person in `composer.buffers` valid 10 min; the HTTP navigation serves it if session, intent revision, source offer, catalogue watermarks, Hide all still match, else ranks from scratch. A buffer is not an encounter and creates no evidence.
- **Format (Reel <-> Scroll) preference**: only the `format` feature, a per-topic per-kind qualified-response rate ((1+Q)/(2+O)), 15% of the vertical score and 15% of horizontal. Explicit format switch (`variant` mode) bypasses it. **Vertical mode carries no format intent**, so after a Scroll the next subject can be a Reel; `intent.format` is only set for a variant move. The client toggle (E06) is separate from ranking.
- **Series blindness**: `EncounterSnapshot.series` is loaded but unused by ranking. Because vertical retrieval and `intent` prefer the source's own topics (lane 1, Intent = 1), **the next-subject winner after Seasons Part 1 is usually another Seasons Part or a same-planet recipe**; the 3-slot MMR only deduplicates units.

### 2.2 Jev (`application/jev.ts`, `domain/jev.ts`, `domain/jev-pool.ts`)
- Role `composer.jev`, version `jev.1`, `budgetClass: 'background'`, max output 4,096 tokens, no repair. Input: `current_step` and up to 20 candidates, each described by **title + summary + facets only** (<= 700 chars). Output: `{assessments:[{ref, relevance, appropriateness, redundancy}]}`, each 0-1. Code combines `SemanticFit = 0.4 relevance + 0.4 appropriateness + 0.2 (1 - redundancy)`; the model never ranks. Unassessed candidates score a neutral 0.5; failure = absence, never negative.
- Runs only in the buffer worker (never on HTTP, never inside a transaction), `KS_JEV_ENABLED=1` on dev. D-058: judgements kept 30 min in `composer.jev_assessments` (<= 60 entries, per "subject" = language + primary topic of the step), refresh wait 10 min, so about one call per subject per 10 min. Background roles (Jev, Planner, Cartographer) share at most `KS_REASONING_BACKGROUND_SHARE_PERCENT` = 50% of the model budget.
- Jev does not know about Scroll structure, interactivity, game state, difficulty, or whether a candidate is a series part. It knows nothing the encounter snapshot (title, summary, facets) does not say.

### 2.3 Personal context and evidence inputs
- Composer reads `PreparedEvidenceInput` via `personal-context` (`READ_COMPOSER_CONTEXT`): per topic `activity` (14-day half-life), per topic per kind `{measured, qualified}`, last 20 actual encounters (explanation unit + facets), established encounter history for candidate units/facets, `hiddenAssetIds`, optional Planner plan. Missing history is neutral.
- Evidence (`evidence` module) owns qualification (`scroll-qualification.v0`), channels (`activity.v0`), topic-format Q/O. Only a qualified result (q >= 0.6, coverage >= 0.5) counts as Q. Likes, saves, deliberate continuation H, return R are separate channels folded into `a` (capped at 3).
- Personal context owns structural support (distinct qualified units and covered facets) that feeds Cartographer formation. Facet coverage comes only from content's `scroll-recipe-coverage.v1` (top-level paragraph/quote/callout blocks).
- Behaviour is routing evidence, not proof of learning (AGENTS.md, blueprint §8).

### 2.4 Planner (`modules/planner`)
- Role `planner.personal-planner` version `planner2` (policy `personal-planner.v0`), paced: first run immediate, then at most one per 5 minutes after material evidence changes (a qualified encounter, a deliberate continuation or a Save). Background budget share applies.
- Context (frozen per run): intent, topics from recent evidence, current plan + 3 older revisions, up to 100 inventory items (marked `encountered`), up to 20 qualified evidence refs. No qualified evidence = `insufficient`, no model call.
- Output: up to 3 accepted opportunities (from <= 6 proposed). Each: `move` (example, mechanism, limitation, consequence, perspective, connection), title, purpose, topicIds, explanationUnitId, evidenceRefs, `eligibility` (vertical/related), `formats` (reel/scroll), expiry <= 7 days, `target` = `existing` (exact unread admitted asset) or `missing_supply{brief}`. Diversified: one per unit, <= 2 per move, <= 2 per topic.
- Consumers: Composer (plan lift above) and Supply `RecordPlannedDemand`. **Planner's `missing_supply` never writes new content**: Quartermaster binds an unread existing asset or commissions only a **library recipe** (Create picks a recipe by code; planned Create cap `KS_SUPPLY_PLANNER_CREATE_DAILY_CAP`=5/day on dev). Planner has no notion of format variants (stage, call-it density) and no game inputs.

### 2.5 Quartermaster / Supply
- Reuse -> Join -> Create (see 1.8). Create is bounded by recipes still not published/takes left, `KS_SUPPLY_CREATE_DAILY_CAP` (10/day dev). A Reel or variant ask has no production path. Made-to-order orders are a separate path for thread branches only (what-if / perspective, `supply.scenario_orders`, caps 6/day and 6/thread).

### 2.6 What "next" means today
| Move | Mechanism today |
|---|---|
| Next subject (Reel swipe up; Scroll end button) | `vertical` composer move, buffer when valid; hard exclusion of the current unit only |
| Part 2 / previous Part | `series` intent, resolved by link (expected link id), no ranking; gives H credit to the source |
| Related | `related` intent, resolved by link |
| Reel <-> Scroll | `variant` intent (twin of the same unit), explicit |

---

## 3. V3 design summary (PDF "KnowScroll — Product design v2", 11 pages; marked EXPLORATION, NOT DECISIONS)

Page order: 1 recommendation / pushback, 2 questions, 3 prototype (Play), 4 gesture models (A), 5 moving on (G), 6 Seasons flagship, 7 blocks in use, 8 block language table, 9 game loops (C), 10 Ask (D), 11 endings (E).

### 3.1 Stage + Spine and gesture model (p1, p4, p5)
- **A1 Stage + Spine (the pick).** A pinned picture ("stage") on top; short text stops scroll under it with a soft snap (one stop per screen); a **spine** of dots down the right edge (blue dot = here, diamond = Call it, star = Final call; every dot is a labelled button, "4 of 10: You are here"). Dock at bottom: **Ask about this** (A), sparks count, **•••**, **Part 2 →**. Top bar: **Universe** (planet button, top left, U), Reel|Scroll toggle (F), **Next ↑** (N, top, always visible, "for when a swipe doesn't work"), title "SEASONS · 1 OF 3".
- Alternatives kept for reference: A2 Stories pages (tap left/right = page; kills skimming/selection) and A3 long column + Map (pinch outline, thumb scrubber).
- **Grammar** (same in Reels, "left = same topic, up = new topic"): swipe **left** on the text (Part 2 waits to the right) at any time continues the thread, Part 1 keeps your place; swipe **right** (not from the edge) goes back a Part; **pull up past the end** (a pull-up meter, momentum from reading never counts) or top **Next ↑** = next topic; mid-read, swipe up is reading. Drags inside the stage belong to the picture. Keys: down/Space next stop, up previous, right continue, left previous Part, N next topic, U Universe, A ask, T text version, F format, 1-3 pick, Enter lock in, Esc closes.
- Emitted events listed in the design: OBS `scroll.stop_visible{n}`, CMD `thread.continue{part}`, NAV `thread.part{n}`, CMD `subject.next{format}`, NAV `universe.open{resume}`, CMD `ask.open{context: stop}`, CMD `format.switch`, CMD `call.lock{stopId, option}`.
- p5 states: reading, swipe-left mid-read (Part 2 enters from the right, **the stage carries over**, camera slides along the orbit to December), the end tray (pull-up meter), Next-tapped fallback, ••• sheet (Title -> thread list "Part 1 check, 2, 3", Reel|Scroll, Save, Share a moment, Challenge a friend, Text version, Simpler (this screen), Small print, Report). "Seasons Part 1 is kept at 4 of 10."
- **Text version** per stage (stage chip, •••, or T): the whole Scroll as plain text; each stage state written as one descriptive sentence; calls become ordinary questions with answers below. Reduced motion: stage cross-fades, swipe to Part 2 is a cut, pull-up meter still fills.

### 3.2 Call it, Plot twist, sparks, combo, Final call, landmark (p3, p6, p7, p9)
- **Call it** = choose -> **Lock it in** (Enter) -> reveal on the stage. Options 1-3 or a slider; answer, reveal stop, explanation, and `common_guess{text, source}` (e.g. the 1987 film A Private Universe). **Wrong choice = "Plot twist!"** ("You're in good company...", the best moment, no penalty); right = "Called it!" +1 spark. Haptics: light tick on select, medium on lock, success pattern on reveal, one soft tap for Plot twist, rising triple tap on landmark. Sound off by default.
- **Sparks / combo**: each correct call +1 spark; consecutive correct calls build a combo (x2 doubles the Final call). Visible counts (e.g. "3 SPARKS", "COMBO x2", "FINAL CALL check").
- **Final call** (boss, last stop): uses the stage or a simulation (e.g. tilt slider to 0 degrees) and unlocks a **landmark** per Scroll ("The Leaning Axis"): **gold if right first try, plain otherwise**. The landmark is announced before play ("Get it first try for the gold landmark"), so the reward is earned not gambled. Wrong Final call still gets the landmark in plain finish.
- Other game blocks: **sort** (rebuild the chain, can be the Final call), **fork** (choose-your-path, branches of <= 2 stops that rejoin), **scene** hotspots (clues for the next call), **guide** (Ray the sunbeam reacts to right/wrong), **scale** ("you are here", linear/log).
- **Challenge a friend**: send your Final call into a content thread; their answer stays hidden until they make their own call. Threads first, links later (Q11).
- Anti-manipulation table (p9): no loss-based daily streak (-> weekly **Orbit**: 3 days closes it; nothing you own resets), no random loot (-> deterministic landmarks "Next: Part 2 · Turns"), no "you'll lose your streak" push (only "your Scroll is ready" or a friend's challenge), no global leaderboards, wrong answer is not scored as failure, **no score feeding Universe formation (play layer kept separate)**, no endless autoplay (natural stop after Final call with "Done for today").

### 3.3 Across-session loop (p9)
- Universe is the collection: **Orbits ring the star** ("ORBIT · 2 OF 3 DAYS this week"), **landmarks stand on planets** (gold/plain, "Landmarks on Earth & sky: 2 of 3 seen", next landmark shown dashed), **clear skies thin as you finish Scrolls** (cloud layer on a planet). "Missed a week? Nothing here goes away. Orbits just start fresh on Monday." List view lists landmarks (accessibility). Reduced motion shows final states without flights.

### 3.4 Ask rethought (p10)
- **D1 Ask from here (pick, default sheet):** suggested questions drawn from what you just read (3 chips, keys 1-3) + "or ask anything"; scope defaults to the thing being read unless the text clearly starts a new subject; format follows the person's habit per topic family; one editable line "A short Scroll · about Seasons · Change". After send: **honest status** "Making it now. We'll put it in your Seasons thread when it's ready, usually [typical time]" (a real typical time once measured, never invented), a card you can leave, a note in the thread when ready, notification only if allowed; **meanwhile a 20-second puzzle** ("On 21 June, which city has the longer day?"). Counter shown only near the limit; `?` opens Ask, Esc closes.
- **D2 Select to ask:** native selection menu gets two new items, **Simpler** and **Ask** (no long-press gesture). Inline result labelled "**Quick answer · not a checked Scroll**", never fed into the Universe, with "Make it a full Scroll". "Simpler" rewrites the next paragraph in place with Undo. This needs **read-time generated text** (new capability: cost per tap, latency, no editorial check).
- **D3 Ask as a wager:** guess first ("Lock in my guess · Send"; "Just send it" always present); "Called it! +1 spark" when the Scroll arrives; optional twist once Call it exists.
- My pick in the PDF: D1 as default sheet plus D2 for in-text questions; D3 optional.

### 3.5 Endings (p11)
- Replaces E02 end card, E05 continue box and E08 where it touches Scrolls. **E1 Payoff (pick):** the recap picture (final stage state + 3 captions), score row (3 sparks, combo x2, Final call), a gold landmark "flying to your Universe", Part 2 peeking from the right edge as a cliffhanger line, one primary action; left = continue, up/N = something new; "Done for today" equal weight; "Small print" chip. **E2 Cliffhanger** (end is Part 2's first question, locked teaser) and **E3 Universe reveal** (camera flies, landmark lands; used as the transition when finishing a whole thread; slowest). Drag past a notch to continue; Esc/skip; momentum never counts.
- **Limits** is never last: an `aside kind=limits` placed next to the claim it limits (stop 8 of Seasons, monsoon heat) and a "Small print" chip on the recap.

### 3.6 scroll-document.v2 proposal (p8) — 23 blocks
NEW (12): `stop`, `line`, `aside`, `stage`, `call_it`, `final_call`, `scale`, `scene`, `sort`, `fork`, `guide`, `recap`.
KEEP (5): `paragraph`, `quote`, `table`, `code`, `media`.
CHANGED (6): `heading` (rare, level 1-2), `list` (discouraged, items <= 5), `diagram` (node-link only; `nodes[], edges[], layout`), `chart` (may grow across stops, `grows_with: stops[]`), `simulation` (adds sin, cos, clamp; `bind_stage?`), `figure` (`source: kit|image, alt, caption`).
CUT/MERGED (6 block types and 2 rules): `sequence` (the stepper, cut), `comparison` (-> table or a stage toggle), `callout` + `disclosure` (-> `aside`), `timeline` (-> `scale` with a time axis), `subheading` (-> `heading`), the top-of-Scroll "Text version of diagrams" toggle (per-block text version + T key), "Limits as the last block" (-> aside kind=limits + recap chip).

Fields the writer fills:
| Block | Fields |
|---|---|
| stop | `id, text (<= 60 words), stage_state?, emphasis?` |
| line | `text (<= 12 words)` |
| paragraph | `text` (inside a stop) |
| heading | `text, level (1-2)` |
| aside | `kind: tangent\|limits\|definition, title, text, anchor_stop, collapsed` |
| quote | `text, who, source` |
| list | `items[] (<= 5), ordered` |
| stage | `scene (kit ids + params), states[{stop, changes}], alt_per_state[]` |
| call_it | `prompt, options[] \| slider{min,max,unit}, answer, reveal_stop, explain, common_guess{text, source}` |
| final_call | call_it fields + `binding{simulation_id, param}, bonus, landmark_id` |
| scale | `axis: linear\|log, unit, points[{label,value}], you_are_here, zoom_stops[]` |
| scene | `illustration (kit scene \| image_id), hotspots[{x,y,label,text}]` |
| sort | `items[], correct_order \| buckets{}, explain` |
| fork | `prompt, options[{label, stops[<=2]}], rejoin_stop` |
| guide | `character (kit id), line (<= 25 words), pose` |
| recap | `stage_state: final, captions[<=3], small_print_ref` |
| diagram | `nodes[], edges[], layout` |
| chart | `type, series, grows_with: stops[]` |
| simulation | `inputs[], formula, outputs[], bind_stage?` |
| table / code / figure / media | `columns[], rows[]` / `lang, text` / `source: kit\|image, alt, caption` / `reel_id, start, end, caption` |
| document | `schema: "scroll-document.v2", misconception{claim, source}, stage{scene, params}, stops[]` |

**Per-Scroll budget** (replaces "max 8 interactive"): per 3-6 minute Scroll, <= 1 stage, <= 4 calls (including the Final call), <= 2 other interactives (scene, sort, fork, scale, simulation, chart).
**Writer contract changes:** `misconception` required (with a source; "none" allowed for narrative/editorial) and powers the first Call it and the Plot twist; voice: second person, short lines, about one joke per two stops, guide character makes the mechanism literal. **Validation (rejects the document):** stop <= 60 words; every visual has alt text and a text version; every call has answer + reveal + explanation; a limits aside exists and is not last; the budget holds; reading time 3-6 min at 230 wpm plus 10 s per call; `common_guess` needs a source (study/survey or our own aggregate once it exists); facts with numbers carry a reference id.
Every block has a text version, a gesture-capture statement, a game hook and a visual source (table columns). Nothing is model-written HTML.

### 3.7 Drawing kit and engines (p7, p8)
- **Kit** (parametric parts the writer arranges by id + params, never drawn by the model): characters (Ray the sunbeam: one guide per topic family; stick-figure reader), bodies (Earth with tilt/continents/pins, Sun, Moon, planets, orbits), things (arrows, thermometers, rulers, scales, calendars, buildings, people, simple maps), landmarks.
- **Engines:** existing diagram, chart, simulation (+ sin, cos, clamp; Ray's spreading = 1/sin(elevation): 90 deg 1x, 30 deg 2x, 20 deg ~2.9x). **NEW stage engine** (kit scene graph, keyframed state per stop, interpolation; "Skia on native, SVG on web", described as "the biggest build"), **NEW scale/zoom engine** (linear/log, "you are here", zoom stops), **NEW game runtime** (call_it/final_call/sort scoring, combos, sparks, haptics, landmark awards). Generated images only as optional mood backdrops/Universe texture, never geometry, data or anything a call depends on.
- Seasons rebuilt: 10 stops (hook, Call it #1 misconception, Plot twist, "you are here" scale, Call it #2 lean, meet Ray (simulation), longer days, where this stops (aside), Final call (tilt 0), payoff), 3-6 minutes. Proposal to restructure the Seasons thread: Part 1 owns the distance myth, Part 2 stays "Why the hemispheres take turns", **Part 3 becomes "Seasons elsewhere: Mars, Uranus and a world with no tilt"** (today it is `seasons-limits`).

### 3.8 Questions page (p2): the 16 questions and the PDF's leanings (not locked)
| # | Question | Leaning |
|---|---|---|
| 1 | Stage + Spine default for every Scroll, or only mechanism topics? | Default, plus an "editorial" variant (no pinned stage) for essays like the Polynesian navigation piece |
| 2 | How big may the pinned stage be on 320-360 px phones? | Shrinks to ~220 px and expands on tap. Test first |
| 3 | Is swipe-left (Part 2 to the right) the direction meant by "swipe right"? | Yes. Left-to-right from the edge is the phone's back gesture; Reels already use left. Mid-read up stays reading |
| 4 | Should a wrong call cost anything? | No. Only stake is a gold vs plain landmark on the Final call |
| 5 | Do sparks spend on anything? | Just a score, no currency; landmarks are the collection |
| 6 | Weekly Orbit: 3 days a week? | 3 days, never daily, nothing taken away |
| 7 | Should play results influence how planets form at all? | **No.** Separate play layer (landmarks, clear skies) on top of evidence-based formation |
| 8 | Read-time Quick answers (Simpler, Ask about a sentence): unchecked model text, labelled? | Yes, labelled "Quick answer" with report; "Make it a full Scroll" gives the checked version |
| 9 | "Common guess": only authored, sourced misconceptions until real data? | Yes to both; never invented numbers |
| 10 | Sound: off by default with toggle, or none? | Off by default. Haptics on |
| 11 | Challenge a friend: threads only, or external links too? | Threads first, links later (share landings must handle calls) |
| 12 | Restructure the Seasons thread (Part 3 = "Seasons elsewhere")? | Yes |
| 13 | Should Reels get Call it moments too? | Later, as an experiment |
| 14 | Writer required to name a misconception with a source for every Scroll? | Yes, "none" allowed for narrative/editorial |
| 15 | Show "3 min · 3 calls" before opening a Scroll? | Yes. Counts are allowed now; sets expectations |
| 16 | Reels get the top-bar Universe and Next-up fallback too? | Yes, same two buttons in the same place; nothing else in Reels changes |
Other asks in the PDF text: next topic remembers the format you are in (Scroll stays Scroll), leaning yes; swipe-left mid-read skips the rest of Part 1 but keeps your place, leaning yes. "What I'd test first, on real phones": stage feel and snap strength, stage height on 320-360, "Plot twist!" fun vs shaming, writer reliability on stage states and calls ("run 20 topics through it before building engines"), and whether people find left = continue without a button.

---

## 4. Change table by layer

Size key: S under ~1 day, M 1-3 PRs, L its own phase (several PRs). "Module" = `packages/backend/src/modules/<name>` unless a path is given.

### 4.1 scroll-model v2 (`packages/scroll-model`)

| Change | Where | Size |
|---|---|---|
| New schema `scroll-document.v2` next to v1 (do not mutate v1): header + `misconception` + `stage` + flat `stops[]`; new block types and `version` literals; `limits` v2 (stops <= ~14, calls <= 4, other interactives <= 2, stop <= 60 words, doc bytes) replaces `interactiveBlocks: 8` with the budget | new `src/v2/{document,blocks,limits,validate}.ts`; `index.ts`; a `parseAnyDocument` dispatcher | L |
| Measures v2: weight per stop, reading estimate **230 wpm + 10 s per call** (today `WORDS_PER_MINUTE = 200`, `scroll-measures.v1`) -> `scroll-measures.v2`; reading facts v3 for evidence | `src/measures.ts`, `content/domain/reading-facts.ts` | M |
| Locators: `scroll_passage` / `projectText` must project `stop.text`, `line`, `aside` (today only paragraph, quote, callout, list); snippet anchors and anchor maps (`deriveAnchorMap`, `repointLocator`) for v2 | `src/locators.ts`, `src/registry.ts`, `content/adapters/snippet-anchors.ts` | M |
| `INTERACTION_KINDS` for new blocks (`call_it: option-selected, locked`; `final_call`; `sort: checked`; `fork: path-chosen`; `scale: zoomed`; `scene: hotspot-opened`; `stage: part-tapped`) - **value-free** (no option, no correctness) | `src/registry.ts`; consumed by `contracts/interactions.ts`, `evidence/application/ingest-observations.ts` | S |
| Simulation: add `sin`, `cos`, `clamp` to the closed formula set; grid-proof and `display` code; `bind_stage` | `src/blocks/simulation.ts`, `src/simulation/*` | M |
| BlockState v2: `call_it {locked option, revealed}`, `sort {order}`, `fork {path}`, `stage` (current state is derived from scroll position, not stored) | `src/state.ts` | S |
| Negotiation: schema `scroll-document.v2` in `ClientCapabilities`; fallback for unsupported blocks (stage -> its text states; call_it -> plain question + answer) | `src/negotiation.ts`, `src/fallback.ts` | M |
| Writer authoring shape `scroll-authoring.v2` (**flat**, see 4.3) + converter + compile + reasons/hints | `src/producer/authoring-*.ts`, `compile.ts` | L |
| **Compatibility of the 54 v1 Scrolls** | see below | |

**v1 migration options.**
1. *Render v1 forever (recommended as the baseline).* Server and clients keep `scroll-document.v1` parse, negotiate and render. Zero risk for the 54 Scrolls and for old exposures, Keep entries and snippets (all hold v1 revisions). Cost: two renderers; clients advertise both schemas; `renderableFormats` and `canRender` must read both. These are "classic" Scrolls, no stage, no calls, no spine; in the new shell they would show the old poster layout with the new top bar / swipe grammar only.
2. *Convert* (mechanical v1 -> v2: paragraphs become stops of <= 60 words; callout kinds -> aside; sequence/comparison/timeline mapped per the cut table). Lossy and cheap, but a converted Scroll has no misconception, no Call it, no stage; it would be a worse Scroll in the new shell and it would break stable block ids, passage offsets and the `measures`/coverage bindings. **Not recommended** except for a fallback "text only" rendition.
3. *Regenerate* (recommended for the library over time). Bump `SCROLL_PRODUCTION_VERSION` (and `WRITER_PROMPT_VERSION`) so every recipe becomes a new job, publish as **a new revision of the same assetId** (identity never changes, D-033 rule), re-run `content admit-continuity` (new series revision) and let the hook redo coverage. Note `discovery-store` serves only the current revision per asset (`r.revision = a.revision`), so once regenerated, the v1 revision stops being a candidate and old exposures/Keep entries still open their pinned v1 revision. Existing snippets/anchors on v1 revisions: `repointLocator` returns `changed`/`removed` (accepted on dev: disposable accounts).
   Cost: about 54 recipes x (1 writer + at most 1 repair) = up to 108 MiniMax requests; the v1 seed took about 70 requests and 1.4M tokens, and a v2 document with stage states and calls is larger, so plan about 2x tokens. The production scope caps (200 requests, 3M tokens per day on dev) fit if done in waves; mind the 5-hour MiniMax window.
Recommended: (1) as baseline, (3) in waves, never (2).

### 4.2 Content module: recipes, coverage, discovery, series

| Change | Where | Size |
|---|---|---|
| Recipe fields: `misconception {claim, source}` or `'none'`; `variant: 'stage'\|'editorial'`; `kitScene`, `guide`; `landmark {id, title, kit}` and `finalCall` binding authored per recipe (code sets landmark identity; the model never names it); keep `interactiveKind` only for the <= 2 other interactives | `content/domain/library/plan.ts` and the 6 system files | M |
| New recipe `seasons-elsewhere` + facet `earth.seasons.elsewhere`; series `library.earth.seasons` = seasons, seasons-hemispheres, seasons-elsewhere (Part 3 today is `seasons-limits`, whose facet meaning is pinned in coverage; changing the meaning would unmap it) | `library/earth.ts`, `library/continuity.ts`, concept catalogue | S |
| Coverage rule `scroll-recipe-coverage.v2`: eligible = text-bearing **stops** (not top-level paragraph/quote/callout); first/middle/last rule on stops; **without this no planet can form from a v2 Scroll** (`COVERAGE_LOCATOR_TYPES = ['paragraph','quote','callout']`, MIN 3 eligible blocks) | `content/domain/coverage.ts`, `recipe-coverage.ts`, `adapters/coverage-store.ts`, `readmit-coverage` | M |
| Reading facts + traits: store `traits {playLevel: plain\|stage\|game, calls, hasFinalCall, stage, readingMinutes}` with the revision for Composer/Jev (see section 5) | `content/domain/reading-facts.ts`, `discovery_revisions` (migration), `EncounterSnapshot` | M |
| Series total and cliffhanger on continuation metadata: `series.total` (count of `series_units`, not invented), `teaser` (recap/cliffhanger line, authored, <= 80 chars) | `content/domain/discovery.ts`, `contracts/navigation.ts` (`ContinuationState.metadata`), experience context | S |
| Hard-wired `scroll-document.v1` literals to generalise | `content/adapters/{render-scroll,snippet-anchors,keep-position-target,region-candidates,discovery-store(canRender)}.ts`, `planner/adapters/nest-providers.ts`, `composer/application/vertical-candidates.ts` | S-M |

### 4.3 Writer prompt, validator, admission (`content/production`, `scroll-model/producer`)

| Change | Notes | Size |
|---|---|---|
| New instructions `scroll-writer.v14`/`scroll-production.v15`: misconception-first, second-person voice, stops <= 60 words, Call it with reveal and Plot-twist explanation, Final call bound to a kit simulation, aside kind=limits next to the claim and not last, guide line at most every few stops, 3-6 min | `production/writer.ts` (`writerInstructions`, `FORMAT_GUIDANCE` replaced), `authoringReference` | L |
| **Keep the authored shape flat** (D-032: the model loses count in nested JSON): one list of `stops`, each `{type, text, cites, stage?: {key: value,...}}` with kit scene/ids from closed enums; calls as stops of type `call_it`; no `states[{stop, changes}]` nesting. Code builds the canonical `stage.states[]` | `authoring-schema.ts`, `authoring-convert.ts` | M |
| New findings/hints: `stop_too_long`, `call_missing_reveal`, `limits_aside_last`, `budget_exceeded`, `misconception_missing`, `stage_param_out_of_range`, `kit_id_unknown`; `reading_length_out_of_brief` becomes 3-6 min | `producer/reasons.ts`, `WRITER_SAFE_ISSUES` | M |
| Numbers: stage/kit params (tilt 23.4, sun height 30 deg) are geometry, not claims: validate against kit bounds; digits in **reader text** still need a cited passage. Call answers and `explain` text are claims and must cite | `compile.ts`, `authoring-bind.ts` | M |
| `common_guess.source` and `misconception.source` are **set by code from the recipe**, like kicker/framing, not written by the model; the "never name the source" rule (`bannedNames`) must not strip them; the source must be a human-reviewed label, because a film like "A Private Universe" is not a fetched page on the research allowlist | `writer.ts` (`bannedNames`), `library/plan.ts` | S |
| Research allowlist and passage pool: no change, but recipes need pages that actually state the misconception facts | `infrastructure/research/public-pages.ts`, `scripts/check-library-sources.mjs` | S |
| Output budget: 16,000 tokens covers 600 words plus 10 stops with stage and 3-4 calls only if thinking stays low; test, then raise `maxOutputTokens` (D-032 note: thinking tokens count) or keep calls few | `writerRole` | S |
| Ask-order mode `question` (see 4.8) and scenario modes keep working with v2 | `writerInstructions(format, mode)` | M |
| Human sampling per generated Scroll (accuracy, misconception correct, Plot twist reads as warm, reading time) remains required (scroll-production.md "Evidence for acceptance") | process | S |

### 4.4 Drawing kit and engines (`packages/ui/src/scroll`, a new `packages/ui/src/scroll/kit`)

Dependencies today: `react-native-svg`, `react-native-gesture-handler`, RN `Animated`, `expo-video`. **No Skia, no reanimated, no haptics library.** PDF says "Skia on native, SVG on web"; recommended instead: **react-native-svg on both** (shared code, already used by diagrams and the Universe) and RN `Animated` for interpolation, with a `kit` parts library as plain functions of params. Skia stays a later optimisation if phones struggle.

| Piece | Size |
|---|---|
| Kit v1: Sun, Earth (axis, pins, continents-lite), orbit, Ray, thermometer, arrow, calendar strip, landmark badge; closed id/param schema shared with scroll-model (schema is the contract the writer sees) | L |
| Stage engine: scene graph + keyframed state per stop + interpolation, cross-fade for reduced motion, text version per state, pinned layout, tap targets for calls | L |
| Spine + dock + top bar components; stage sizing 320-360 px (shrinks to ~220 and expands on tap) | M |
| Call it / Final call / sort / fork / scene hotspots / guide / recap views + game runtime (lock, reveal, Plot twist, haptics hook) | L |
| Scale/zoom engine (linear/log, zoom stops) | M |
| Chart `grows_with`, diagram node-link rewrite, simulation `bind_stage` | M |
| Haptics: add `expo-haptics` (native) and a no-op on web; sound off | S |
| Accessibility: every dot a button, text version per block, reduced motion, keyboard map (`1-3`, `Enter`, `N`, `U`, `A`, `T`, `F`) | M |

Each other system (machine-learning, computing, history, human-body) needs its own kit parts or must use the **editorial** variant (stops + calls, no stage); do not promise a stage for all 54 (see section 5e).

### 4.5 Client navigation and gestures (`apps/client/features/encounter`, `scroll`, `explore`)

| Change | Where | Size |
|---|---|---|
| Swipe-left = continue (series next, else related, as `gesture('next')`), swipe-right = previous Part, for **Scrolls** (today Reel-only: `encounter-reel.tsx`, `gestures/arbitration.ts`). Scroll needs its own arbitration: drags inside the stage and on `gesture != none` blocks belong to the block; native edge zone stays platform Back | `encounter-scroll.tsx`, new `scroll-gesture-stage`, `gestures/arbitration.ts` | M |
| Pull-up past the end with a meter; momentum never counts (today the end card button only; E02 note "momentum at the end never reaches these buttons") | `scroll-end.tsx` replaced by an end tray; `ui/src/scroll/article.tsx` | M |
| Top bar: Universe (U), Next up (N), format toggle; same two buttons on Reels (Q16) | `encounter-top-bar.tsx` | S |
| Dock: Ask about this, sparks, more, Part 2; more sheet rows (Challenge, Text version, Simpler, Small print) | `encounter-actions.tsx`, `encounter-sheets.tsx` | M |
| Next-topic carries the format: `subject.next{format}` -> `NavigationIntent` vertical gets optional `format` | `contracts/navigation.ts`, `encounter-session.ts`, experience navigation | S |
| Part 2 peek and resume: stage state carried across Parts; "Resume Seasons Part 2 of 3" chip in Universe | `encounter-session.ts`, universe screens | M |
| Remove/replace `ScrollEnd` Continue/Related rows and E08 for Scrolls; "Done for today" | `scroll-end.tsx`, `encounter-ending.tsx` | M |
| Desktop: key map, multi-pane Explore (D01), axe checks | `apps/client/features/shell`, keyboard map | M |

### 4.6 New game state (predictions, locks, sparks, combos, Final call results, landmarks, Orbits)

**Owner: a new backend module `modules/play`** (not Evidence, not Experience, not Geography). Reasons: Evidence = qualification of consumption (AGENTS: behaviour is evidence); Geography = formation by qualified evidence (Q7 leaning: play must not shape it); Experience = sessions/offers/actions. Play depends on Experience (exposure authority) and exposes ports to Universe reads; nothing in composer/planner/evidence/personal-context/geography may import play's `correct`/score fields (enforce by a dependency-cruiser rule).

| Item | Detail |
|---|---|
| Tables (migrations) | `play.calls` (universe_id, exposure_id, asset_id, revision, stop_id, choice json, **correct bool**, command_id, locked_at; immutable, unique per exposure+stop), `play.scroll_results` (exposure, sparks, best_combo, final_call outcome, landmark_id, tier gold\|plain), `play.landmarks` (universe, landmark_id, asset_id, tier, earned_at, first_tier), orbit days derived from `scroll_results.finished_on` (week = ISO week in the person's timezone). No leaderboards, no aggregates across people |
| Commands | `call.lock{stopId, option}` idempotent by command id (like other receipts); `scroll.finish` is implied by Final call lock or reaching the recap; the server **recomputes correctness** from the immutable revision (never trusts the client) |
| Authority | exposure must be the caller's activated exposure of that revision (reuse Experience `READ_EXPOSURE`-style port); locks are rejected outside an activated reader |
| Recording / Pause | Calls are an interaction inside a reading encounter. While recording is paused (`RecordingScopeTx`), play still works on-device but writes **nothing server-side** and says so ("Not saved while recording is paused"); owner to confirm (section 6) |
| Erasure | declare in `modules/play/adapters/erasure.ts` and add to `src/erasure-registry.ts` (`moduleErasures`): full erasure and **Clear exploration = erase** (landmarks stand in the Universe, which Clear wipes); export = include own calls, results, landmarks (`exportPersonalData`); `checkErasureInventory` will fail until declared |
| Read API | `GET /v1/play/summary` (sparks this Scroll, orbit week, landmarks), `GET /v1/play/landmarks`; contracts in `packages/contracts/src/play.ts` |
| Client | `packages/client-core` play session (idempotent command with retry, offline queue like observations), local mirror for optimistic UI |
| Size | M (tables, commands, erasure, export, tests) + M (client) |

### 4.7 Universe / Cartographer linkage for landmarks

- **No formation linkage** (Q7 leaning, and AGENTS "planet formation needs qualified evidence"). Play layer is read-only overlay: Scenes projection stays unchanged (stored object family never changes); landmarks, Orbit ring and clear skies are drawn by the Universe client from the `play` read API on top of the persisted anchors, keyed by planet/system id (`LibraryRecipe.topicId` / `systemId`).
- **Gap: a landmark can be earned before its place exists.** A planet needs 3 units over 2 facets; a system needs 2 units. After Seasons Part 1 only dust exists. The design's "Your landmark is waiting" tray implies a shelf: show the landmark in a collection list/tray (also the accessible list view) and attach it to its planet/system on the map once that forms. No Cartographer change.
- New drawables in `packages/scene-core` (landmark badge on a planet, orbit ring around the star, cloud layer by finished-count) and `apps/client/features/universe/*`. "Clear skies thin" = density derived from finished Scrolls of that planet in `play.scroll_results` (a play fact, not evidence).
- Size: M (scene-core + universe screens + a11y list view).

### 4.8 Ask pipeline (`supply`, `content/production`, contracts, client `requests/`)

| Change | Notes | Size |
|---|---|---|
| Contracts: ask `context` gains `anchor {stopId \| passage locator}` and drops required format; response states unchanged | `contracts/supply.ts`, `request-session.ts` | S |
| **Ask orders** (new): a person's question about the Scroll they are on becomes a made-to-order short Scroll (mode `question`), because Create today can only commission a library recipe and a context-bearing text ask is **unsupported** (`supply/README.md`). Reuse the D-049 mechanism: `content.made_to_order_scrolls`, `supply.scenario_orders`-style ledger with its own daily and per-person caps, the source recipe's allowlisted pages as research, `QUESTION_RULES` appended to the writer (answer this question in <= 3 stops, 1-1.5 min, no stage, calls optional, ends with a limit aside), publication `attribution: 'none'` | L |
| Scope inference: extend `supply/application/match-role.ts` so the model receives the current topic/facet and answers "same topic unless the text clearly names another"; code still accepts only catalogue members for library asks | M |
| Suggested questions (D1 chips) **authored by the writer** per Scroll (`ask_suggestions[<=3]`), validated mechanically; no read-time model call | S |
| Honest wait: `estimate` on request status from the median of recent completed production runs (null until >= 5 samples; UI says "usually about N min" only when present); 20-second puzzle from authored `puzzle[]` or an unspent call | S-M |
| D2 select-to-ask: add "Ask" and "Simpler" to the selection menu on web (`contextmenu`/selection API) and native (`TextInput`-less: RN text selection menu items are limited; may need a custom selection toolbar) | M; native risk |
| D2 "Simpler": **authored at production** (`simple` text per stop, <= 40 words) so it is instant and free; a read-time "Quick answer" would be the first model call on a path a person waits for and conflicts with AGENTS (calls only in workers). If wanted, make it a worker job with polling and a daily cap | S (authored) / L (live) |
| Reels and variants still have no production path (`budget_unavailable`): hide "Reel" in the editable line | S |
| Where the answer lands ("in your Seasons thread"): there is no solo thread object; first slice lands it through the existing ready notice + Requested list; a personal continuity link is a later design | S |

### 4.9 Social: Challenge a friend (later)
- New snippet kind `scroll_call` / challenge message in `modules/social` + `threads` contracts; recipient's answer hidden until they lock their own call; sender's result stays private until then; the challenge is an invitation and creates **no** consumption evidence (AGENTS). Size L. Defer; leaning in PDF: threads first.

---

## 5. Recommendation / personal-algorithm changes

Principle from AGENTS.md and blueprint §8: *adapt quickly to current intent, cautiously to lasting meaning; behaviour is evidence, not proof of learning, belief or identity; only actual Reel/Scroll encounters create consumption evidence.* The owner has relaxed the **display** rules for Scrolls (sparks, combo, streak-like Orbits are allowed). That does not relax the **inference** rules.

### 5a. Do Call-it answers and scores count as evidence or as learning signals?

Recommendation: **a call is an interaction inside an encounter, not a new consumption event, and its correctness is never an input to ranking, planning or formation.**

| Fact | May it be used? | How |
|---|---|---|
| The Scroll was actually read (visibility, dwell, coverage) | Yes, as today | `scroll-qualification.v0` -> Evidence -> activity, formats, formation. Calls only add to the reading estimate (+10 s each) so honest play does not look like "under-read". No formula change for q |
| A call was **locked** (engagement), Final call reached, Scroll finished | **Yes, as engagement/format-fit routing evidence** | Counts as "deliberate interaction" (already value-free `scroll.block_interaction`); used for the per-topic play-style fit (5c). Does not add a new channel to `a = min(3, ...)` in v1 of this change; measure first |
| **Which option** was chosen; **right or wrong**; first-try gold; sparks; combo | **No, never** for Composer, Jev, Planner, Evidence activity, Personal Context, Cartographer, Scenes | Stored only in `play.*` for the person's own collection, recap and export. Enforce by a dependency rule: composer/planner/evidence/personal-context/geography do not import `modules/play`. Never in the Jev/Planner model context |
| "The person holds misconception X" / "knows topic Y" | **No** | Would be a claim about belief or learning (blueprint §1 "does not score learning or announce what a person supposedly believes"; §12 "no topic scores or mastery levels"). Plot-twist copy talks about the call ("You're in good company"), never "you thought/you don't know" |
| Playing a game-heavy Scroll to the end | Yes, as response to a *kind* of content | Via topic x play-level cell (5c), not as proof of interest in the topic itself (that is still qualified reading) |
| A gold tier | Display only | Never ordering, never a planet attribute, never aggregated per topic. Blueprint line 1257 ("Universe: no topic scores or mastery levels") needs an owner confirmation that a *per-Scroll trophy* is not a mastery level (section 6) |

Anti-gaming: spine jumps can make blocks "seen" (>= 500 ms visible), but q still needs dwell: jumping to the end gives coverage ~1, dwell/reading-estimate small, so q ~ 0.5 < 0.6 and the Scroll does not qualify. Keep `q >= 0.6` and `coverage >= 0.5`; add a regression test with a "tap every dot" trace. Tapping options without reading does not raise q.

Evidence qualification changes needed (small): reading facts v3 weights per stop, estimate = words/230 + 10 s per call (`measures`), policy `scroll-qualification.v1` as a **new version** over the same input (the old one stays for v1 documents); recorder reports stop visibility under the existing `scroll.block_coverage` (stops are blocks with ids). Files: `scroll-model/src/measures.ts`, `evidence/domain/{policy,qualification}.ts`, `content/domain/reading-facts.ts`.

### 5b. Next topic after an ending, and swipe-left to Part 2

**Swipe-left / "Part 2 ->" is the existing `series` navigation.** No ranking change. Needed: allow the gesture in Scrolls (4.5), series total + teaser in the continuation metadata (4.2), and the H credit rule below.

**Next topic (pull up / Next up) needs a Composer policy change**, because today vertical means "stay near the source's topics":
- `features.ts`: `intent` is 1 for any candidate sharing a non-incidental topic with the source and 0 otherwise (weight 0.35), and `readVerticalCandidates` retrieves the source's planet first. `EncounterSnapshot.series` is loaded and ignored. So from Seasons Part 1 the best "next subject" is usually Seasons Part 2 or 3 or another Earth recipe: it collides with V3's grammar (left = same topic, up = **new** topic) and would make the Part 2 peek and the pull-up say the same thing.
- Proposed `composer-policy.v1` (versioned record, parameters not claims, blueprint §8):
  1. **Hard exclusion `same_series`** in `exclusionsOf` for vertical moves: every part of the source's series (and the source's related-linked target, which is reachable by the dashed tab). Files: `composer/application/compose.ts` (`exclusionsOf`), `domain/types.ts` (source series ids), `snapshot-assembly.ts`.
  2. **Reduce topic stickiness for vertical**: lower Intent weight 0.35 -> ~0.15 and add a *recent-topic repeat* penalty over the last 3 encounters (today `recentRepetition` uses only explanation/facet overlap, so a different planet never repeats). Keep Interest (0.20) and Novelty (0.15). Needs offline replay on stored `composer.decisions` before choosing numbers (decisions keep full inputs, 30 days).
  3. **Format stays sticky**: add optional `format` to the vertical intent (the Reel|Scroll toggle in the top bar is an explicit choice, E06); candidates retrieved for that format first, fallback to the other format only when none is eligible (so "Scroll stays Scroll" never exhausts). Files: `contracts/navigation.ts`, `experience/application/navigation-prepare.ts` (`readVerticalCandidates` formats), buffer preparation uses the source's format.
  4. Exploration pool and 10% epsilon unchanged; also seed the pool with at least one candidate per play level when available (5c).
- **After the Final call / recap**: the end tray offers Part 2 (if admitted), Universe, Next topic, and "Done for today" (no next offer pushed). Nothing is auto-advanced. When Part 2 is not yet admitted (`seriesNext` pending/none) the tray falls back to Related, then Next topic.
- **H credit inflation risk.** `activity.v0` gives +1.5 to the *source* of any deliberate series/related continuation (`H`), and V3 makes swiping left possible mid-read, instantly, from anywhere (1.5 > a fully read q of 0.6). A person who swipes through Part 1 -> 2 -> 3 in seconds would raise topic interest by about 4.5 without reading. Recommendation: `activity.v1`: H counts only when the source exposure has `coverage >= 0.5` (or scales with `min(1, q/0.6)`); files `evidence/domain/activity.ts`, `evidence/application/activity.ts`; the policy weights are versioned records so this is a new version, not an edit.
- **Resume**: "Next time you'll start at Part 2" and the Universe resume chip need "latest unfinished thread" = last activated Scroll exposure of a declared series with a next part and no later exposure of that part; a read in Experience (no new evidence). Size M.

### 5c. Interactive-heavy / game-heavy preference per topic

Today the only content-style feature is `format`: `(1+Q)/(2+O)` per **topic x kind (reel|scroll)** (Evidence `topic_context`; Composer `features.format`; 15% of vertical score). V3 makes Scrolls differ a lot in play level, so a third dimension is needed or "format" will blur (a person who loves reading essays vs one who loves calls).

Proposal:
1. Content derives `traits.playLevel` from the stored document: `plain` (v1 docs, editorial, no calls), `stage` (stage, 0-1 calls), `game` (>= 2 calls and a Final call). Stored with the revision (4.2).
2. Evidence keeps Q/O per **(topic, kind, playLevel)** cell; the existing (topic, kind) row becomes the parent (aggregate over levels). Migration adds a column with default `plain` (all current rows are v1 = plain, so history stays true). `PreparedEvidenceInput.topics[].formats[]` gains `level`; `composer/application/snapshot-schema.ts` and `domain/types.ts` follow. Replacement-style updates (same-time delta) are unchanged.
3. Composer `format` feature uses the candidate's cell with **shrinkage to the parent**: `F = (1 + Q_cell + k * F_parent) / (2 + O_cell + k)`, k ~ 2, so a cold cell starts at the topic-kind rate, not 0.5 and not a cliff. Unknown stays neutral. Weighted by topic share as now.
4. "Qualified response" for a game cell stays `q >= 0.6` (reading), not correctness, so a person who plays and gets everything wrong is not penalised and a person who only taps is not rewarded.
5. Habit-forming support without identity claims: a *per-person* routing fit over the last N encounters (share of game-level Scrolls qualified) as a weak prior for cold cells; stored only as counters in Evidence (like Q/O), no label ("gamer") anywhere.
6. Exploration: ensure the pool contains each play level the person has not tried in that topic (the epsilon already exists; extend `explorationPool` construction in `snapshot-assembly.ts`).
Files: `evidence/domain/*`, `evidence/adapters/*` (topic_context migration), `personal-context` read adapter (`read-composer-context.ts`), `composer/domain/{types,features}.ts`, `composer/application/snapshot-schema.ts`, `content` traits.

### 5d. Jev prompt and feature changes

- Bump `JEV_ROLE_VERSION` `jev.1` -> `jev.2` (pool entries made under another role version are not reused by design; `JEV_ASSESSMENT_VERSION`).
- `describe()` (`application/jev.ts`, 700 chars) adds structural, public traits only: kind, play level, reading minutes, `Series: part n of m` and the Scroll's `misconception.claim`. Reason: the PDF itself found that live Part 3 repeats Part 1's distance myth; "redundancy" needs the misconception text to catch two Scrolls that bust the same myth. Instruction line: "Two candidates that correct the same common misconception are redundant."
- Instruction line: candidates in the same series as the current step are not offered (code excludes them), so Jev should not penalise or reward series membership; judge the step as "a new subject".
- **Never** put play outcomes, option choices, sparks or correctness in Jev context (5a). No `format`/`play` criterion in the model: code owns the play-level feature (5c), Jev keeps relevance, appropriateness, redundancy (`JEV_WEIGHTS` 0.4/0.4/0.2 unchanged).
- Cost: D-058 reuse stays (subject = language + primary topic). With vertical now leaving the planet more often, "subject" changes more often -> more Jev calls per hour; the 10-minute refresh wait and the 50% background share bound it; watch `composer.jev_assessments` hit rate on dev.

### 5e. Planner / Quartermaster: producing v2 Scrolls, mix targets, regenerating the library

- Planner (role `planner.personal-planner`, `planner2`) only proposes moves over **existing** inventory or `missing_supply` briefs and Create can only commission a library recipe. So nothing new is generated from personal context unless a recipe exists: **the library plan is the lever** (54 recipes, 6 systems). Add its v2 fields (4.2) and a recipe-level `variant`.
- **Decouple the game from the stage.** The stage needs a kit per topic family (space/earth is natural; ML, computing, history, much of human body are not). Recommended mix target for wave 1-3:
  - **Calls everywhere** (cheap, no kit): every recipe gets a misconception (or `none`) and 2-3 Call its + Final call where a simulation exists; editorial variant otherwise.
  - **Stage only where a kit exists**: Earth & sky and Space first (Seasons x3, Tides x3, Greenhouse x3, stars x2, black holes, exoplanets), human body second (immune/nervous have natural pictures), ML/computing/history later with diagram-style stages or none.
  - Target for the first full pass: >= 20 of 54 stage Scrolls, 30+ with at least one Call it, all 54 with a misconception field decided. Keep a visible mix so the play-level learning (5c) has data in every cell.
- Planner changes: none to its authority rules. Add `playLevel`/`readingMinutes` to inventory items in its frozen context only if it should vary variety (low value); **never** give it play results. `PlannedOpportunity.formats` stays reel|scroll. The planned-demand Create cap `KS_SUPPLY_PLANNER_CREATE_DAILY_CAP` (5/day) is unaffected.
- Quartermaster: Create path unchanged (it enqueues `content.produce-scroll` for a recipe); once the pipeline is v2, every new Create produces a v2 Scroll. Need: `produce-library --only <keys>` waves and an operator report of play-level mix and rejected-answer findings (`reasoning rejected`).
- **Regenerating the library**: see 4.1 (3). Order of work: bump versions; `content produce-library --dry-run --only seasons,seasons-hemispheres,seasons-elsewhere`; run; human review; `content admit-continuity`; `content readmit-coverage`; then `--only` waves. Rerun `production-status` for takes (max 3 per recipe version).
- Reel counterpart: Reels stay Cutroom-made (budget $4); the Reel twin of a regenerated Scroll keeps its `explanationUnitId` (only 3 original recipes share identity), so Q13 (Call it on Reels) is out of scope for now.

### 5f. Ask D1 / D2: context passing and scope inference

- Pass `{exposureId, assetId, revision, anchor}` where `anchor` is the current stop id (D1) or a `scroll_passage` locator (D2, reuse `createPassageLocator`, <= 600 chars). Server validates the anchor against the exact immutable revision (the threads module already does this for snippets) and uses stop/passage text as **private context** for matching and writing; text never enters the shared supply key (supply README rule: "Text and source context remain private").
- Scope inference (4.8): default scope = current topic/facet of the source (already in `encounter_topics`/coverage), overridden only when the matcher says the text clearly names another catalogue topic. The matcher gets the current topic in its prompt (extend `match-role.ts`); code still validates exact catalogue members.
- Format inference: Reel production does not exist for asks, so "A short Scroll" is the only honest option today; show the editable line but disable Reel. When Reel asks exist, the default comes from Evidence format fit (`F(topic, scroll)` vs `F(topic, reel)`), the same read Composer uses (`READ_COMPOSER_CONTEXT`).
- An ask is **not** evidence; a produced answer is a normal Scroll that creates evidence only when read (AGENTS: "Suggestions, generated supply... never do").
- Quick answers are not encounters, write no evidence, never reach Personal Context/Cartographer (PDF: "never feed them into the universe"), are labelled, and (if built) are worker jobs, not HTTP-path model calls.

### 5g. New events the Composer must consume

| Event | Consumer | Why |
|---|---|---|
| `NavigationIntent` vertical `format` | Experience navigation -> Composer snapshot | Next topic remembers the format |
| Source series membership (all part ids) | Composer snapshot (`exclusionsOf`) | `same_series` exclusion |
| Candidate `traits` (play level, calls, reading minutes) | Composer features, Jev context | 5c, 5d |
| Evidence Q/O per (topic, kind, level) | Personal Context -> Composer | 5c |
| H credit with source coverage | Evidence activity v1 | 5b |
| Nothing from `play` (calls, sparks, landmarks) | none | By rule (5a) |
| Challenge received / opened | none (opening an exposure is a normal encounter) | Shared messages never create evidence |

Composer decision snapshots grow by candidate `traits`; keep under the 192 KB input budget (`SNAPSHOT_BYTE_BUDGET` 180,000 in `snapshot-assembly.ts`).

Files that change for section 5, in one list:
`composer/application/{compose.ts,snapshot-assembly.ts,snapshot-schema.ts,jev.ts,vertical-candidates.ts,prepare-buffer.ts}`, `composer/domain/{policy.ts,features.ts,types.ts,plan.ts}`, `experience/application/navigation-prepare.ts`, `contracts/{navigation,supply}.ts`, `evidence/domain/{activity,policy,qualification}.ts`, `evidence/adapters/*` (+ migration), `personal-context/application/read-composer-context.ts`, `content/{domain/library/*,domain/reading-facts.ts,domain/coverage.ts,domain/recipe-coverage.ts,adapters/discovery-store.ts,production/writer.ts}`, `supply/application/match-role.ts`, `planner/adapters/nest-providers.ts` (capabilities literal), `scroll-model/*`.

---

## 6. Blueprint / AGENTS / decision conflicts and owner questions

Each row: the rule on dev, what V3 does, recommended answer.

| # | Rule on dev (source) | V3 | Recommended answer |
|---|---|---|---|
| 1 | AGENTS.md "Consumer UI never shows internal prompts, model reasoning, **scores**, sources panels or operational machinery" | Sparks, combo, "3 calls", Final call, gold tier | Amend wording to "internal ranking, model or evidence scores". Sparks/combos/landmarks are product features of the play layer. Record as a new decision (D-060). The word "score" in the UI stays out of any ranking context |
| 2 | E08 / D-040 "titles only, no counts, minutes, 'you learned' or progress meters"; `encounter-ending.tsx` thread rows "no counts, no grades"; E07 same | Spine progress, "4 of 10", "3 min · 3 calls", sparks, Orbit 2 of 3 days | Owner's ruling covers Scrolls: allowed. Keep "you learned" / "you now know" / mastery wording prohibited; "Called it" is about the call. Reels and the E07 "nothing more ready" card stay plain |
| 3 | Blueprint §18 gesture state machine: `Boundary -> SubjectNavigate: fresh deliberate gesture or Next control`; "Vertical reading must not emit a next-subject command"; E02/scroll-end: "momentum never reaches these buttons"; user note "never auto-advance" | "Keep pulling up for the next topic", pull-up meter, top Next up always | **No conflict if implemented as the blueprint says.** A fresh drag that starts at the end, a visible meter, release to confirm; momentum from reading never counts; mid-read vertical is reading; web needs its own verified boundary detector (§18 parity matrix). "Never auto-advance" still holds: nothing moves without a deliberate gesture or key; "Done for today" is a first-class end |
| 4 | D-040: "A Scroll has no edge tab ... Blocks own horizontal drags there" (blueprint §18 itself allows `ThreadNavigate: horizontal movement on an ordinary surface`) | Swipe-left continues in Scrolls at any point | Supersede D-040 for Scrolls. Rule: swipe-left/right continue/back only from text/stop surfaces; the stage and any block with `gesture != none` (slider, code, wide table, sort) own their drags; native edge zones stay platform Back; every swipe has a button and key |
| 5 | D-012 / contracts "payloads carry block ids and numbers only, never a simulation parameter value" | `call.lock{stopId, option}` carries the chosen option | Keep observations value-free. The call is a **command** to `play`, not an observation; Evidence only sees "locked" |
| 6 | Blueprint §1 "does not score learning or announce what a person supposedly believes"; line 1257 "No topic scores or mastery levels"; AGENTS "behaviour is evidence, not proof of learning" | Called it / Plot twist, gold on first try, `common_guess` | Allowed as play, with hard walls (5a): correctness and options never leave `play`, never reach Jev/Planner/Composer/Evidence/Cartographer, never aggregated per topic. **Owner to confirm** that a per-Scroll gold/plain landmark is a trophy and not a "mastery level" under line 1257 |
| 7 | AGENTS "Planet formation needs qualified evidence and conceptual variety"; blueprint "No attendance streak required for growth" | Q7 leaning: play does not influence formation; weekly Orbit | Adopt Q7 as a decision. Orbit never required for anything; it is a ring in the Universe, no loss, resets Monday, never taken away |
| 8 | D-057 "No push, streak or 'you missed' setting exists because no such message exists" | PDF: only "your Scroll is ready" or a friend's challenge push | Keep: no loss pushes. "Ready" notices already exist in-app; a push channel does not exist yet. Defer pushes; do not add a streak setting |
| 9 | D-059 "Series total is not invented" (context has part number only) | "SEASONS · PART 1/3", "1 of 3" | Add `series.total` derived from `series_units` (a count of admitted parts, not invented) to the continuation metadata; hide the total when the series is not admitted whole (admit-continuity already admits series whole or not at all) |
| 10 | D-032 writer rules: "never name the source or its publisher", every number needs a cited passage, 9-word copy ban, one call + one repair | `misconception.source: "A Private Universe (1987)"` shown to the reader; kit params like tilt 23.4; 3-6 min | Sources of misconceptions are **recipe data set by code** (human-reviewed), not model text; kit parameters are validated against kit bounds, not evidence; all reader-facing digits still need citations; calls' answers/explanations are claims and must cite. Reading estimate 230 wpm + 10 s per call means `scroll-measures.v2` |
| 11 | AGENTS "Models propose; deterministic code validates" / "Calls run only in workers or operator commands, never in the client, an HTTP handler" / blueprint "no model call on the HTTP navigation path" | D2 inline Quick answer and Simpler "in place" at read time | Recommend: **Simpler = authored at production** (instant, free, checked), Ask about a sentence = D1 request path. A live Quick answer needs an explicit exception or a worker job with polling; defer. Never label model text as a checked Scroll (PDF agrees) |
| 12 | AGENTS Providers: Cutroom/fal $4 budget for Reels only; Scroll pipeline has no image generation | PDF: generated backdrops/illustrations/teaser art "we already generate images for Reels" | Do not add image generation in the first slices (no provider path, no budget rule for Scrolls). Kit only. Optional later with its own money rule |
| 13 | Blueprint §1: Reel and Scroll equal status | V3 pushes Scroll game; Q13 Call it on Reels later | Keep equal in ranking (play-level cell is per-person routing, no global Scroll boost). Same two top-bar buttons on Reels (Q16, small) |
| 14 | `Pause recording` (D-057, Identity recording scope): nothing grows while paused | Calls, sparks, landmarks are stored data | Recommend: while recording is paused, play works on-device and writes nothing server-side, with an honest line; landmarks are not earned retroactively. **Owner to confirm** (alternative: play data is app data like Keep and survives Pause) |
| 15 | Clear exploration / account deletion / export (D-043, D-050) | New personal tables | Must declare `play` in `src/erasure-registry.ts` (Clear = erase because the Universe is wiped; export = include). `checkErasureInventory` fails CI until done |
| 16 | Blueprint §12 / geography: "a unit is a canonical explanationUnitId"; Part 3 repeats Part 1's myth | Q12: Part 3 becomes "Seasons elsewhere" | Yes. Add a new recipe and facet (4.2) instead of rewriting `seasons-limits`, whose facet meaning is pinned in coverage; series revision changes |
| 17 | Planner "never adds content"; Create = library recipes only; context-bearing ask = unsupported | D1 "a short Scroll about this question" | Needs the new **ask order** path (4.8); this is the largest backend item in Ask. Alternatively ship D1 with "Ask for more on Seasons" mapped to existing facets first (reuse) and add ask orders in a later slice |
| 18 | Social: peer positions private; shared messages never create evidence | Challenge a friend; hidden answers | Threads only (Q11). A challenge is an invitation; opening it is an ordinary encounter. Sender's result is revealed to the friend only after the friend locks their own call. No leaderboard |
| 19 | scroll-limits.v1 "max 8 interactive blocks" | Budget <= 1 stage, <= 4 calls, <= 2 other interactives | New `scroll-limits.v2`; v1 limits untouched |

**Owner questions that block the build** (with my recommended answer; the PDF's own 16 are in 3.8):
1. Is `play` data erased by Clear exploration and not saved while recording is paused? Recommended yes / yes.
2. Where does a landmark go before its planet forms? Recommended: a collection tray plus the planet when it forms.
3. Is calls-everywhere (cheap) plus stage-where-a-kit-exists the right mix, rather than a stage for all 54? Recommended yes.
4. Weekly Orbit week boundary: Monday in the device's timezone? (PDF: "start fresh on Monday") Recommended: device-local ISO week, computed at read, no stored streak.
5. Is the first-try gold tier allowed as a per-Scroll trophy? (row 6)
6. Is the live Quick answer in or out of the first release? Recommended out (authored Simpler instead).
7. Reading time 3-6 min and 230 wpm: confirm (today 2-8 min at 200 wpm in `compile.ts`/`measures.ts`).

---

## 7. Suggested slices (each ends in something a person can use on dev)

Rules from AGENTS.md apply: issue first, one vertical slice per branch from `codex/release-knowscroll-v2`, PR under ~2,500 non-test lines, real provider calls when the slice needs them, promote to dev, then exercise on `app.dev.knowscroll.space` with disposable accounts. Model: `MiniMax-M3.1-Flash`; check the response `model` field (D-031); workers/operator only; watch the 5-hour window.

**Slice 0: decisions and a writer spike (S-M, before any engine).**
- Write D-060 (play layer, scores wording, supersede D-040 for Scroll swipe, `play` module and walls from 5a) and amend AGENTS.md "scores"; get owner answers to section 6 questions.
- Spike (scratch operator harness, not product code): draft `scroll-authoring.v2` (flat stops, kit enums) and run it on 20 topics with real MiniMax, as the PDF asks ("run 20 topics through it before building engines"). Measure: first-take acceptance, repair rate, reading minutes, tokens (thinking included), `reasoning rejected` finding mix.
- Acceptance: >= 70% accepted within the two-request bound (writer + one repair) on stage topics; misconception and Plot-twist text reviewed by a human for 6 samples; token cost per Scroll known so the library wave can be sized.

**Slice 1: Stage + Spine reader with stops and a static stage, Seasons only (L).**
- Modules: `scroll-model` (v2 document: stop, line, aside, stage, recap, heading, paragraph; limits v2; measures v2; negotiation with both schemas), `content` (v2 parse/render paths, coverage rule v2, reading facts, traits, `seasons-elsewhere` recipe, series total), `content/production` (writer v14, v2 authoring, validators), `ui/scroll` (stage engine v0, kit v0: Sun, Earth, orbit, pins; spine, dock, top bar with Universe and Next up), `apps/client` (Scroll gestures: swipe-left/right between Parts; pull-up meter; end tray with Part 2 peek), `composer` (minimum: `same_series` exclusion and format-sticky vertical, so Next up is a new topic), `experience`/contracts (vertical `format`, `series.total`, `teaser`).
- Acceptance: on dev a person opens Seasons Part 1 (regenerated), sees the pinned picture change as they scroll and the dot move; taps a dot; swipes left to Part 2 (stage carries over); pulls up past the end and lands on a different topic in the same format; keyboard/screen-reader paths work; reduced motion cross-fades. Reading the whole Part 1 qualifies (q >= 0.6) and the Seasons planet still forms after 3 units (coverage v2). Old v1 Scrolls still open.
- Real generation: `content produce-library --only seasons,seasons-hemispheres,seasons-elsewhere` with `KS_REASONING_PRODUCTION_ENABLED=1` and the production scope enabled; inspect with `content production-status`, `reasoning rejected` for findings; then `content admit-continuity` and `content readmit-coverage`. Human review notes for accuracy, misconception, reading time.
- Verification checks: unit tests for v2 validation (budget, stop words, limits aside not last), property test "tap every dot" does not qualify, gallery/e2e fixture for the stage at 320/360/390 px and desktop, axe in CI, Android emulator journey, `pnpm boundaries:probe` for the new client-safe imports.

**Slice 2: Call it, Plot twist, sparks, haptics, `play` module (M-L).**
- Modules: `scroll-model` (`call_it`, interaction kinds, BlockState), `ui/scroll` (call view, game runtime v0, haptics shim; `expo-haptics`), `play` (new: tables `play.calls`, `play.scroll_results`; command `call.lock` with server-side correctness; erasure, export), `contracts/play.ts`, `client-core` play session, `evidence` (accept the new interaction kinds), `content/production` (writer produces misconception + calls, `common_guess.source` from recipe).
- Acceptance: Seasons Part 1 shows Call it #1; a wrong pick shows "Plot twist!" with the sourced common guess, a right pick "Called it!" +1 spark; the dock shows sparks; reload keeps results; with recording paused nothing is saved and the UI says so; Clear and export include/erase play rows; nothing in Evidence activity changes with correctness (test: same q with right vs wrong).
- Verification: integration tests against real PostgreSQL (idempotent command, forged option refused, wrong exposure refused, erasure inventory), real MiniMax regeneration of the three Seasons parts with calls, review of Plot-twist wording.

**Slice 3: Final call, gold landmark, payoff ending (M-L).**
- Modules: `scroll-model` (`final_call`, simulation sin/cos/clamp, `bind_stage`, `scale` if Ray's footprint needs it), kit (Ray, thermometer), `ui/scroll` (recap, payoff end tray, E1 layout, "Done for today"), `play` (landmarks, tier, results), Seasons recipes get `landmark` + final-call binding.
- Acceptance: finishing Part 1 shows the recap picture, sparks, combo, a gold or plain landmark ("The Leaning Axis"), Part 2 peeking and "Done for today" with equal weight; no auto-advance; Small print chip opens the limits aside.
- Verification: simulation grid proofs for sin/cos, real generation of all three Seasons parts, device check of stage height at 320-360 px.

**Slice 4: Universe collection (M).**
- Modules: `play` read API (landmarks, orbit week, finished counts), `scene-core` drawables (landmark, orbit ring, clouds), `apps/client/features/universe` (landmark tray and list view, planet landmarks, Orbit ring, clear skies, resume chip), `experience` (latest unfinished thread read).
- Acceptance: after finishing Seasons Part 1 the Universe shows the landmark (waiting if the planet has not formed), Orbit "1 of 3 days", clouds thin by finished count; a missed week removes nothing; formation is unchanged by play (test: two accounts, same reading, different calls, same planets).
- Verification: two disposable accounts on dev; screenshots at phone and desktop widths; reduced motion shows landed states.

**Slice 5: Personal algorithm v1 (M-L).**
- Modules: `composer` (policy v1: vertical Intent weight and recent-topic penalty after offline replay of stored decisions; traits; play-level format cells with shrinkage; exploration per level), `evidence` (`activity.v1` H credit rule; topic_context level column + migration), `personal-context` read, `composer/application/jev.ts` (`jev.2`), `content` traits.
- Acceptance: replay report on stored dev decisions shows fewer same-planet next topics and the same-series exclusion; with two accounts that complete game-level vs plain Scrolls the Format feature diverges per topic only after enough measured encounters; Jev calls per hour stay under the D-058 bound; no code path reads `play` correctness (dependency-cruiser rule).
- Verification: pure/property tests for the new equations (bounded [0,1], replayable decision hash), real-PostgreSQL integration for the migration, one real Jev run with `jev.2` (check `model` field), CI `checks` green.

**Slice 6: Library regeneration in waves (L, mostly operations).**
- Recipes get misconception/variant/landmark fields; waves: Earth and Space (13+), Human body (6), then Computing, ML, History with calls and editorial variants; `SCROLL_PRODUCTION_VERSION` v15, `WRITER_PROMPT_VERSION` v14; `produce-library --only <wave>`; `admit-continuity`; `readmit-coverage`.
- Acceptance: >= 20 stage Scrolls and 30+ Scrolls with calls published; every series admitted whole; each wave has human review notes; mix report by play level.
- Verification: `production-status` shows no `stopped` recipes; `reasoning rejected` top findings tracked; yield and token spend recorded in #222.

**Slice 7: Ask from here (D1) with ask orders (M-L).**
- Modules: `contracts/supply.ts` (anchor), `supply` (scope inference, ask orders with caps and ledger), `content/production` (`question` writer mode, `ask_suggestions`), `apps/client/features/requests` (new sheet: three suggested questions, one editable line, honest wait with typical time, 20-second puzzle).
- Acceptance: from stop 5 a person taps a suggested question, sees "Making it now" and a real typical time (or none), plays the puzzle, and later gets a ready notice that opens a short Scroll about exactly that question; the Scroll is not offered to anyone else; caps return an honest unavailable.
- Verification: real MiniMax run of 5 ask orders (accuracy, length 1-1.5 min), cap tests, retry path (`could_not_prepare`), E07 states.

**Slice 8: More blocks and kit (M-L).** `sort`, `fork`, `scene`, `guide`, `scale`, chart `grows_with`, kit extension (landmarks, people, thermometers, map-lite). Acceptance: one Scroll per block on dev; budgets enforced (<= 4 calls, <= 2 other interactives).

**Slice 9: Social and extras (M-L).** Challenge a friend in threads (`scroll_call` snippet, hidden-until-called), authored Simpler, selection-menu Ask, optional D3 wager, Reels top-bar Universe and Next up (Q16). Later: Call it on Reels (Q13), live Quick answer (worker job), pushes.

### Cross-cutting checks for every slice
- Keep v1 Scrolls working until the last wave publishes; both schemas advertised; `renderableFormats` and `canRender` accept both.
- Observation payloads stay value-free; correctness only in `play`; dependency-cruiser rule forbids composer/planner/evidence/personal-context/geography from importing `play`.
- Erasure: `play` declared in `src/erasure-registry.ts`; export covered; `checkErasureInventory` green.
- Update `docs/STATUS.md` and the #222 table at phase end (coordinator only); the module READMEs (`scroll-model`, `content/production`, `composer`, `evidence`, new `play`) with planned/implemented/runtime-verified marks.
- Reduced motion, keyboard map, text version for every new block; axe in CI; VoiceOver/TalkBack still unverified (handover known gap).

### Biggest risks
1. **Writer reliability** on stage states and calls (D-032: nested JSON failed ~12 times; flat shape is the mitigation). Do the spike first.
2. **Coverage and formation**: forgetting coverage v2 silently stops planets forming from regenerated Scrolls.
3. **Stage engine scope** (the PDF's "biggest build"): ship Seasons, then generalise; do not promise kits for all systems.
4. **Same-planet bias in Next topic** will fight the new grammar unless Composer policy v1 lands with Slice 1.
5. **H credit inflation** from instant swipe-left.
6. **Ask orders** are a new production path with its own caps; keep out of Slice 1-4.
