# Scroll production

Writer roles belong to content (blueprint §§11, 15). `production/` owns the evidence packaging, the
writer's instructions and checks, the job state and the application of a result.
`infrastructure/research` owns the public HTTP boundary, and the shared reasoning engine keeps
transport, admission and the external attempt ledger.

A `runtime-verified` mark that names a day and a run folder (`journeys-v3`, `dev-check-N`, `fidelity-v3`, `room-journey`, `mod-steps`) was seen on dev on that day. The folders are on the coordinator's machine, not in the repository; `docs/v2/design/fidelity-v3.md` records what the screens looked like.

## Follow a production job

The library operator or Supply commissions a recipe/take. The worker's
[production consumers](../../../../../../apps/worker/src/production-jobs.ts) run only when its
production switch is enabled. [produce.ts](produce.ts) freezes public research, executes the
writer and checks through the reasoning ledger, then stores an admitted result under the
production root. A library result is held until explicit review releases it.

A repeated delivery resumes the same frozen job. A rejected take can permit a later take;
an unknown paid attempt cannot be resent. Public research and model calls happen outside
transactions. Publication, attribution and coverage commit together; a failed commit cannot
publish only part of that state. The operator and worker share this use case.

Run `pnpm --filter @knowscroll/backend exec vitest run src/modules/content/production` from the
root. Hosted integration and installed-release fixtures exercise the database and consumer graph.
Historical real-model observations are recorded separately in Status; this guide is not a new
provider run or deployment check.

## A v2 Scroll is no longer produced (#815, D-442)

Nothing produces a `scroll-document.v2` Scroll. The v2 writer (`writer-v2.ts`), its stored compile (`stored-v2.ts`), the `v2Plan` of `writer-plan.ts`, the operator's v2 spike (`spike-v2/`, `content writer-spike-v2`) and the plan fields `scrollV2`, `stageKit` and `stagePlan` are deleted. Every library recipe is a document v3 recipe (below); a Scroll ordered from code is still v1 (`made-to-order`; the v1 writer goes in a later change).

What stays, because stage and main still store and serve the v2 Scrolls the writer made: `WRITER_V2_PROMPT_VERSION` (`writer-v2-version.ts`) and `SCROLL_PRODUCTION_V2_VERSION`, which the publication lineage and the stored provenance of those revisions name, and `PRODUCTION_VERSIONS`, which still lists the version so the job rows of that time stay readable. Everything that reads a stored v2 revision stays: the review gate, the release policy, reading facts, coverage, and `answerChecksOf`, which reads the receipts the old job recorded. The tests of that reading side start from a stored v2 revision (`orrin.fixture.ts`, `storedOrrinV2`, a committed snapshot of what the writer stored; `tests/integration/support/stored-v2.ts` writes it through the production admission, attribution and coverage code), never from a writer.

## Producing a document v3 Scroll (#772, #783)

Status: **implemented**, covered by unit tests and by an integration test on real PostgreSQL with a labelled fixture model (`tests/integration/modules/writer-v3-publication.test.ts`). **Not runtime-verified**: no real MiniMax call has been made through the job. The v3 writer is in the production job, arm (a) only: the whole Scroll in one reply. Since #787 the 22 recipes that had a drawing kit are marked `scrollV3` (and have no kit and no v2 plan), and since #790 so is every other recipe of the library: the 32 plain v2 recipes and the v1 recipe `exoplanet-kinds`. So **no library recipe is v1 or v2 now**, and each is produced this way once an operator runs `produce-library` for it, kit by kit and then system by system (runbook: "The kit recipes as document v3 Scrolls, kit by kit" and "The other 33 recipes as document v3 Scrolls, by system"). Supply's choice of a recipe skips every code recipe that carries `scrollV2` or `scrollV3` (`chooseScrollRecipe`, `production-state.ts`), so only a stored recipe is ever commissioned by supply (`exoplanet-kinds`, a v1 recipe, was the last code recipe supply could commission, until #790). Marking changes nothing a reader is served: the recipe's v1 or v2 revision keeps serving until a v3 revision is released, and `plannedDocumentVersionOf` makes the recipe `not_started` until then, so its first v3 take is offered. A person decides which recipes are marked (the plan's decision, per recipe, #771).

A recipe the library plan marks `scrollV3` (`ScrollV3Plan`: shape, section intents, pictures by kind and purpose, misconception) is produced by the job, take and ledger every recipe uses, with the document v3 writer.

