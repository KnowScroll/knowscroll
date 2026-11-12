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
production root. A v2 library result is held until explicit review releases it.

A repeated delivery resumes the same frozen job. A rejected take can permit a later take;
an unknown paid attempt cannot be resent. Public research and model calls happen outside
transactions. Publication, attribution and coverage commit together; a failed commit cannot
publish only part of that state. The operator and worker share this use case.

Run `pnpm --filter @knowscroll/backend exec vitest run src/modules/content/production` from the
root. Hosted integration and installed-release fixtures exercise the database and consumer graph.
Historical real-model observations are recorded separately in Status; this guide is not a new
provider run or deployment check.

## Producing a v2 Scroll (D-129)

Status: **implemented**, runtime-verified with the labelled CI fixture model on real PostgreSQL; real
real provider generation of the Seasons recipes (D-137) is run by the operator on dev. A v2 library Scroll is **held** at the end of the job and served only after an operator releases it (D-138).

A recipe the library plan marks `scrollV2` (`{variant, misconception}`) is produced by the same job, take
and attempt ledger, with the v2 writer (`writer-v2.ts`) in place of the v1 writer. `writer-plan.ts` is the one
place the two differ: the role the model is asked, and how an accepted answer is compiled into what
admission stores (`stored-v2.ts`: document, `scroll-provenance.v2`, reading facts v3). Still one writer
request and at most one repair, none inside a transaction, and the answer check below sits between the answer and its storage.

- **Versions.** A v2 recipe's jobs are `scroll-production.v22` (paired with `scroll-writer.v22`, D-397; `topics.ts` lists what each version added), every other recipe's and every order's
  `.v14` (`productionVersionOf`). A v2 recipe counts as published only when its current revision is a v2
  document, so a v1 Scroll published earlier is regenerated as the next revision of the same asset.
  A queued job whose version does not match the plan is dropped.
- **Plan refusal.** A recipe whose misconception source label is not `reviewed` is refused at dispatch
  (`plan_refused`, `misconception_source_unreviewed`) before any job is reserved or request sent;
  `production-status` shows it `stopped`. The stored compile refuses it too, should the plan change
  while a job runs.
- **Citation bound.** A Scroll may cite at most 48 different passages (the provenance's bound); the
  validated compile finds it, so the one repair can fix it (`citations_too_many`).
- **Held, not served (D-138).** The same transaction stores the revision held: the asset's current revision does not
  move (a new asset is born `held`), a `content.revision_reviews` row says `held`, and the job records
  `held_for_review`. `production-status` shows `held`; the next take is refused until the operator rejects the
  revision (`reject` spends the take; the next one writes the next revision). The rule is applied where the revision is
  stored (`review-hold.ts`), so no sender can bypass it.
- **Same publication.** Revision, provenance, topic attribution and coverage (`scroll-recipe-coverage.v2`)
  commit in one transaction. `content produce-scroll`, `produce-library` and `production-status` work for v2
  recipes unchanged.

## The answer check and regeneration (S-6a, D-197, D-198)

Status: **implemented**, runtime-verified with the labelled CI fixture model on real PostgreSQL. **Planned:** the first
measurement on real MiniMax, which the coordinator makes on dev when the first wave runs (the check's reply shape and how often it
flags are not yet seen on a real model).

- **The answer check** (`answer-check.ts`, `answer-check-step.ts`, `writer-stage.ts`). For a v2 library recipe, after the writer's
  answer has passed the validator and compiled, the role `content.scroll-answer-check` is shown each call and the Final call (the
  stop before, the question, lettered options, the marked letter, the explanation, the twist) and no source. It replies
  `{calls: [{id, consistent, problem?}]}`, one entry per call in order, a closed shape. **Code decides:** all consistent, or no
  usable answer, stores the Scroll held (the second marked *unchecked*, never released by anything); a flag on the first draft earns
  the writer **one** repair in a run of its own with the problems and its draft as data (and none when the harness already repaired
  the draft for the validator); a flag that stands after it ends the job rejected, nothing stored. A spent budget or quota pauses the
  job; the writer's kept answer is read from the ledger on resume.
- **The bound** is six paid requests a take for a v2 library recipe (`REQUEST_BOUND_V2_PER_TOPIC`): two writer requests and the checker
  once for each of the two drafts, each with at most one repair of an unusable reply. A v1 recipe and an order stay at two, except the
  answer to a person's question, which has fourteen because its support check runs in batches and its revision has a repair of its own, for a length out of range, an opening paragraph taken out whole or a copied run the trim could not place (D-353) (`REQUEST_BOUND_ASK_ORDER`, "The support check of an ask order's answer" below).
- **Runs and receipts.** The checker's runs and the repair's run have ids derived from the job (`stableUuid`), so a redelivery asks the
  ledger instead of paying again. The job closes them all in the transaction that stores or ends it, and when the repair's answer is
  stored it names the repair run as its writer run (`store.useWriterRun`, inside the publication, so a refused publication leaves the job as it was), so provenance and the lineage check agree. Receipts
  (`answer_check`, `draft_flagged` with the superseded run's id) are code-only except the checker's short problems, which are operator
  notes on the private job. A flagged call also keeps its question, options, marked answer and explanation (`FlaggedCall`, nothing else of the draft), so the operator can read what was flagged although that draft is not stored. `answerChecksOf` reads the receipts back; `review-show` and `production-status` show the summary with those calls, and `review-list` the summary without their text.
- **The claim.** A claim is the most requests a take sends times the largest request timeout the transport accepts (`MINIMAX_REQUEST_TIMEOUT_MAX_MS`, 300 s) and the waits around each request (20 s, the reasoning README's rule), plus 180 s for the research and the database steps (`events.ts`). `content.produce-scroll` holds `PRODUCE_SCROLL_CLAIM_SECONDS`, for the six requests of a library recipe: 2,100 s. The answer to a question has a queue of its own, `content.produce-answer`, with `PRODUCE_ANSWER_CLAIM_SECONDS` for its fourteen requests: 4,660 s (D-267, D-297). The payload, the singleton key, the policy and the consumer are the same; only supply's ask path sends to it, so a library recipe whose worker died is still retried after 35 minutes, not 78.
- **Regeneration.** `content regenerate --only <keys>` sends the next take of a v2 recipe whose Scroll is served. `store.create` lets a
  take of a v2 recipe follow a take that was rejected or whose Scroll was released, never one still held or of unknown outcome. A
  recipe has three takes to a **production version**, which is the budget: `SCROLL_PRODUCTION_V2_VERSION` changes whenever the v2
  writer or the job's steps change (`versions.test.ts` pairs it with the writer's version), and the older version's jobs do not count.
  `regenerationStanding` and `planRegeneration` (`domain/library/serving.ts`) are the pure rules.

## The support check of an ask order's answer (S-7b to S-7g, D-250 to D-252, D-263, D-265 to D-267, D-280 to D-282, D-305 to D-316, D-348 to D-355)

Status: **implemented**, runtime-verified with labelled CI fixture models on real PostgreSQL. **Measured on real MiniMax (1 Nov, v3):** every answer checked and both known
errors flagged, but 59 of 101 sentences `unsupported`, almost all sound. **Planned:** v4 and writer v5 are live on dev with S-7d (D-281) and are measured by the same replay right after. The acceptance is in
#605: both known errors stay `unsupported`, the Big O answer has at most three `unsupported` sentences, and the share falls well below a third. If it fails, a revised text is tried as a
candidate file (D-280), and then the next pair is released or v4 and writer v5 are reverted. **S-7e (D-294, D-297):** five real asks on dev then closed on `copied_passage` (four of the six refusals in the ledger were the revision
`question-writer.v5.fix`), so the writer is `question-writer.v6` (still paired with checker v4): the copy rule has a worked example, a copy refusal's repair names each copied run, and the revision has a repair of its own for copying. Implemented; superseded by S-7h below, whose pair is runtime-verified on dev (2 Nov, dev-check-10, `09adb590`: five of five asks Ready, made for the question).
**S-7f (D-305 to D-316, #624):** four of five real asks then ended `support_check_failed`, because every one of about twenty sentences had to pass. The pair is now `question-writer.v7` with `ask-support-check.v5`: the answer is 8 to 12 sentences with standalone openings (code-enforced), three code rules are softer where they misfired, and after the one revision code takes out the sentences that still fail and serves the rest when enough is left. Implemented, CI-verified with labelled fixture models on real PostgreSQL; superseded by S-7h below, whose pair is runtime-verified on dev (2 Nov, dev-check-10, `09adb590`: five of five asks Ready, made for the question).
**S-7g (D-348 to D-355, #636):** on dev (2 Nov, writer v7, checker v5) none of three admitted asks was served: a title or dek the check flagged, a revision refused whole for a copied run, a first draft refused whole. The writer is now `question-writer.v8` (still paired with checker v5): code takes out what it can instead of refusing the draft, before the check. Implemented, CI-verified with labelled fixture models on real PostgreSQL; superseded by S-7h below, whose pair is runtime-verified on dev (2 Nov, dev-check-10, `09adb590`: five of five asks Ready, made for the question).
**S-7h (D-371 to D-376, #645):** on dev (2 Nov, writer v8, checker v5) three of the four failed asks ended `support_drop_no_limit_callout`: the check flagged the limits callout, which says what the answer cannot tell, and no source can support that. The writer is now `question-writer.v9` (still paired with checker v5): code writes the limits callout as one fixed line, puts it last and never sends it to the check. Implemented, CI-verified with labelled fixture models on real PostgreSQL; runtime-verified on dev (2 Nov, dev-check-10, `09adb590`): five of five asks reached Ready, each made for the question. Three of the five answers say the library does not cover what was asked, and the limits line is the same on all five.

- **The check** (`ask-support.ts`, `ask-support-step.ts`, `writer-stage.ts`, `domain/ask-support.ts`). For the answer to a question (mode `question`),
  after the writer's answer has passed the validator and compiled, the role `content.ask-support-check` (`ask-support-check.v5`) is shown the
  passages the answer cites and the answer's numbered sentences as they would be served, after the trim of the draft (a sentence code took out is not shown; a title or dek the trim put in is, D-348, D-351; the limits callout code wrote is never shown, D-371), and no question, brief or stop. The title, the dek, each heading and a callout's title
  are sentences too and rest on everything the answer cites; every other sentence rests on the passages its own block cites, and a quote may come from any passage the answer cites (D-305). The title, the headings
  and the callouts' titles are **labels** (`label: true`). It replies `{sentences: [...]}`, one verdict for each sentence in order: `supported` with a
  quote, `unsupported` with a fixed `kind` and a short problem, or `no_claim`. **What the three mean (D-281):** `supported` is stated by the cited passages, said in other words
  or directly implied (one plain step; putting two of their statements together counts when it says no more than the two mean); `unsupported` is a fact, figure,
  cause, comparison or example they neither state nor imply, a wider scope or stronger word than they use, or what they contradict; `no_claim` adds no fact (a transition, a signpost). A join of two
  statements is supported only when every part is stated. The instructions carry five short invented worked examples, and a test holds that each supported example passes the code rules.
- **Batches (D-267).** A long answer is checked a batch of at most ten sentences at a time (`ASK_SUPPORT_BATCH_SENTENCES`), one request and one run each
  (`askSupportRunId(job, draft, batch)`), in order. A batch carries every passage the whole answer cites (D-305) and keeps its sentences' own numbers. The first
  batch with no usable reply makes the whole check unusable and the later batches are not asked. The harness repairs one unusable reply in the whole
  check, wherever it happens, so a draft costs its batches plus one. An answer of more than four batches (`ASK_SUPPORT_MAX_BATCHES`, 40 sentences) is not checked: `support_check_answer_too_long`, with no request sent.
  An answer of 8 to 12 sentences of reading text has about 15 to 17 in all, labels included, so two batches (the real answers of the 1 Nov check had 21; the ceiling of four stays, since the sections are not capped by code).
- **What code checks, and what it cannot (D-263, D-265, D-266).** Two kinds of rule. **The shape of the reply** refuses it whole (one harness repair): not valid JSON or cut
  off, a verdict that is not well formed, a sentence skipped, repeated or reordered. **Each verdict is judged on its own sentence**, and a verdict that
  breaks a rule makes *that sentence* `unsupported` (kind `not_stated`, a fixed note, the rule's code kept) while every other verdict stands:
  `quote_too_short` (fewer than three words, letters and numbers count, a dash does not; with an ellipsis, two words in each part),
  `quote_not_in_cited_passages` (the quote is not, word for word, in a passage the answer cites: curly or straight quotes, any dash, non-breaking or
  repeated spaces, case, an ellipsis for words left out and `4,096` for `4096` make no difference; with an ellipsis every part must stand in one sentence of the passage and the words left out must hold no negation), `quote_not_about_sentence` (it must carry at least
  two of the sentence's key words: uncommon words of three letters or more, compared by their first five letters, or all of them when there are fewer; **in an ask order's answer** (D-306, D-316) one is enough for a sentence of eight or fewer when the quote has two key words of its own, so "the Sun is" is still refused),
  `no_claim_without_ground` and `too_many_no_claim`. `no_claim` has a ground code can see: a question; a title, heading or callout title of at most four words with no figure (a longer one states something and is judged), or the title of a limits callout ("What this does not explain"); a
  plain admission of a gap that is the *whole sentence* (`namesTheGap`, a small fixed list: "The pages do not say...", "This answer cannot tell...", "That detail
  remains unspecified here"; a sentence with a number, or one that goes on after the admission with a semicolon, "but" or a second clause, is judged); or, **in an ask order's answer only** (D-307, D-316), a figure-free sentence of eight words or fewer; or a longer one that shares no key word with its
  passages. When more than half the sentences of a request are marked `no_claim` on those last, weakest grounds, those sentences are set aside (a request that is only the end of a longer answer may hold one in any case, D-313).
  The two soft rules are `CheckerRules` (`shortNoClaim`, `oneKeyWordAbout`), off by default, which is the check of v4. `askOrderCheckerRole` turns them on and only the ask order's step and the replay use it; a Quick answer and a resident's answer call `askSupportRole` and keep the strict rules, and their checker is not told otherwise (`askSupportInstructions(rules)`, D-316).
  **Whether the quoted words support the sentence is the checker model's judgement**, which code cannot check; it is measured on dev with the replay
  before anything relies on it (D-250, D-252, D-263 to D-267).
- **Code decides.** Nothing unsupported: the Scroll is published. An unsupported sentence, the checker's or one code set aside, earns the writer **one**
  repair in a run of its own (the revision), with the fixed hint of each kind, the sentence's words and the note (the checker's, or the rule's fixed one) as data, and
  its draft, whether or not the harness already repaired the draft for the validator (D-297). The revision has one repair of its own, for a length out of range, an opening paragraph taken out whole or a copied run the trim could not place
  (`repairOnlyFor`, D-353, with the copy notes of D-294); a copying or leaning sentence is taken out by code and costs no repair (D-348, D-349), and any other refusal of the revision ends the job (`support_repair_invalid_output`). The revised draft is checked in turn.
  **A sentence that still fails is taken out, not fatal (D-310).** `ask-support-drop.ts` (`dropFlagged`, pure) removes every sentence still `unsupported` from its text (and every kept sentence that opens with a pointer right after one that was taken out), rebuilds the blocks (a block left with no sentence goes; a list left with one item becomes a paragraph; a section heading with nothing left under it goes; the closing limits callout is code's, has no sentence in the check, is never taken out and belongs to no section, D-371), and `writer-stage.ts` compiles the result as the answer to publish. A flagged title or dek is not taken out but replaced by the line code wrote (D-351), and is no reason to refuse the answer. It is served only if the first paragraph (the direct answer) keeps a **supported** sentence, at least five sentences of reading text are **supported** (labels do not count, nor does a dek code wrote, D-356; `MIN_SERVED_SENTENCES`), the callout code wrote is the last block (`no_limit_callout`, which the check can no longer cause: it fails only for an answer code did not prepare, D-372), and what is left is a valid answer that reads back as exactly the sentences that were kept; otherwise the job ends `support_check_failed` with the reason (`support_drop_<code>`). Nothing is checked again: each sentence served has the verdict it was checked with. The job records `{role: 'checks', kind: 'sentences_dropped', dropped: n, titleReplaced, dekReplaced}` and keeps the answer that was served as its `writer_output`; the replay prints `dropped` (D-311, D-354).
  **A check that gave nothing usable refuses the answer** (`support_check_<code>`; unknown outcome ends the job `unknown`, never resent): no
  one reads an ask order, so it is never served unchecked, unlike a library Scroll (D-198). A spent budget or quota pauses the job, also between two
  batches, and the writer's kept answer and the batches already answered are read from the ledger on resume. The person sees the existing honest state and
  Try again (three takes in all).
- **The bound (D-267, D-297)** is fourteen paid requests a take (`REQUEST_BOUND_ASK_ORDER` = 2 + 1 + 1 + 2 x (4 batches + 1)): the writer and the validator's repair, the revision and its repair (D-353), and for each of the
  two drafts its batches and one repair of an unusable reply. The claim of its own queue is sized for it (`content.produce-answer`, `PRODUCE_ANSWER_CLAIM_SECONDS`, 4,660 s). A job queued before this change keeps the 4,020 s it was sent with.
  `requestBoundOf(key, mode)` needs the order's mode, which only the job knows once it has read the order. The Quick answer (supply) uses the same
  checker in one request and keeps its own bound of six. A room's resident (rooms, D-301) uses it too, in one request, under roles of its own, and has
  the same bound of six.
- **Runs and receipts.** The check's runs (one for each batch of each draft) and the repair's run are derived from the job and closed with it. The
  `support_check` receipts keep sentence numbers, kinds and rule codes only, with the batch count (D-231).
- **Candidate instructions (D-280)** (`ask-support-candidate.ts`, replay only). `content ask-check … --checker-instructions <absolute path>` reads instructions from a file
  (at most 16 KiB of UTF-8 plain text that names all three verdicts and has no `NAME=value` line; an absolute path to a regular file that is not a link, has no link in its path and is not under `/etc`, `/proc` or `/root/.ssh`) and asks the checker with them in place of the production ones, so a change can be measured on dev without a deploy. The role keeps the
  schema, batches and every code rule; its role id is `content.ask-support-check-candidate`, so the ledger's daily budget and failure brake (five failed runs a day) are the candidate's own and a bad
  candidate never stops real ask checks; its ledger version is `ask-support-check.cand-<8 hex of the hash>`. Every line printed or appended says `candidate: true` with the
  file's `candidateSha256`. Production never reads such a file: the step takes a role function that defaults to `askSupportRole` and only the replay passes another, the
  option is refused by every other operator command, and `ask-support-candidate.test.ts` scans the source and fails if any other file names the reader, the role or the option.
  The text of the released version is itself a valid candidate.
- **The replay** (`ask-support-replay.ts`, worker `ask-check-operator.ts`). `content ask-check (--asset <id,…> | --recent <n>) --out <file>` runs
  the same role, in the same batches, over stored answers (the authored answer and the research the job kept), through the production harness, writing
  nothing to content. Counts go to stdout, including how many sentences each rule code set aside and how many `no_claim` verdicts passed on each ground (`codes`) and the batches; sentences, cited passages,
  verdicts and each sentence's rule code go to the file. Runbook: [scroll-production.md](../../../../../../docs/v2/operations/scroll-production.md).
- **The trim before the check (D-348 to D-351, D-353, D-354)** (`ask-answer-trim.ts`, `ask-answer-rebuild.ts`, `WriterPlan.prepare`, pure). The writer's validator and `acceptDraft` both take the draft through `trimAskAnswer` before it is compiled, so the repair is never spent on what code can take out and the support check reads what could be served. It takes out (1) every sentence that holds a word of a run of `COPY_RUN_WORDS` words copied from a passage, found over the words of the whole paragraph, list or callout text so a run that crosses a full stop marks both sentences (the same words and shingles as the compile, `copiedWordMask`); (2) the first sentence of the answer when it begins with This, That, These, Those, It or They, since it leans on nothing; (3) every kept sentence that begins so right after a sentence taken out of its block, until none is left. A leaning sentence whose predecessor stays is never touched. A block left with no sentence goes, a list left with one item becomes a paragraph, a heading with nothing left under it goes. A copied title is replaced by "Your question about" and the title of the Scroll the person asked from (`titleAboutReading`, cut at a word to the title limit, read from the brief's `SCROLL BEING READ` line by `readingTitleOfAskBrief`) or, if that fails the document's own title rule (`DocumentTitle`) or has a figure, a source name or a run of a passage, by `FALLBACK_TITLE`. The person's own question is never put in a title: a title is stored in the revision and the job, which an erasure of the question does not reach (D-351); a copied dek by `NEUTRAL_DEK` (the stored document needs a dek). The only finding of the trim is `direct_answer_lost` (the writer's opening paragraph kept no sentence), with a fixed hint. The job records `{role: 'checks', kind: 'answer_trimmed', draft, copied, leaning, titleReplaced, dekReplaced, limitsReplaced}`, counts only; the replay prints `trimmed` and `limitsReplaced`. The compile still refuses any copied run left (a residual the trim could not place), and the revision's repair covers it (`copied_passage`, with the copy notes of D-294).
- **The limits callout is code's (D-371 to D-376)** (`ask-answer-limits.ts`, a leaf module; `trimAskAnswer`). A sentence about what the answer cannot tell is a claim about the answer itself, and no passage can support it, so asking the check to pass it asked for what cannot be met. The trim therefore takes out every callout of kind `limit` the writer sent, whole and whatever it says, and puts one fixed callout last: the title "Where this stops" (the v3 design's word for the aside; the client draws its "Limits" label) and the text "This answer uses only what the library's sources say. It may not cover every case." It names no subject and no source, and it cites the passages the other blocks cite, so it claims none the answer does not use: the drop closes the answer again over what is left, so it cites only passages that survive, and the compile does not count it toward the four different passages an answer must cite (D-376). An answer whose blocks cite nothing gets none (it is refused for its length anyway). A library Scroll's "Where this stops" aside stays inline, beside the claim it limits; an ask answer's closing line uses the same title and stays last (D-310). Because it has no sentence in `placedSentencesOfAnswer`, it is never sent to the check, never given a verdict, never counted in `readingSentencesOf` or among the five supported sentences, and the drop cannot remove it; code tells it from a writer's callout by its exact kind, title and text (`isCodeMadeLimits`). The writer is told not to write one (`question-writer.v9`) and, in a revision, that the draft it sees has one that code wrote. The what-if, the perspective and the library keep their limits callout and their instructions. The receipt `answer_trimmed` counts `limitsReplaced` (callouts the writer sent, none when it sent none) and never a word of them. Honest bound: the line says only that the answer rests on the library's sources and may not cover every case; where the passages do not give what was asked, the answer's own sentences must say so, and those are checked.
- **The shape of the answer (D-308, D-350)** (`ask-answer-shape.ts`, applied by `compileGeneratedScroll` to the `plain` format, after the trim). The writer is asked for 8 to 12 sentences of reading text (the dek, paragraphs, list items and the text of a callout that is not code's limits line; not the title, a heading or a callout's title); code refuses only an answer, as it would be served, of fewer than 5 (`MIN_SERVED_SENTENCES`) or more than 20, finding `answer_sentences_out_of_brief`, for the draft and the revision alike. The hint names 8 to 12 and is at most 256 characters. A leaning sentence is no finding (D-349). Whether a sentence "stands on its own" in meaning is not something code can check; the opening is the cheap signal.
- **Title and dek that cannot be served (D-351, D-352).** A title or a dek the support check finds unsupported is replaced by the same lines, and is no reason to refuse the answer (`dropFlagged(answer, verdicts, lines)`). When the first draft's only flagged sentences are the title and the dek (`onlyTitleOrDekFlagged`), code tries that drop at once: if it is kept and compiles, the first draft is served with its lines and no revision is paid for; if the floors of D-310 refuse it, the first draft earns its revision as before (D-352). A dek that code wrote counts in no floor of five (D-356). The lines the trim put in are shown to the check like any other sentence; the lines the drop puts in come after the check and are not checked, because they hold only library text and fixed words.
- **Versions.** `question-writer.v9` and `ask-support-check.v5` are a pair (`versions.test.ts`). `SCROLL_PRODUCTION_VERSION` stays `scroll-production.v14`
  because an order has a job of its own and the version is shared with v1 library recipes and what-ifs.

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
- **The version is a hash.** `LIBRARY_SUPPORT_CHECK_VERSION` is `library-support-check.` and eight hex digits of the SHA-256 of the instructions, the rules, the policy and the normalised text of the modules whose code decides what the check says: the ask check's shared judge and instructions
  (`domain/ask-support`, `production/ask-support`), `domain/library-support`, `production/library-support` and `production/library-support-step` (`library-support-version.ts`; comments and layout do not count, code does; it reads the `.js` of a release or the `.ts` of a test). A stored result is keyed by it, so a change to any of them,
  the ask check's shared code included, is a new measurement and never mixes with an old one. Nobody bumps a number.
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

1. **Job.** `makeProduceScroll` reserves one job per `(topic, SCROLL_PRODUCTION_VERSION, take)` in
   `content.scroll_production_runs`, then fetches the recipe's public pages by code, never by the
   model, and freezes them on the job.
2. **Evidence** (`evidence.ts`). The frozen page text is cut into passages of 40 to 600 characters
   at sentence ends and numbered `e1`, `e2`, … (at least four, at most 64). A handle maps to a
   claim ID that hashes the page, passage and span, so a resumed job sees the same evidence.
3. **Writer** (`writer.ts`). One call of the stable role `content.scroll-writer`. It reads the
   brief and the numbered passages and returns plain JSON in the authored shape
   (`scroll-authoring.v1`, `@knowscroll/scroll-model/producer`): title, dek and a flat list of blocks,
   where a heading block starts a section and every other block carries `cites`, the handles it
   rests on. A recipe names the rich block it wants (`interactiveKind`: diagram, simulation, chart,
   comparison, timeline or sequence); the instructions describe only that block and the prose
   blocks. The harness allows one repair, which receives fixed, path-located findings and, because the
   writer opts in (`repairWithPreviousAnswer`), the refused answer as escaped, delimited data in the
   user message so it can revise instead of rewriting. For a copy finding the writer also supplies
   repair notes (`repairNotes`, built by `copyRepairNotes` in `copy-repair.ts` for both writers, D-294):
   for each block the check refused, the passage words it repeats, cut from the research text with the
   same check that refused the answer (never the model's words) and sent in a `<repair-notes>` block
   with the block reference only. At most six runs of twenty words are shown, every block named by its
   first run before any gets a second (blocks with no room are named, twelve at most, then counted), always within the harness's `MAX_REPAIR_NOTES_CHARS`, and the repair
   is asked to rebuild those sentences in its own words, keeping the key terms. The nine-word rule
   (`COPY_RUN_WORDS`) is unchanged and is the one number the check, the instructions, the hints and the
   notes read. Implemented; superseded by S-7h above, whose pair is runtime-verified on dev (2 Nov, dev-check-10, `09adb590`: five of five asks Ready, made for the question).
4. **Compile** (`compileGeneratedScroll`). Code converts the authored document into the canonical
   draft, derives the claim bindings from the citations and runs every check: structure, the
   simulation grid proof, numbers (a figure must appear in a passage the block cites; a chart plots
   only such figures), copy limits (no nine words in a row from the sources), reading length (two to
   eight minutes), no source or publisher names, the requested block is present, and stored-document
   admission. Findings are reported at the block the writer wrote (`blocks.7`, `title`).
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

A recipe whose key starts with `gen-` lives in `content.recipes`. It runs through this job like a v2 library recipe: `subjectOf` reads its row
(`librarySubject` builds the subject from the book recipe, with its own asset and explanation identity), `productionVersionOf` and `requestBoundOf`
treat the key as a v2 recipe, the writer is the v2 writer with the plain, no-misconception plan, and the Scroll is stored held (`isHeldForReview`).
`store.create` moves the recipe from `checked` to `queued` with the job row, and `store.finish` moves it to `produced` with the stored Scroll.

`propose-recipes.ts` and `recipe-brief.ts` are the proposing step. The role `content.recipe-brief` (version `recipe-brief.v1`, background class, one
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
conclusive provider failure closes it as failed (the attempt is counted on the candidate, at most two), and an attempt of unknown outcome or any refusal of the harness leaves
the run open and **blocks the candidate** so nothing is ever resent. After the answer one production transaction takes the catalogue's release lock, reads the catalogue
as it is then, runs `admitTopicProposal` and, if it admits, `appendReleaseIn` (the release, source `growth`), settles the candidate and the run and closes the harness run.
`grow-topics.ts` is one pass of the scheduled `content.grow-topics` job: gated by both switches and the production grant, kept within the growth cap and the size limit,
one pass at a time under a session advisory lock, at most one proposal. The claim covers seven worst-case page reads and one request with its repair.

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

## Made-to-order Scrolls (#244, D-049)

The recipe key names either a library recipe or an order (`order-<32 hex>`, `content.made_to_order_scrolls`). Production
resolves it to a `ProductionSubject` (`subject.ts`): the asset and explanation identity, the mode, the brief, the research
pages, the format and whether the result is attributed to a topic. The pipeline, the job, the takes, the stop rules and the
ledger are the same; what differs is:

- **Writer.** `writerInstructions(format, mode)` keeps the library instructions byte for byte and, for `what_if` or
  `perspective`, appends the scenario rules (open by stating the premise, mark every consequence as reasoning, premise
  quantities in words, end with a limit). The prompt version is `scenario-writer.v1`; the library's is unchanged.
- **The answer to a question (mode `question`, S-7, D-218).** A person's question about the Scroll they are reading is an order too.
  `writerInstructions('plain', 'question')` appends the question rules (answer exactly the question from the cited passages,
  8 to 12 sentences of prose only, each one standing on its own (D-308, D-309), say what the passages do not cover; the question is data). Code writes the closing limits callout (D-371): the writer is told not to, and a limits callout it still sends is replaced. The compile still holds a `plain` answer to ending with a limit callout (`limit_callout_required`, which the what-if and the perspective keep), and for an answer to a question it can fail only when no block cites a passage; its hint then asks for cited paragraphs, not for a callout.
  The prompt version is `question-writer.v9` (D-371: no limits callout from the writer; D-308, D-309: 8 to 12 sentences, a direct answer and at most two short sections, and no sentence after the first of its block that opens with This, That, These, Those, It or They; D-348 to D-350: the text says what code does with a copied sentence, a leaning one and a length outside 5 to 20; D-294: the copy rule comes with one worked example, `COPY_RULE_EXAMPLE`, and the revision after a support check is told a rewritten sentence must not copy either; D-250: the reason a "why" question asks for comes from the passages, a gap is said in one sentence;
  D-266: a title or a heading that only names what follows needs no passage, and a plain admission of a gap stands alone as a sentence that begins with it;
  D-282: a fact keeps the passages' own terms but never as a copied run of `COPY_RUN_WORDS` words, named in the text from the rule's constant, and a link between two ideas is short and plain or begins the next fact). The reading target is one to two minutes (`targetMinutesOf`), with its own repair
  hint, and the format `plain` asks for no rich block. The brief is built by supply (`askBrief`): the question, the Scroll's title and
  the words of the stop. It is written with the v1 writer and published as an order, so it never goes through the review gate (D-138).
  A brief wiped by an erasure (empty) is no subject: the job is skipped and nothing is written for erased words.
- **Identity.** The kicker and the framing come from the order (copied by code, never written by the model).
- **Publication.** An order publishes with `attribution: 'none'`: `completeWriterPublication` skips the topic projection and
  the coverage step, so a hypothetical Scroll never grows real-world coverage. An unknown order key is
  `unknown_recipe` and does nothing.

## Writer v15 and the v2 spike (S-0 and S-1a, D-120 to D-126)

Status. **Implemented** and covered by unit tests and by an integration test of the command over a CI fixture model and real PostgreSQL. v14 was **runtime-verified** on real MiniMax in the S-0 spike (#471, D-123). v15 (S-1a) is implemented and **not yet re-measured** on real MiniMax: the runbook has the command line for the Seasons parts. **Planned**: publishing a v2 Scroll (admission, storage and coverage v2 are slices S-1 and S-2); until then v14 and v15 never write to a content table, and `scroll-writer.v13` still produces the library.

- **`writer-v2.ts`.** Writer prompt `scroll-writer.v21` for `scroll-authoring.v2` (`@knowscroll/scroll-model/producer`): `writerInstructionsV2(recipe)`, `writerRoleV2(context)` and `compileGeneratedScrollV2`. The role id is `content.scroll-writer`, as for v13. The instructions are misconception first (the recipe's myth is named; the first Call it tests it), second person, stops of at most 60 words, two or three Call its and one Final call, a limits aside before the Final call, a `simple` text per stop, 700 to 850 words, and the v13 rules about copying, figures and source names. For a stage recipe they describe the picture from the recipe's own kit (`stageKit`, D-194): what it draws, its keys and words and what code derives (for Earth & sky the view, month, Moon phase and focus, with the tilt, pins and Ray derived; for the Human body kits of D-201 the point of the beat and the valves, or the point of the spike and the channels), and they say that a call never changes the picture and that the stop after a call shows its answer; for Earth & sky they also say that Earth's axis is tilted and never sideways (the authoring rules refuse a stage text that says so); for a plain recipe they say there is no picture. In the myth call the correct option is first and the wrong option that states the myth is second (no number to count); the Final call must be a new case (D-124 to D-126). For a recipe whose plan hands the reader Earth's tilt (`finalCall: tilt`, D-187) they also ask for a "what if the axis were not tilted" Final call and for a last picture in June or December; code adds the slider, the binding and the landmark (D-188), and admission refuses a bound Scroll whose stage ends in March, in September or on the Moon view, where turning the tilt changes nothing (`final_call_binding_invalid`). For a recipe whose plan names play blocks or a guide (`blocks` and `guide` on `scrollV2`, D-207) they add a section for each block, with the rules about figures of D-208 (a figure exactly as the passage writes it, a word such as "million" as `magnitude`, never converted, rounded or filled in), and a guide section (Ray speaks at most twice, a line at most 25 words, cited like the stop it sits on); a recipe that names none gets the v19 text unchanged. The brief's words about diagrams, sliders and steppers are to be ignored, except where the recipe names the block. Status of the blocks: **implemented**, not yet runtime-verified (the spike `blocks-v20`).
- **The stage plan of a recipe (D-382 to D-384; status: implemented, CI-verified with a labelled fixture model on real PostgreSQL; runtime-verified on dev is the coordinator's next check).** A recipe's `scrollV2.stagePlan` (`orbitMonths`, `figures`, `reveal`) is what a person asks of its picture beyond the kit's words, as `blocks` are asked. `writerInstructionsV2` adds one paragraph for each ask and `authoringReferenceV2` the syntax of `figures` (on a stop) and `revealsNext` (on a `call_it`); a recipe with no plan gets the text it had. Code checks after assembling: `stage_months_too_few` (the orbit views stand at fewer months than asked, so the recap of D-368 could not draw) and `call_reveal_missing`, each with a fixed repair hint. A figure is never refused: `compileAuthoredV2` leaves out every figure the cited passages of its stop do not state (D-208 rules, and the word of its slot beside it), reports them as `leftOut`, and `storedScrollV2` records a private provenance check `stage-figures` with `stage_figure_left_out`. So a recipe whose pages do not carry a figure gets a Scroll without it and costs no repair. Today only `seasons` has a plan; its one page states the distances in miles and no hours of daylight (D-382). `review-show` prints each picture with its figures and the picture a wrong pick turns to.
- **Checks.** The producer's (`compileAuthoredV2`: word limits, call budget, Final call, limits aside, stage, citations, figures, copying, reading time, document validation) plus the writer's own: no source or publisher names (the same fixed list as v13). The repair catalogue is `REPAIR_HINTS_V2` plus one hint per source name. One repair, carrying the refused answer and, for copying, the copied words (`<repair-notes>`), as in v13.
- **`spike-v2/`.** The operator's spike. `topics.ts` holds the 20 recipes, the Seasons line (`SEASONS_SPIKE_TOPICS_V2`), the eight sky-kit recipes (`SKY_SPIKE_TOPICS_V2`, D-194), the five Space-kit recipes (`SPACE_SPIKE_TOPICS_V2`, D-204) and what the spike decides for them: stage or plain, and the kit, come from the recipe's own `stageKit` (D-125), the misconception is the spike's table (D-122); `run.ts` runs a topic (`makeWriterSpikeV2`) and a batch (`runSpikeBatch`); `writer-v2.fixture.ts` is the CI fixture (an invented planet, never product content).
- **Operator command.** `content writer-spike-v2 --topics <keys> [--out <file>] [--concurrency <1-4>] [--spike-id <id>]` (worker `writer-spike-operator.ts`; how to run and read it: [operations runbook](../../../../../../docs/v2/operations/scroll-production.md)). For each recipe: research by code, the v15 writer through the production harness (one request and at most one repair), validate, assemble. It admits and publishes nothing and creates no table.
- **Reliability.** No model call or network wait is inside a transaction: research is fetched first, the harness owns its own short transactions, and the production scope is entered only to read the run's accounting and to close it. Every paid attempt is in the attempt ledger and counts against the production caps; an unknown attempt is never resent and its run stays open. The batch starts no new topic after a spent budget or quota, an unknown attempt, a refused harness, a model other than `MiniMax-M3.1-Flash`, or two provider failures in a row. Authority is the production root, rechecked by the harness.
- **Failure and recovery.** A topic that stops early is simply run again with `--topics` naming what is left; each run is a new business run. The refused answers of a topic stay readable for 30 days with `reasoning rejected --attempt <id>` (the line prints the attempt ids).
- **Tables, jobs, erasure.** None added. The command uses `reasoning.production_runs`, `production_attempts` and `production_rejected_answers`, and reads no content table apart from the library plan in code. Erasure: nonpersonal, nothing to erase.

## Reels

Reels are not produced here. A Reel is a request to Cutroom, which has its own service, budget and
queue; its ordering, ledger and publication are in `../README.md` ("Reels from Cutroom").

### Explanation-first Scrolls (D-397)

Implemented: writer v22 / production v22 defaults to zero questions and permits at most three optional calls including any Final call. Calls must teach through their reveal. The empty answer-key check passes with zero verdicts and sends no provider request or checker run; ordinary operator review still holds the revision before release. Existing published documents are not rewritten by this policy.