- **The writer plan** (`writer-plan.ts`, `v3Plan`). The role is `writerRoleV3One` (`content.scroll-writer`, `scroll-writer-v3a.v4`, `writer-v3.ts`): one request, and the harness's repair that carries the refused answer, and a second repair when the first repair's findings are all copies (`secondRepairOnlyFor`, D-445). The context is `writerContextV3`: the recipe's asset and explanation unit, the job's real target revision, the library kicker (`A closer look`, the same as a v2 library Scroll's), theme `worlds`, factual framing, and the plan's shape and misconception. `prepare` returns the answer as it is. A subject that is not a library recipe (a code recipe or a stored `gen-…` key, the keys `parseProductionRecipe` accepts) is refused before any request with `SCROLL_V3_REQUIRES_LIBRARY_RECIPE`, as `SCROLL_V2_REQUIRES_LIBRARY_RECIPE` does for v2: a Scroll ordered from code is never written as a document v3 (#784).
- **The compile** (`stored-v3.ts`, `storedScrollV3`). `compileGeneratedScrollV3` (every check of the producer, in the strict figure mode, and the writer's own: no source or publisher names, the citation bound of `scroll-provenance.v3`) with the production record `{kind: 'model', runId, attemptIds, model, promptVersion}`. Then the document is written out as the exact stored bytes and admitted again with `validateDocumentV3` (any notice refuses), and the provenance is parsed with `ScrollProvenanceV3`. A refusal carries codes and paths at the model's own items (`items.4.show`), never text, and the one repair can fix it.
- **Two version strings.** The role's own version, `scroll-writer-v3a.v4` (`.v3` until D-445, `.v2` until D-444, `.v1` until D-441), names the arm in the attempt ledger and the contract of its instructions, fixed hints and schema, so it moves when those change (D-441 changed the instructions and the `copied_passage` hint, D-444 the instructions and the `authoring_number_not_in_evidence` hint, D-445 the instructions and added the second repair; D-438 changed neither and left it); the attempts of a take are told apart by the run's policy version and the attempt's prompt version. The **prompt version** in the stored provenance, and in the plan, is `WRITER_V3_PROMPT_VERSION` (`scroll-writer-v3.v5`, `writer-v3-version.ts`): the value the publication lineage (`storedLineage`) requires of a stored v3 revision, and the one `versions.test.ts` pairs with the production version, so a new writer cannot reuse the old writer's takes. A stored value that differed from it would publish the Scroll without its topic attribution and coverage (`attribution_unverified`).
- **Hold.** `isHeldForReview` and `hasAnswerCheck` (`review-hold.ts`) hold a v3-planned library recipe, so it is never published unread. A document v3 has no calls: the job's answer check is recorded as passed with no request (`callsOfStoredDocument` reads only a v2 document, so a v3 has none), and the release policy reads that record.
- **Versions and bound.** A v3 recipe's jobs are `scroll-production-v3.v5` (`SCROLL_PRODUCTION_V3_VERSION`, in `PRODUCTION_VERSIONS`; `scroll-production-v3.v1` is `SCROLL_PRODUCTION_V3_FIRST_VERSION`, `.v2` is `SCROLL_PRODUCTION_V3_SECOND_VERSION`, `.v3` is `SCROLL_PRODUCTION_V3_THIRD_VERSION` and `.v4` is `SCROLL_PRODUCTION_V3_FOURTH_VERSION`, kept for the revisions they wrote and never made again), paired with `WRITER_V3_PROMPT_VERSION`. `scrollV3PlanOf` reads the plan from a code recipe; a stored (`gen-`) recipe is a document v3 recipe and gets a key-only marker plan for the version and bound rules (see "Stored recipes", #781), while its real shape and sections reach the writer from the stored row (`bookRecipeOf` → `librarySubject` → `subject.scrollV3`). A take sends at most three requests (the writer, its repair and the second repair for copies; `REQUEST_BOUND_V3_WRITER`, D-445); `REQUEST_BOUND_V3_PER_TOPIC` stays at a v2 take's six, an upper bound the queue's claim (2,100 s) already covers, and `versions.test.ts` pins that three requests fit it.
- **After the job.** The delivery that held the Scroll sends its support check at once, under the version that reads a document v3 (`checkerVersionOfRecipe`); the sweep finds any it missed. The check (below) and the release policy then decide whether a person is needed. A v3 that would replace a served v1 or v2 is released by the policy when every check passes, and its release retires the earlier revision; a v3 over a served v3 is held for a person (`replaces_served`).
- **A link the compile cannot place is left out (D-438, `scroll-production-v3.v2`).** `compileWrittenV3` drops a link whose phrase is not in its paragraph exactly once, that overlaps a link kept before it, that has no picture on screen or whose label is not a part of that picture, and returns each as a notice; `validateDocumentV3` is unchanged and still refuses a document with such a link. So a reply whose only fault was such a link is accepted by the harness at the first write, with no repair (the one repair a take has is kept for every other finding), and `storedScrollV3` stores the document without it. `CompileOutcome` carries the notices (`notices`, absent when none), and the writer stage records the count as a receipt `{role: 'checks', kind: 'links_dropped', dropped: n}` in the job's `outcomes`, only when `n` is at least 1, never a phrase or a part. Why: on dev, 6 of the first 20 takes (one write and one repair each) failed after their repair, 4 of them still on `link_phrase_not_once`, 1 on `link_without_picture` and 3 on `copied_passage`; a link is optional and the reader already leaves out a phrase it cannot find, so refusing a Scroll, and spending one of a recipe's three takes, for it was the wrong trade. The version moved because the writer now accepts replies it refused: by D-197 every recipe gets three new takes at `.v2`, and a recipe whose served Scroll is already a document v3 is still skipped by `produce-library` (it reads as `published`). The writer's instructions did not change: they never said a misplaced link refuses the Scroll.
- **A copy says where and what, and a chart is told it has marks (D-441, `scroll-production-v3.v3`).** Measured on the 91 refused attempts of 61 takes on dev (24 Nov, `scroll-production-v3.v2`): `copied_passage` was on 19 of 61 first writes and on 15 of the 30 repairs, 15 repairs in all that ended a take on it. In 11 of those 15 the first write was refused for something else (7 for its shape, 3 not one JSON object, 1 truncated), so the copy rule never ran on it and the repair was not told of any copy; where the reply could be read, the repair kept the copying paragraph word for word in 6 of 7. In the 4 that were told, 7 of the 10 copied items were the same item again. The harness's repair catalogue is static (one fixed hint of at most 256 characters per code, never built from a draft or a context), so the copy's part and words cannot ride on the finding there. They go where source-derived facts already go, the repair notes (`<repair-notes>`, at most `MAX_REPAIR_NOTES_CHARS`): `compileWrittenV3` gives a `copied_passage` a `detail` that names the part (`text`, `simpler text`, `caption`, `step 2 label`, `cell 3 text`, …) and quotes the first two runs (four since D-444), each at most 15 words, in the research's own words; `copyRepairNotesV3` writes one line `items[11]: <detail>` for each place, drops whole lines from the end to fit and names the places it has no room for; `REPAIR_HINTS_V3.copied_passage` points to the notes. A reply the shape refused first (a field too long, a chart without `marks`) is read with the same rule over whatever strings it holds (`looseCopyIssuesV3`), so the repair is told. The stored refusal keeps the code and the path only (`asIssues`). A chart was written without `marks` in 19 of the 34 charts in those answers, and 12 refused attempts (11 first writes, 1 repair) had `missing` at a chart's `marks` as their only reported fault (the charts had `form`, `unit`, `values` and `points`, never `marks`): the shape lists it as required, but the reference said only "at most 3 marks", which reads as optional; the reference and the picture instructions now say a chart always has `marks`, `[]` when no point needs a label. The three role versions moved to `.v2` with the new prompt and hints, the production version to `.v3` (three new takes for every recipe not yet a document v3; one repair a take stays; no other check changed). Not-one-JSON replies are refused as before: none had a fence or prose, and the harness already takes one fenced object and trims whitespace and a BOM.
- **A figure says where it is, and a picture's words are the writer's own (D-444, `scroll-production-v3.v4`).** Measured on the 14 attempts of `scroll-production-v3.v3` on dev (24 Nov) and the 3 repairs of `.v2` that carry the code: all 9 attempts with `authoring_number_not_in_evidence` are `industrial-towns`, and in every one the part cites the passage that holds the figure (`e11`, "17% in 1801 to 54% in 1891"); the rule reads "1801 to 54" as a range, so the chart's label "1801" and value "54" and the same figures in a paragraph are each one end of a range the part does not give whole (25 of 27 findings; 1 miscited, 0 absent, 1 unit word, "percent" for "%", which a repair changed from a right unit because the fixed hint does not say value or unit). Like the copy detail, the figure finding (`numberDetailOfTexts`, `numberDetailOfValue`, `numberDetailOfUnit`, `producer/v3/number-detail.ts`) carries a `detail` for the repair notes: the part, the figure as written, and the passage ids to cite when an offered passage the part does not cite states it (`cite e3`), how a cited passage writes it when it has the digits another way (one end of a range, with the research's words around it; a magnitude word; a form a figure cannot take), or that it is in no offered passage. `looseNumberIssuesV3` reads a reply the shape refused first. `repairNotesV3` (`repair-notes-v3.ts`) writes the copies and the figures into one notes block within `MAX_REPAIR_NOTES_CHARS`; `copyRepairNotesV3` is its no-figure case. A copy note lists up to four runs of a place (was two; the lever the brief suggested, not one the records show would have helped), a picture's labels, notes, captions and cells are told to be the writer's own words (3 of 9 repair places of a copy were in a picture), and "keep exact figures" no longer keeps the passage's words around them (9 of 11 copied runs in the repairs held a mass multiple of the passage). The three role versions moved to `.v3`, the prompt to `scroll-writer-v3.v4`, the production version to `scroll-production-v3.v4` (three new takes for every recipe not yet a document v3; one repair a take stays); revisions written at `.v1`, `.v2` and `.v3` keep their lineage. The figure rule itself is unchanged; the plan's second chart of `industrial-towns` (a line of 17 in 1801 and 54 in 1891) could not pass it and is dropped from the plan (D-444).
- **A second repair when copies are all that is left (D-445, `scroll-production-v3.v5`).**
  - **Measured on dev** (25 Nov, all versions): of 50 repairs that ended a take, 17 ended on `copied_passage` alone. Of the 27 copies left, 16 were at places the notes quoted, 4 at places they never named, 7 at places the first write's stored findings do not name. In `black-hole-formation` take 3 the repair rewrote two paragraphs it was not told about into two new nine-word copies.
  - **The change.** The three roles name `secondRepairOnlyFor: ['copied_passage']` (`SECOND_REPAIR_CODES_V3`). When the first repair's answer is invalid and every finding is a copy, the harness runs one more repair: step `repair2`, its own reservation and receipt, caused by the first repair, carrying the first repair's answer and the notes built from it. Three requests a take at most, one more than before. A mixed, cut (`more`), unknown or failed first repair gets none; every other finding keeps its one repair. The reasoning README has the rule.
  - **Changes only what is named.** The notes' header (`CHANGE_ONLY_NAMED`, short because both blocks share `MAX_REPAIR_NOTES_CHARS`) and the instructions' `REPAIRS.` rule say a repair changes only the parts the notes name and returns all else exactly as it was. The copy rule (nine words, what matches) is unchanged. The stager has no notes, so its second repair carries the answer and the findings.
  - **Where the third attempt shows.** `writer-stage.ts` accepts up to `REQUEST_BOUND_V3_WRITER` paid attempts; `ProductionRecord.attemptIds` names up to three; `matchesWriterAttempts` accepts `primary`, `repair`, `repair2` in order.
  - **The claim is unchanged.** A library take's bound is still six, so `PRODUCE_SCROLL_CLAIM_SECONDS` stays 2,100 s. The writer's three requests need 3 x 320 s + 180 s = 1,140 s of it, and `versions.test.ts` pins that they fit.
  - **Versions.** Roles `.v4`, prompt `scroll-writer-v3.v5`, production `scroll-production-v3.v5`: three new takes for every recipe not yet a document v3. Revisions written at `.v1` to `.v4` keep their lineage.
- **Lineage.** `storedLineage` (`publication-topic.ts`) has a `scroll-document.v3` branch (`parseDocumentV3`, `ScrollProvenanceV3`, the pairs of `lineagePairsOf`: `scroll-production-v3.v5` with `WRITER_V3_PROMPT_VERSION`, and, for a document v3 of a recipe the plan marks `scrollV3`, the earlier pairs `scroll-production-v3.v1` with `scroll-writer-v3.v1`, `.v2` with `scroll-writer-v3.v2`, `.v3` with `scroll-writer-v3.v3` and `.v4` with `scroll-writer-v3.v4` (never mixed), so a revision written before D-438, D-441, D-444 or D-445 keeps passing it; the lineage is only asked for the job that just closed, so no stored revision is re-read by it today), so a v3 revision gets its topic attribution and its coverage head in the publication transaction. `matchesWriterAttempts` accepts one writer run with at most three sent attempts, in order: `primary`, `repair`, `repair2` (D-445; a stored revision of an earlier version has two at most, so it passes as before), and the provenance's `production.attemptIds` (`scroll-model`, `ProductionRecord`) names up to three.
- **Citation bound.** `citationLimitIssuesV3` holds a v3 to `PROVENANCE_V3_LIMITS` (48 passages, 24 pages, 22 parts that cite), with the same finding `citations_too_many` and its own hint (`CITATIONS_TOO_MANY_HINT_V3`).
- **Standing.** A v3-planned recipe counts as published only while its current revision is a document v3 (`plannedDocumentVersionOf`), and a new take may follow a published one, as for v2.
- **Figures with a minus sign.** Research pages write a negative number with the Unicode minus ("−70 mV"). The figure rules (`unstatedFigures`, `pointAgrees`, `producer/figures.ts` in scroll-model) read a hyphen-minus, U+2212, U+2012 and U+2013 before a digit as the same sign, and a chart value written `-70` is found where a passage writes "−70". A dash between two figures is still a range.
- **Not done:** arm (b) (prose, then staging), which needs a second run on the job.

## The answer check and regeneration (S-6a, D-197, D-198)

Status: **implemented**, runtime-verified with the labelled CI fixture model on real PostgreSQL. **Planned:** the first
measurement on real MiniMax, which the coordinator makes on dev when the first wave runs (the check's reply shape and how often it
flags are not yet seen on a real model).

- **The answer check** (`answer-check.ts`, `answer-check-step.ts`, `writer-stage.ts`). A document v3 has no calls, so the job records the check as passed with no request and publishes the draft held. The model step that checked a v2 Scroll's answer keys (the role `content.scroll-answer-check`), the writer's one repair after a flag and the second draft they made possible were reachable only from the v2 job and are deleted (#815). `answerChecksOf` and the summaries stay: the review gate, the release policy and `production-status` read the receipts of the jobs that did run the check.
- **The bound** for a library take is six paid requests (`REQUEST_BOUND_V2_PER_TOPIC`, a name kept from when a v2 take sent two writer requests and two checks; a document v3 take is held to the same bound, `REQUEST_BOUND_V3_PER_TOPIC`). An order's bound is still the answer to a question's fourteen (`REQUEST_BOUND_ASK_ORDER`, kept because the `content.produce-answer` queue's claim is sized by it) but it is an unused upper bound: no order sends a request any more, the job ends it as `made_to_order_unavailable` before research ("Made-to-order Scrolls" below).
- **The claim.** A claim is the most requests a take sends times the largest request timeout the transport accepts (`MINIMAX_REQUEST_TIMEOUT_MAX_MS`, 300 s) and the waits around each request (20 s, the reasoning README's rule), plus 180 s for the research and the database steps (`events.ts`). `content.produce-scroll` holds `PRODUCE_SCROLL_CLAIM_SECONDS`, for the six requests of a library recipe: 2,100 s (unchanged by D-445: the document v3 writer's three requests, the writer and its two repairs, need 3 x 320 + 180 = 1,140 s of it, and `versions.test.ts` pins that they fit). The answer to a question has a queue of its own, `content.produce-answer`, with `PRODUCE_ANSWER_CLAIM_SECONDS` for its fourteen requests: 4,660 s (D-267, D-297). The payload, the singleton key, the policy and the consumer are the same; only supply's ask path sends to it, so a library recipe whose worker died is still retried after 35 minutes, not 78.
- **Regeneration.** `content regenerate --only <keys>` sends the next take of a recipe whose Scroll is served. `store.create` lets a
  take of a document v3 recipe follow a take that was rejected or whose Scroll was released, never one still held or of unknown outcome. A
  recipe has three takes to a **production version**, which is the budget: `SCROLL_PRODUCTION_V3_VERSION` changes whenever the v3
  writer or the job's steps change (`versions.test.ts` pairs it with the writer's version), and the older version's jobs do not count.
  `regenerationStanding` and `planRegeneration` (`domain/library/serving.ts`) are the pure rules.

## The shared support checker (S-7b to S-7g, D-250 to D-252, D-263, D-265 to D-267, D-281, D-305 to D-307, D-313, D-316; the "You asked" use is deleted, #818, D-443)

Status: **implemented**, runtime-verified with labelled CI fixture models on real PostgreSQL. The checker was built to read the answer to a person's question (an ask order, "You asked", D-218) before anyone saw it. That writer, the trim and drop code built on its block shape, the revision a flag earned and the replay over stored ask answers (`content ask-check`) are deleted (#818, D-443): the v1 writer goes, and made to order stays off until it is rebuilt on document v3. **What stays is the checker itself**, because others use it: a **Quick answer** (supply) and a **resident's answer in a room** (rooms, D-301) call `askSupportRole` with the strict rules, in one request each, under roles of their own; and the **library support check** (below, D-415) builds on its instructions, its reply schema and its judge. The measurements of the old ask check (1 and 2 November) are history in the decisions (D-250 to D-376).

- **The check** (`ask-support.ts`, `domain/ask-support.ts`). The role `content.ask-support-check` (`ask-support-check.v5`) is shown the passages an answer cites and the answer's numbered sentences, and no question, brief or stop. The title, the dek, each heading and a callout's title are sentences too and rest on everything the answer cites; every other sentence rests on the passages its own block cites, and a quote may come from any passage the answer cites (D-305). The title, the headings and the callouts' titles are **labels** (`label: true`). It replies `{sentences: [...]}`, one verdict for each sentence in order: `supported` with a quote, `unsupported` with a fixed `kind` and a short problem, or `no_claim`. **What the three mean (D-281):** `supported` is stated by the cited passages, said in other words or directly implied (one plain step; putting two of their statements together counts when it says no more than the two mean); `unsupported` is a fact, figure, cause, comparison or example they neither state nor imply, a wider scope or stronger word than they use, or what they contradict; `no_claim` adds no fact (a transition, a signpost). A join of two statements is supported only when every part is stated. The instructions carry five short invented worked examples, and a test holds that each supported example passes the code rules.
- **Batches (D-267).** A long answer is checked a batch of at most ten sentences at a time (`ASK_SUPPORT_BATCH_SENTENCES`), one request and one run each
  (`askSupportRunId`), in order. A batch carries every passage the whole answer cites (D-305) and keeps its sentences' own numbers. The first
  batch with no usable reply makes the whole check unusable and the later batches are not asked. The harness repairs one unusable reply in the whole
  check, wherever it happens, so an answer costs its batches plus one. An answer of more than four batches (`ASK_SUPPORT_MAX_BATCHES`, 40 sentences) is not checked: `support_check_answer_too_long`, with no request sent.
 
- **What code checks, and what it cannot (D-263, D-265, D-266).** Two kinds of rule. **The shape of the reply** refuses it whole (one harness repair): not valid JSON or cut
  off, a verdict that is not well formed, a sentence skipped, repeated or reordered. **Each verdict is judged on its own sentence**, and a verdict that
  breaks a rule makes *that sentence* `unsupported` (kind `not_stated`, a fixed note, the rule's code kept) while every other verdict stands:
  `quote_too_short` (fewer than three words, letters and numbers count, a dash does not; with an ellipsis, two words in each part),
  `quote_not_in_cited_passages` (the quote is not, word for word, in a passage the answer cites: curly or straight quotes, any dash, non-breaking or
  repeated spaces, case, an ellipsis for words left out and `4,096` for `4096` make no difference; with an ellipsis every part must stand in one sentence of the passage and the words left out must hold no negation), `quote_not_about_sentence` (it must carry at least
  two of the sentence's key words: uncommon words of three letters or more, compared by their first five letters, or all of them when there are fewer; the soft rule of D-306 and D-316, off by default, would take one for a sentence of eight or fewer when the quote has two key words of its own),
  `no_claim_without_ground` and `too_many_no_claim`. `no_claim` has a ground code can see: a question; a title, heading or callout title of at most four words with no figure (a longer one states something and is judged), or the title of a limits callout ("What this does not explain"); a
  plain admission of a gap that is the *whole sentence* (`namesTheGap`, a small fixed list: "The pages do not say...", "This answer cannot tell...", "That detail
  remains unspecified here"; a sentence with a number, or one that goes on after the admission with a semicolon, "but" or a second clause, is judged); or, under the soft rules only (D-307, D-316), a figure-free sentence of eight words or fewer, or a longer one that shares no key word with its
  passages. When more than half the sentences of a request are marked `no_claim` on those last, weakest grounds, those sentences are set aside (a request that is only the end of a longer answer may hold one in any case, D-313).
  The two soft rules are `CheckerRules` (`shortNoClaim`, `oneKeyWordAbout`), off by default, which is the check of v4; they were turned on only for an ask order's check, which is deleted (#818, D-443). A Quick answer and a resident's answer call `askSupportRole` and keep the strict rules, and their checker is not told otherwise (`askSupportInstructions(rules)`, D-316).
  **Whether the quoted words support the sentence is the checker model's judgement**, which code cannot check; it is measured on dev with the replay
  before anything relies on it (D-250, D-252, D-263 to D-267).
- **What was deleted with the writer it served (#818, D-443).** The answer's sentences taken from the v1 block shape (`sentencesOfAnswer`, `placedSentencesOfAnswer`), the check's step in the writer stage (`ask-support-step.ts`), the revision a flag earned and the one repair of it, the drop of the sentences that still failed (`ask-support-drop.ts`), the trim before the check and the limits callout code wrote (`ask-answer-trim.ts`, `ask-answer-limits.ts`, `ask-answer-rebuild.ts`), the shape of the answer (`ask-answer-shape.ts`), the copy-repair notes, the candidate-instructions reader and the replay (`ask-support-candidate.ts`, `ask-support-replay.ts`, worker `ask-check-operator.ts`, `content ask-check`), and the writer's prompt versions `question-writer.v9` and `scenario-writer.v1`. The product rules of the three modes are kept word for word in D-443, for a document v3 writer of made-to-order Scrolls later. An order that reaches production is ended as `made_to_order_unavailable` before any research or request ("Made-to-order Scrolls" below).
- **Versions.** `ask-support-check.v5` is the version of the shared role. The library check's two versions (`library-support-check.36a100f4`, `support-check-v3.8ec40d06`) are **pinned literals** and no longer a hash of this module's source (#818, D-443): the source moved when the ask code left it, the check did not change, and a new hash would have made every stored result stale and re-checked every held revision with paid requests. `SCROLL_PRODUCTION_VERSION` stays `scroll-production.v14` because an order's job rows and the v1 recipes' stored job rows carry it.


## The support check of a library Scroll (#674 slice 3.2, D-415)

Status: **implemented**, CI-verified with a labelled fixture checker on real PostgreSQL (`tests/integration/modules/library-support-check.test.ts`). **Planned:** the first measurement on real
MiniMax, which the coordinator makes on dev with `content support-check-replay` ("Measure the library support check" in the runbook); no agreement number exists yet, and nothing relies on the check.
The operator still reads and releases every library Scroll (D-138). The check informs that read once it has been measured; it releases, rejects and serves nothing, and a change that lets it do so is slice 3.3's, after the measure.
**While it is measured, the operator does not see its verdict** (`review-list` and `review-show` leave it out unless `--show-check` is given), so the decisions it is measured against stay the operator's own.

- **What is checked** (`library-support.ts`, `sentencesOfScroll`, pure). Every sentence a reader sees of a stored v2 revision, in reading order, each with the passages its own part cites: the title and the dek (resting on every
  passage the Scroll cites), each stop's headings, paragraphs and lines, its plain restatement (`simple`), its guide's line, the explanation of a sort, a fork's prompt and branches, each point of a scale or a chart as the words a reader sees
  (`describePoint`: a label and its figure, "Earth: 147 million km"), a call's statements, explanation, twist and restatement, each aside's title and text (beside the stop it opens next to), and the recap's captions. The passages are the claims of the
  revision's private provenance (`scroll-provenance.v2`), one handle each (`e1`...), and a part rests on the claims it cites (`libraryEvidenceOf`). A Scroll with a stop, an aside or the recap that cites nothing the provenance holds is not
  checked (`citations_missing`, no request). **What is not read** is listed in `NOT_COVERED` and printed as a "Not covered:" line with the verdict and in the replay's summary: questions put to the reader, a call's options and answer key (the answer check reads
  the key, D-198), the items of a sort and their order, the labels of a fork's branches, a scale's axis and marker and a chart's shape and unit, the misconception, the landmark's name, the picture and the words derived from its state, and the Ask suggestions.
- **The role** (`content.library-support-check`, background budget class). The ask check's schema, its three verdicts (`supported` with a quote, `unsupported` with a fixed kind and a short problem, `no_claim`) and every rule code applies to
  a verdict on its own sentence (`judgeVerdicts`, D-265), under an introduction of its own and the library's rules (`LIBRARY_CHECK_RULES`): `oneKeyWordAbout` is on, because a Scroll is written in other words than its sources (nine words in a row may not be copied) and a good
  paraphrase keeps one key word (D-306); `shortNoClaim` is off, because nothing takes a sentence out of a Scroll and a short line can state a fact (D-307); **`ownPassagesOnly` is on**: the quote must come from a passage the sentence's own stop, aside or recap cites
  (the title and the dek cite every passage, so they may use any), not from any passage the Scroll cites as in an ask answer (D-305), so a sentence supported only by another stop's passage is not supported where the reader reads it; and **`noClaimUnshared` is off**: a sentence that
  shares no key word with its passages is not "no fact" on that ground, which would be the way past the check for any sentence, so a "no fact" verdict for it is set aside (`no_claim_without_ground`) and the sentence is `unclear`. The role has its own id, so its daily budget and failure brake never touch
  the writer's or an ask check's, and the background class stops it at the background share of the global and production caps, so it cannot use what a person's request needs.
- **The version.** `LIBRARY_SUPPORT_CHECK_VERSION` was `library-support-check.` and eight hex digits of the SHA-256 of the instructions, the rules, the policy and the normalised text of the modules whose code decides what the check says: the ask check's shared judge and instructions
  (`domain/ask-support`, `production/ask-support`), `domain/library-support`, `production/library-support` and `production/library-support-step` (`library-support-version.ts`; comments and layout do not count, code does; it reads the `.js` of a release or the `.ts` of a test). A stored result is keyed by it, so a new value is a new measurement and never mixes with an old one.
  **Since #818 (D-443) both shipped versions are pinned literals**, equal to what a release built at `f4293032` computed, so deleting the "You asked" code from `ask-support.ts` did not make every stored result stale. The hash function now only says how a new value is computed: a change to what the check says must change the literal by hand.
- **Batches and bound.** Ten sentences a request (the ask check's size, which no reply was cut short at, D-267), one request and one run each, in order, with at most ten batches (the ask check's
  limit is four): a library Scroll is 40 to 90 sentences, and the Orrin fixture of 711 words has 57. A revision of more than 100 sentences is not checked (`revision_too_long`, no request). A request carries only the passages its own sentences cite (the batch with the title and the dek carries all of them),
  in several items when they would not fit one. One unusable reply is repaired by the harness in the whole check, so a check costs at most eleven requests (`LIBRARY_SUPPORT_REQUEST_BOUND`) over every round, and its job's claim is 11 x 320 s + 180 s = 3,700 s. The first batch with no usable reply makes
  the check unusable and the later batches are not asked.
- **What is stored** (`content.library_support_checks`, migration 0113, `library-support-store.ts`). One row for a revision and a checker version: the state (`checked`, or `unchecked` with a code that never holds provider text), the revision's verdict and the policy it was decided
  under, the counts, the requests sent over every round, the round, how often each batch failed, and the sentences with what became of each: `supported`, `unsupported` (the checker's kind and short problem), `unclear` (the checker's verdict broke a rule code applies, so nothing shows a passage states the sentence
  and the checker did not say none does; the rule's code is kept) or `no_claim` (a label or a plain admission of a gap, with the `ground` code found for it). Each row also keeps the sentence's words and where it stands (`s3 paragraph #14`), and **the quote the checker gave with how it stands to the sentence** (the sentence's key words, the quote's and the
  ones they share), even for a verdict code set aside, so that a stricter rule can be applied later without paying again. The key references the review gate's row (`content.revision_reviews`), so only a library or generated Scroll under review can have a check.
- **The verdict is code's** (`domain/library-support.ts`, `decideRevision`). Policy `library-support-policy.v2` passes a revision with no `unsupported` sentence, no `unclear` one and at most eight labels or admissions passed as stating no fact (a title, a heading or an aside's title of a few
  words passes without a quote, so a Scroll may not lean on them); anything else is `flagged`; a check that gave nothing is `unchecked`. A looser policy is a new version, chosen only after the replay has measured it: `agreementOf` reports the same stored results under looser limits at no cost.
- **Running it** (`library-support-job.ts`, `adapters/enqueue-library-support.ts`, worker `production-jobs.ts`). Three things send a check, all to the queue `content.check-library-support` (exclusive: one job for a revision and checker version at a time, IDs only).
  The delivery that held a Scroll sends its check at once, outside the transaction that held it and swallowing a failure to send, because the check is recoverable. The sweep `content.sweep-library-support` (a cron every ten minutes, no model) hands over
  up to twenty held revisions that have no result of the current checker version, oldest first, and every one whose last try ended on a provider failure an hour ago with rounds left. So a revision an operator's direct run held, a check a spent budget paused and a revision
  held before the check existed all get theirs. The consumer is registered only on a worker with the production grant, like the production queues, and the check runs `makeCheckLibrarySupport`, which **refuses a revision that has no row at the review gate** (`not_under_review`: a made-to-order revision never has one and is never stored here); nothing a person made is read, and no model call or network wait is inside a transaction.
- **Reliability.** Every request is an attempt in the production ledger, so a redelivery of the job reads the stored result, or asks the ledger for the answers it already holds, and pays for nothing twice (tested: a delivery that dies after every batch was answered and before the
  result was stored). An attempt of unknown outcome is never resent: the check ends `unchecked`, `outcome_unknown`, its run stays open for `reasoning unknown` and `reasoning write-off`, and the result is final for the checker version. The result row and the closing of the runs it used are
  one short transaction under the production root. A spent budget or quota, or a full failure brake for the role (five unresolved or failing runs a day), stores nothing and sends nothing: the check stays open and the sweep asks again. **A conclusive provider failure is tried again in a later round
  that asks only the batch that failed and those after it:** the batches answered before it keep their runs (open, with the same request, so the ledger gives their answers back for nothing) and a failed run is ended for good, so only the failed batch is asked in a run of its own. At most three rounds, and every request the revision could still need, one repair held back, must fit eleven in all
  (`mayTryAgain`; a revision of ten batches is tried once). The result is `provider_failed` while another round may come and `provider_failed_final` once it may not; a later round that succeeds replaces the failed result. Every other `unchecked` code (`outcome_unknown`, `invalid_output`, `revision_too_long`,
  `citations_missing`, `provenance_unreadable`, `refused_...`) is final for the version.
- **What the operator sees.** Nothing by default. `content review-list --show-check` carries `supportCheck` for each revision (the checker version, the policy, the state, the verdict decided again from the stored sentences under the current policy and the counts, with no sentence; `null` when no check of the
  current version ran yet) and `content review-show --show-check` prints the verdict under the header, the sentences that passed as stating no fact with their ground, "Read these first" with each unsupported or unclear sentence, where it stands and the checker's note or the rule's code, and the "Not covered:" line. The flag is for after the measurement.
- **Measuring it** (`library-support-replay.ts`, worker `support-check-operator.ts`). `content support-check-replay [--since <ISO date>] [--limit <n>] --max-requests <n> [--fail-on-partial]` reads the newest revisions a person released or rejected (`decided_by` is `cli:<operator>`), runs the same use case over each that has no result of the current
  checker version, and prints how the stored results agree with the decisions. **Only decisions made before a result existed count** (the result was made at or after the decision): a revision whose result existed before the operator decided is reported apart (`exposed`) and is in no matrix. The agreement has the confusion matrix, the rejected revisions the check would have passed (the dangerous number) and the released ones it would have flagged, by recipe family (the
  system of the revision's recipe), each rate with n and its Wilson 95% interval (`rejectedPassedRate`, `releasedFlaggedRate`, `flagRate`; the rule of three when none passed), the revisions it could not check and why, the same results under looser limits, and **a time split**: the older half of the decisions chooses limits (only with at least three rejected revisions in it) and the newer half reports the active policy and the choice, which never saw it.
  `conclusion` says plainly whether the number of rejected revisions in the newer half is enough to conclude anything (the upper bound of the rejected-passed rate must be at most 10%, which takes about 30 rejected revisions with none passed). The summary's `status` is `done`, `partial` (some decided revisions were skipped for the request cap, counted by decision in `skippedForCap`, and the agreement covers the rest only; exit 2 with `--fail-on-partial`) or `stopped`.
  It writes only the check's own rows, is idempotent per revision and checker version, and is bounded by `--max-requests` (a revision that might pass it is skipped, not started). It prints counts and codes, never a sentence.
- **The check of a document v3 (D-435).** A stored `scroll-document.v3` is checked by a check of its own beside the v2's, never in its place: the same use case (`library-support-check.ts`), job, sweep and replay, routed by the revision's schema to the version that reads it (`library-support-kinds.ts`: `LIBRARY_CHECKER_VERSIONS`, `checkerVersionOfDocument`). Why a version of its own: the owner decided (#771, decision 5) that stored v2 results stand, and the v2 version is a hash of the modules above, so no
  module of that list was edited and a v3 got modules and a version of its own.
  - **Sentences** (`library-support-v3.ts`, `sentencesOfScrollV3`, pure). The title and the dek (resting on every passage the Scroll cites); for each section its title (a label, resting on its beats' passages), each beat's paragraph (a quotation as a `line`) and plainer words, the asides beside that beat, and the words of the picture the beat shows: `describePicture` for every state a reader can see it in (the beat's, a switch's `to`, each stop of a scrub, each item a pick lights), once each, against the passages the picture itself cites; last the takeaway. Parts cite as the provenance says (`ScrollProvenanceV3`: a beat, aside or picture id, or `takeaway`). A part with no passage refuses the check (`citations_missing`). The stored `field` is one of the library's fixed codes (a section title is a `heading`, a beat a `paragraph`, a picture's words a `point`, the takeaway a `caption`), so a stored v3 result reads with the schema the v2 results use; the `part` says which it is. Not covered: questions, who a quotation is credited to, the labels of controls, what a picture draws, the misconception, the kicker and the Ask suggestions (`NOT_COVERED_V3`).
  - **The version** is `support-check-v3.` and eight hex digits of a hash of the instructions, the rules, the policy and the normalised text of `CHECK_SOURCE_MODULES_V3`: the ask check's shared code and `library-support` (which build the context and the reply schema a v3 verdict means), and the two modules of its own. It is 25 characters, inside the harness's 32. The v2 step is not in the list: a v3 has a step of its own (`library-support-v3-step.ts`), a copy that puts the v3 version in each batch's run, role and policy, because a step that took the version as an argument would have been an edit to a module the v2 version hashes. The two are kept alike on purpose. Pinned as a literal since #818 (D-443), like the v2's.
  - **Batches.** 13 sentences to a request, not 10 (`LIBRARY_SUPPORT_V3_BATCH_SENTENCES`), within the same bound of ten batches and eleven requests, so the job's claim is unchanged: the three labelled fixtures come to 96, 97 and 121 sentences, which ten to a request would put over the bound.
  - **Starting a check.** `checkLibrarySupportJob(asset, revision, version)` names the version (the v2's by default); the job is dropped for a version this build does not have (`checker_version`) and refused for a revision that version does not read (`other_checker_version`). The sweep's `dueHeld` gives each held revision with no result of its own document's version, with that version, so a v3 is handed over with the v3 version. The delivery that held a Scroll sends the version that reads the document its recipe produces (`checkerVersionOfRecipe`: a recipe the plan marks `scrollV3` gets the v3 version); the sweep finds any it missed. `content support-check-replay` checks and measures a decided v3 under the v3 version (the summary names both versions and both "not covered" lists).
  - **The release policy** reads the result of the version that reads the revision's document, and a result of the other version is `stale_support_check` (content README, "The release policy").
- **Limits.** The check judges sentences against the passages their part cites; whether the quoted words support the sentence is the model's judgement, which code cannot check, and the measure is how that judgement agrees with the operator's. It cannot see a picture that
  contradicts its words, a call whose answer key is wrong (the answer check does that, D-198), or a fact the passages do not hold and the writer left out. A Scroll with a fact the sources contradict can still pass if the checker is wrong. With the sweep running, a decision made after a result exists is reported as `exposed` even though the verdict was hidden; that is deliberately conservative.

## Jobs, takes and who sends them

Production is the `content.produce-scroll` job (`events.ts`; the answer to a question is the same job on `content.produce-answer`, D-267), one per **recipe, recipe version and
take**. The payload is IDs only: the recipe key, the version and the take. The queue is `exclusive`:
a second send for the same recipe, version and take is refused while one is queued or running, and a
finished or failed job never blocks a new send. The consumer (`job.ts`, wired in `apps/worker`) runs
`makeProduceScroll` with resume on every delivery, so a redelivery after a crash continues the same
business run and an attempt of unknown outcome is never resent. It runs only on a worker that holds the
production grant (`KS_REASONING_PRODUCTION_ENABLED=1`); otherwise jobs wait in the queue.

A take that ended `asset_conflict` on an asset that is not withdrawn does not count toward the three takes and keeps its number, so take numbers go to six (D-439, migration 0126). Before the research and the writer send anything, the job reads the recipe's asset once (no lock, no transaction held): an asset that is withdrawn or not a Scroll ends the take at once as `rejected` with the `asset_conflict` receipt and no model request, and `publish` still checks under the asset's lock because the asset can change while the writer runs.

Who sends a job:

- **Quartermaster Create** (`modules/supply`): inside a person's request transaction, with priority 10.
- **The operator**: `content produce-library [--only <keys>] [--interactive-first] [--dry-run]` sends
  the jobs of recipes that need one, at priority 0, and `content production-status` lists every recipe.
  `content produce-scroll --topic <key> [--take n]` runs one job directly through the same use case; it is
  a debugging tool.

A **take** is a new attempt at a recipe at the same recipe version. Take 1 always may start. A rejected
job is final for its take, but take 2 (then 3) may start once every earlier take was rejected. Never after
a published job (except a v2 library recipe's, whose released Scroll can be regenerated, below) or an unknown attempt, and never past three takes. Each take is its own business run with
its own writer run and attempts, so nothing an earlier take sent is sent again. Senders pick the take from
the recipe's standing (`domain/library/serving.ts`): `not_started` takes 1, `running` resumes the latest
take, `retryable` (every take rejected, fewer than three) takes the next one, and `published` and `stopped`
send nothing.

When a daily budget or the provider's quota is used up, the run **pauses**: nothing is sent, the job stays
open at its writer stage and the delivery completes. The next send for the recipe (an operator's library
run, or a person who joins the group: Quartermaster sends the job again on every join) resumes it. A
rejection is a verdict on the answer; a pause is not. Attempts that sent nothing stay in the ledger but
are left out of a published Scroll's lineage, so a Scroll published after a pause is attributed to its
topic and facets like any other. A run that keeps pausing uses up the step's four attempt slots
(`attempts_exhausted`), and then the take is rejected.

A failed research fetch (`dns_timeout`, `request_timeout`, `network_failed`, `http_refused`, or an error that
is not a refusal) is also not a verdict. The job stays at `research`, no take is spent, and the delivery fails
so the queue retries it with its backoff. Only `soft_404`, a refused host or an unusable page ends the take
as rejected.

## The pipeline

```text
operator ─▶ job (research) ─▶ evidence passages ─▶ writer (1 call + 1 repair) ─▶ compile ─▶ publish
```

1. **Job.** `makeProduceScroll` reserves one job per `(topic, production version, take)` in
   `content.scroll_production_runs`, then fetches the recipe's public pages by code, never by the
   model, and freezes them on the job. An order (`order-…`) is reserved and ended here, as
   `made_to_order_unavailable`, before the research (below).
2. **Evidence** (`evidence.ts`). The frozen page text is cut into passages of 40 to 600 characters
   at sentence ends and numbered `e1`, `e2`, … (at least four, at most 64). A handle maps to a
   claim ID that hashes the page, passage and span, so a resumed job sees the same evidence.
3. **Writer** (`writer-plan.ts`, `writer-v3.ts`). One call of the stable role `content.scroll-writer`: the document v3
   writer (below), the only writer. The harness allows a repair, which receives fixed, path-located findings and, because the
   writer opts in (`repairWithPreviousAnswer`), the refused answer as escaped, delimited data in the
   user message so it can revise instead of rewriting; the writer also opts into a second repair when the first repair's findings are all copies (D-445). The nine-word rule (`COPY_RUN_WORDS`) is the one number the check, the
   instructions, the hints and the notes read.
4. **Compile** (`stored-v3.ts`). Code runs every check of the document v3 producer: structure, numbers (a figure must appear in
   a passage the item cites), copy limits (no nine words in a row from the sources), no source or publisher names, and stored-document
   admission. Findings are reported at the part the writer wrote.
5. **Publish.** In one transaction under the production root: close the writer run, store the
   immutable revision and its private provenance, mark the job published and project the topic.

Numbers and quotations are checked mechanically; they do not prove that a sentence is entailed by
its passage. Human sampling of generated Scrolls is still required: a held library Scroll's sentences are also read by a model
(the support check, below), which informs the operator's read and replaces none of it until it has been measured against the operator's decisions.

## Why this shape

Earlier recipes asked for the canonical draft inside a tool call, then for a JSON string inside a
tool call, with a separate claims call before the writer. Every real attempt failed: a model that
writes a long, deeply nested document inside an escaped string loses count of quotes and brackets
(observed: a dropped quote, an unbalanced bracket). Plain text JSON worked, and so does a flatter
shape the model finds easy: strings for rich text, ids it chooses for diagram nodes, derived
accessibility text and fallback text, and citations instead of anchored bindings. One call replaces
two because the writer sees the numbered source passages itself and cites them per block; code
hydrates the exact text of each cited passage, so a claim is still always a substring of fetched
research. Decision D-032.

## State, locks and recovery

| Stored table | Role | Main query | Lifetime |
|---|---|---|---|
| `content.scroll_production_runs` (0015, 0045, 0050, 0052) | Authoritative, private job: research pages, the authored document and the cited claims once published, code-only outcomes, the revision pointer. States `research`, `writer`, then `published`, `rejected` or `unknown` | Unique `(topic, policy_version, take)` with take 1 to 3, UUID | Nonpersonal public supply; retained for correction, no account erasure |
| `content.asset_revisions` / `asset_provenance` | Immutable admitted consumer bytes / internal evidence and generation lineage | Asset + revision | Shared content; no account erasure |
| `content.library_support_checks` (0113) | What a checker version said about a stored library revision: the state, the verdict code decided, the counts and every sentence's outcome | Asset + revision + checker version (the primary key); the held revisions with no result (the sweep) | Nonpersonal shared content; kept as the evidence of how the check agreed with the operator, no account erasure |
| `reasoning.production_*` (0013, 0050) | The writer run, every possible paid attempt, and the refused answers kept 30 days for diagnosis | Stable writer run UUID | Harness retention and liability policy |

Lock order: production root → production job row → asset advisory lock → asset rows. The support check of a library Scroll takes the production root and then its own result row, and no asset lock. Short
transactions freeze or apply data; no model or HTTP wait holds one. Every rejection and the final
write require their expected stage under the root and job lock, so a delayed delivery reports the
advanced job instead of acting on it. `--resume` continues the same frozen research and the same
writer run through the ledger after a crash. An unknown attempt stays unknown and is never resent.
A rerun reports the existing state; a terminal rejection stays rejected for its take. A changed recipe is
a new `SCROLL_PRODUCTION_VERSION` (and `WRITER_PROMPT_VERSION`), never an edit of an old job.

When a Scroll fails, `reasoning rejected` lists the refused answers with the validator's findings
(`packages/backend/src/reasoning/README.md`); that is where to look first.

Jobs: `content.produce-scroll` and `content.produce-answer` (above), and `content.check-library-support` and `content.sweep-library-support` (the support check of a library Scroll, above). Notices: none. Erasure: nonpersonal supply, nothing to erase.
Operator steps: `docs/v2/operations/scroll-production.md`.

The recipes the producer runs are the library plan in `../domain/library/` (one file per topic
system); `topics.ts` is only its index. The recipe key, the brief, the research pages and the
interactive block kind (`interactiveKind`) all come from the plan. Neither private research nor
provenance is reachable through content's client-facing read ports.

## Stored recipes and the brief role (#674, D-412)

A recipe whose key starts with `gen-` lives in `content.recipes`. **It is a document v3 recipe** (#781, owner decision 4 on #771: a proposal may
carry pictures). It runs through this job like a v3 library recipe: `subjectOf` reads its row (`librarySubject` builds the subject from the book recipe,
with its own asset and explanation identity, and `scrollV3` = the proposal's `shape` and section intents, no pictures), `productionVersionOf` and
`requestBoundOf` treat the key as a v3 recipe (`scroll-production-v3.v5`), and the Scroll is stored held (`isHeldForReview`). Those two, the standing and
the plan refusal hold only a key, so they stay key-only: `scrollV3PlanOf` returns a fixed marker plan for a `gen-` key (it says document v3, no
misconception, nothing more); the real shape and sections reach the writer from the row through `bookRecipeOf`.
A row whose plan is not a v3 one (a v2 plan an older process wrote) is refused before any job is reserved or request sent: `plan_refused`,
`stored_recipe_plan_not_v3` (`storedPlanRefusalOf`). A row whose `scroll_v3` does not parse is a defect: `bookRecipeOf` throws
`STORED_RECIPE_PLAN_INVALID`. **The document v3 writer produces it** (#783, "Producing a document v3 Scroll" above): `writerPlanFor` takes `subject.scrollV3`
into `v3Plan` (`parseProductionRecipe` accepts a `gen-` key), the role is `writerRoleV3One`, the job runs at `scroll-production-v3.v5`, and the Scroll is stored
as a `scroll-document.v3` with its `scroll-provenance.v3`, held for a read, attributed to its planet and given coverage, exactly as a v3 code recipe's is. The
integration tests that produce a stored recipe through the real job answer it with the labelled Orrin reply in the document v3 shape (`orrinV3`).
`store.create` moves the recipe from `checked` to `queued` with the job row, and `store.finish` moves it to `produced` with the stored Scroll.

`propose-recipes.ts` and `recipe-brief.ts` are the proposing step. The role `content.recipe-brief` (version `recipe-brief.v2`, which asks each draft for a `shape` and two or three section intents and no longer forbids naming a picture, background class, one
request and at most one repair, `repairWithPreviousAnswer`) runs on the production harness through `proposeProduction`, so each paid attempt is in the
attempt ledger. Its run is `stableUuid("content.recipe-brief:<version>|<planet>|<facet or ->|<UTC day>|<retry>")`: derived from the request and never
from what it stores. `content.recipe_proposals` is the job row of this step: the first delivery freezes the context it sends there (`openProposal`),
and every later delivery sends exactly that, so the harness answers from its ledger even when other recipes were stored since and a kept answer is never
refused as a changed request. A row that is `completed` with recipes answers `already_proposed`; one that is `failed`, or `completed` with nothing
stored, answers `closed_failed` with the next retry number (`--retry`, at most 2). The outcomes follow the production job's convention (`settlementOf`):
a kept answer completes the run, an answer invalid after its repair or a conclusive provider failure closes it as failed, and an attempt of unknown
outcome, any refusal of the harness (it may have been sent), a spent budget or quota, or a scope that refused leave it open and are never resent.
After the answer one production transaction stores the recipes and closes the run: it takes the planet's advisory lock (`lockPlanetRecipes`), reads the
recipes that exist now, runs every draft check again against them (`decideDrafts`), inserts the accepted ones, settles the proposal and closes the
harness run. No network wait or model call holds it. `--dry-run` (`previewRecipeProposal`) reads the shared database only. The pages a proposal may use
are the ones the planet's recipes' jobs froze (`readCandidatePages`): nothing is fetched, and a planet none of whose recipes was ever produced has none,
so it is refused before any request.
The UTC day in the run's identity is today's unless the request pins one (`ProposeRecipesRequest.day`): Supply's gap loop (D-414) pins the day of an
attempt and sends it on every delivery, so a redelivery after midnight is the same request and the ledger answers it. The loop reads the outcome as
recipe keys and codes (`proposed` and `already_proposed` are stored recipes, `closed_failed` a failed attempt, `refused` a refusal no retry changes, `paused`
a spent budget, `failed` with an unknown or open run an attempt never to be resent) and records no model text.

`topic-proposal.ts`, `propose-topic.ts`, `topic-seeds.ts`, `grow-topics.ts` and `topic-growth-events.ts` are topic growth (#674, D-422): new topics under the
systems that exist, from pages code finds. `topic-seeds.ts` reads the links of the research pages of every recipe that is not retired (once each) and the candidate
pages they lead to, outside any transaction and through the research URL rule, and stores each candidate with a verdict (`content.topic_candidates`). The role
`content.topic-proposal` (version `topic-proposal.v1`, background class, one request and at most one repair, `repairWithPreviousAnswer`) runs on the production harness
through `proposeProduction` exactly as `content.recipe-brief` does: its run is `stableUuid("content.topic-proposal:<version>|<candidate page>|<UTC day of the attempt>|<attempt>")`,
the candidate pins the day of an attempt in flight, and `content.topic_proposals` freezes the context and the systems offered on the first delivery, so a redelivery sends
exactly that and the ledger answers it. The outcomes follow the same convention (`settlementOf`): a kept answer completes the run, an answer invalid after its repair or a
conclusive provider failure closes it as failed (the attempt is counted on the candidate, at most two, and the candidate waits for the next UTC day: `not_before`), a refusal that sent nothing (no
provider, the scope off, a request the harness cannot take, the role's failure brake) leaves the run open and **pauses**, and an attempt of unknown outcome or any other refusal of the harness (it may have
reached the provider) leaves the run open and **blocks the candidate** so nothing is ever resent; a late answer of a delivery whose candidate was blocked meanwhile still links the topic it made. After the answer one production transaction takes the catalogue's release lock, reads the catalogue
as it is then, runs `admitTopicProposal` and, if it admits, `appendReleaseIn` (the release, source `growth`), settles the candidate and the run and closes the harness run.
`grow-topics.ts` is one pass of the scheduled `content.grow-topics` job: gated by both switches and the production grant, kept within the growth cap and the size limit,
one pass at a time under a session advisory lock (the operator's `content propose-topic` takes the same one: `proposeUnderLock`), at most one proposal; it skips candidates backed off until the next UTC day and goes on past a page no system offers itself for. The claim covers seven worst-case page reads and one request with its repair.
`topic-review.ts` is the owner's approval of each topic that grew: `reviewCandidates` (the text an operator reads) and `decideTopic` (approve, which makes the topic servable if it has its supply, or reject, which retires it). A grown topic is withheld from `topicsNowServable` until approved, and the store of releases refuses a change that would show one.

## Publication: topic attribution and coverage

`completeWriterPublication` is private to production and has no consumer/composition attribution
port. It requires the current live production scope, the locked writer-stage job and actual
successful `closeProductionRun`. After its publication callback stores the immutable revision and
marks the exact job published, unexported helpers match the current policy, target asset and
revision, explanation identity, admitted Scroll status, document/provenance hashes, model
production run and writer prompt version, successful primary/repair accounting identities and
the job's exact writer receipt. Provider/model must be the configured real MiniMax family; a
normal fixture transport/model, arbitrary editorial/model-kind or explanation-ID lookalike,
missing job, foreign lineage, incomplete job or contradictory metadata does not gain authority.
The helpers read no reasoning SQL, request bytes, raw answers or research text. Actual closure
and bounded accounting come through the existing harness within the same production transaction.

Two things are then written in that same transaction, both decided by code from the recipe in the recipe book (the library
plan in `domain/library/`, D-033, or a recipe stored in `content.recipes`, D-412; `recipeOfJob` asks for the job's key):

1. **Planet.** The `0016` trigger already creates the exact revision's baseline discovery row.
   The hook projects one primary topic with weight 1 (the recipe's planet, for example
   `machine-learning.attention`) under `published-scroll-brief-taxonomy.v1`. Existing aggregate
   weight guards remain active.
2. **Coverage.** `admitRecipeCoverage` binds the recipe's facet (and optional supporting facet) to
   blocks of the stored document under the structural rule `scroll-recipe-coverage.v1`, and appends
   the first coverage head. A document with too few body blocks publishes without coverage and a
   `coverage_*` outcome is added to the job. See the content README, "Scroll coverage".

No immutable document/provenance bytes, personal encounters, activity, growth, series or
relationships change. Failure in either step rolls back writer closure, publication and metadata
together; same-run ledger replay recovers without resending a paid answer. Missing authority
remains unknown. Historical-published reconciliation is **unavailable**: completed old runs need a
separately named reasoning attestation read before any such capability can exist.

CI uses explicitly labelled transport identity stand-ins for positives and fault injection for
authority negatives; none is real provider or discovery journey evidence.

## Made-to-order Scrolls (#244, D-049; no writer since #818, D-443)

The Scrolls made to order are the three of D-436: **"You asked"** (an ask order, mode `question`, D-218), **"What if"** and **"Another perspective"** (scenario orders, modes
`what_if` and `perspective`, D-049). They are **switched off in every world** (`KS_MADE_TO_ORDER_ENABLED`, off unless `1`, D-436, #784), and **they have no writer**: the v1 writer
they used is deleted (#818, D-443). They must be rebuilt on the document v3 writer before they can come back; setting the switch alone writes nothing.

- **With the switch off** (the default everywhere) `makeRunScrollProduction(produce, { madeToOrderEnabled })` returns `{ kind: 'skipped', reason: 'made_to_order_off' }` for an `order-…` recipe, and for any job of the
  `content.produce-answer` queue whatever its key says (the consumer passes `madeToOrderQueue`). A skipped delivery is complete: no run, attempt or paid request, and pg-boss does not retry it;
  the worker logs `content.scroll_production_finished` with `outcome: skipped` and `reasonCode: made_to_order_off`. Library recipes are never affected.
- **With the switch on, or for a delivery from before,** an order that reaches `makeProduceScroll` is **refused before any research or request** (`MADE_TO_ORDER_UNAVAILABLE`, `produce.ts`): the job is reserved, then ended as `rejected` with the code `made_to_order_unavailable` in its receipts, and nothing is fetched, asked or stored. A repeated delivery returns the same ended job; the
  take counts as used (`countedTakes`). `made-to-order-unavailable.test.ts` shows it for each of the three modes, and that the fixture model is never called and no page is fetched.
- **What an order's standing now reads.** The recipe key is `order-<32 hex>` (`content.made_to_order_scrolls`); `subject.ts` still resolves it to a `ProductionSubject` (asset and explanation identity, mode, brief, pages), only to say which asset and order the job belongs to. The order-standing reads at the order production version (`scroll-production.v14`: `readMadeToOrderProduction`, the resolver's and the sweeps' reads) read stored rows: an order whose Scroll was admitted before is `published` as before, and an order whose job was ended this way is a rejected take like any other: `retryable` while takes remain (the next take ends the same way) and `stopped` once the three are used (`productionStanding`). A brief wiped by an erasure (empty) is no subject: the job is skipped and nothing is written for erased words.
- **Publication.** An order's Scroll was published with `attribution: 'none'`: `completeWriterPublication` skips the topic projection and the coverage step, so a hypothetical Scroll never grew real-world coverage. A stored one is still read, served and kept.
- **The product rules are in D-443, word for word.** `SCENARIO_RULES` and `QUESTION_RULES` (what the three modes added to the v1 writer's instructions) are copied into the decision entry for a document v3 writer of these Scrolls: the premise stated plainly, every consequence marked as reasoning, the premise's numbers in words, a "limit" ending; the question as data, 8 to 12 sentences, no copied run.

## Writer v3 and the v3 spike (#771)

Status. **Implemented**, covered by unit tests and by integration tests over a CI fixture model and real PostgreSQL. **Not runtime-verified**: no real MiniMax call has been made with these roles. The spike writes no content table and publishes nothing. Production uses `writerRoleV3One` (arm (a)) alone, through `writer-plan.ts` ("Producing a document v3 Scroll" above); the prose and staging roles are the spike's.

The document v3 writer has two arms. Arm (a) writes the whole Scroll in one reply. Arm (b) writes the prose, then a second reply stages it (the pictures, and what each paragraph shows, links and controls). The spike runs both on the same recipes to see which reads better and costs less.

- **`writer-v3-instructions.ts`, `writer-v3-voice.ts`.** The instructions of each step (`writerInstructionsV3(step, plan, reference)`) and the voice examples. The reply shapes, the compile and the repair hints are scroll-model's (`@knowscroll/scroll-model/producer`: `WrittenScrollV3`, `WrittenProseV3`, `WrittenStagingV3`, `compileWrittenV3`, `compileWrittenProseV3`, `mergeStagingV3`, `REPAIR_HINTS_V3`, `writtenReferenceV3`).
- **`writer-v3.ts`.** `writerContextV3` (the recipe's asset and explanation at the job's revision, the library kicker `A closer look`, theme `worlds`, factual framing, the plan's shape and misconception, the passages and pages). `compileGeneratedScrollV3(reply, context, production)` is `compileWrittenV3` plus the writer's own rules: no source or publisher names anywhere a reader reads, and the citation bound of `scroll-provenance.v3` (`citationLimitIssuesV3` in `citation-limits.ts`). `compileStagedScrollV3` puts the staging on the prose first. Three roles: `writerRoleV3One` (`content.scroll-writer`, `scroll-writer-v3a.v4`), `writerRoleV3Prose` (`content.scroll-writer`, `scroll-writer-v3b.v4`) and `stagerRoleV3` (`content.scroll-stager`, `scroll-stager-v3.v4`). Each asks for at most 16,000 tokens with medium effort and a repair that carries the refused answer, and each opts into a second repair for `copied_passage` (`SECOND_REPAIR_CODES_V3`, D-445). The role's schema is the reply's shape with the whole compile as a refinement, so every finding reaches the harness at the path the model wrote it (`items.4.show`, `stage.2.links.0.part`, `pictures.1`). The fixed hints are `REPAIR_HINTS_V3`, the citation hint and one hint per source name. A copy finding names the part and the copied words in the repair notes (`copy-notes-v3.ts`, D-441), for the prose and the whole-Scroll roles; the stager has none (the prose cannot copy, and a copied picture string is named by its path).
- **`spike-v3/`.** `plans.ts` is the spike-only plan table for ten recipes (shape, three section intents and, for five of them, the pictures a drawing kit used to give); `run.ts` runs one recipe in one arm (`makeWriterSpikeV3`); `facts.ts` measures an accepted document; `writer-v3.fixture.ts` is the CI fixture (an invented planet, never product content). The batch runner, the accounting types and the one model a spike accepts are `spike-run.ts` (`runSpikeJobs`, `SPIKE_MODEL`), which the v2 spike held until it was deleted (#815); the support-check replays use it too.
- **Runs.** Purpose `scroll-writer-spike`, policy `scroll-spike.v3`. Arm (a) is one harness run. Arm (b) is two: the prose, and, only when the prose is accepted, the staging of that prose. Run ids come from `newRunId()` and are on the line. Each run allows the harness's repair and the second repair for copies (D-445), so a job sends at most three requests in arm (a) and six in arm (b). The only model is `MiniMax-M3.1-Flash`; a configured model that differs sends nothing, and an attempt whose ledger row names another model makes the job `model_mismatch`. An `unknown` attempt is never resent and its run stays open.
- **Raw replies.** With `rawDir`, every paid attempt writes `<rawDir>/<spike id>/<recipe>.<arm>.<step>.<n>.json` holding `{ key, arm, step, attempt, attemptId, state, model, text }`. `text` is the accepted output serialised again, or the refused answer the harness kept (`null` when it kept none). Nothing from a provider is written anywhere else. The files hold the model's own text about public sources: keep them outside the repository and never paste them into an issue.
- **Operator commands** (worker `writer-spike-v3-operator.ts`, `writer-spike-v3-blind.ts`). `content writer-spike-v3 --topics <keys> --arms <a,b> [--raw-dir <dir>] [--out <file>] [--concurrency <1-4>] [--spike-id <id>]` runs each recipe in each arm. `content writer-spike-v3-blind --in <out file> --page <html file> --key <key file> [--seed <n>]` makes one local page of the accepted documents, shuffled and lettered, with no arm or recipe on it, and a separate key file. How to run and read them: the [operations runbook](../../../../../../docs/v2/operations/scroll-production.md).
- **Reliability.** No model call or network wait inside a transaction, every paid attempt in the attempt ledger and under the production caps, no new table, nothing to erase. A batch starts no new job after a spent budget, an unknown attempt, a refused harness, a model mismatch or two provider failures in a row. A raw file that cannot be written is counted on the line (`rawFilesFailed`) and never fails the job.
- **Known gap.** The prose step's compile adds one placeholder picture (four seconds of reading), so prose of fewer than about 445 words in all, with asides and takeaway, can be refused for reading time (`reading_length_out_of_brief`) though the pictures would bring it inside the brief. The recorded prose of the CI fixture is above that line.

## Reels

Reels are not produced here. A Reel is a request to Cutroom, which has its own service, budget and
queue; its ordering, ledger and publication are in `../README.md` ("Reels from Cutroom").

### Explanation-first Scrolls (D-397)

Implemented while the v2 writer ran (deleted in #815; a document v3 has no calls): writer v22 / production v22 defaults to zero questions and permits at most three optional calls including any Final call. Calls must teach through their reveal. The empty answer-key check passes with zero verdicts and sends no provider request or checker run; ordinary operator review still holds the revision before release. Existing published documents are not rewritten by this policy.
