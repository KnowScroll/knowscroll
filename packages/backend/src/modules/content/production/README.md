# Scroll production

Writer roles belong to content (blueprint §§11, 15). `production/` owns the evidence packaging, the
writer's instructions and checks, the job state and the application of a result.
`infrastructure/research` owns the public HTTP boundary, and the shared reasoning engine keeps
transport, admission and the external attempt ledger.

Status: the pipeline below is **implemented** and has been **runtime-verified** with real
`MiniMax-M3.1-Flash` calls against a local database (summaries in the pull requests for #232 and
#239). It runs as worker jobs (next section). Not yet running on dev.

## Producing a v2 Scroll (D-129)

Status: **implemented**, runtime-verified with the labelled CI fixture model on real PostgreSQL; real
real provider generation of the Seasons recipes (D-137) is run by the operator on dev. A v2 library Scroll is **held** at the end of the job and served only after an operator releases it (D-138).

A recipe the library plan marks `scrollV2` (`{variant, misconception}`) is produced by the same job, take
and attempt ledger, with the v2 writer (`writer-v2.ts`) in place of the v1 writer. `writer-plan.ts` is the one
place the two differ: the role the model is asked, and how an accepted answer is compiled into what
admission stores (`stored-v2.ts`: document, `scroll-provenance.v2`, reading facts v3). Still one writer
request and at most one repair, none inside a transaction, and the answer check below sits between the answer and its storage.

- **Versions.** A v2 recipe's jobs are `scroll-production.v18`, every other recipe's and every order's
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
  answer to a person's question, which has twelve because its support check runs in batches (`REQUEST_BOUND_ASK_ORDER`, "The support check of an ask order's answer" below).
- **Runs and receipts.** The checker's runs and the repair's run have ids derived from the job (`stableUuid`), so a redelivery asks the
  ledger instead of paying again. The job closes them all in the transaction that stores or ends it, and when the repair's answer is
  stored it names the repair run as its writer run (`store.useWriterRun`, inside the publication, so a refused publication leaves the job as it was), so provenance and the lineage check agree. Receipts
  (`answer_check`, `draft_flagged` with the superseded run's id) are code-only except the checker's short problems, which are operator
  notes on the private job. A flagged call also keeps its question, options, marked answer and explanation (`FlaggedCall`, nothing else of the draft), so the operator can read what was flagged although that draft is not stored. `answerChecksOf` reads the receipts back; `review-show` and `production-status` show the summary with those calls, and `review-list` the summary without their text.
- **The claim.** `content.produce-scroll` holds its claim `PRODUCE_SCROLL_CLAIM_SECONDS` (`events.ts`): the most requests any take sends (twelve, for the answer to a question, D-267) times the largest request timeout the transport accepts (`MINIMAX_REQUEST_TIMEOUT_MAX_MS`, 300 s) and the waits around each request (20 s, the reasoning README's rule), plus 180 s for the research and the database steps: 4,020 s today. A library recipe sends six.
- **Regeneration.** `content regenerate --only <keys>` sends the next take of a v2 recipe whose Scroll is served. `store.create` lets a
  take of a v2 recipe follow a take that was rejected or whose Scroll was released, never one still held or of unknown outcome. A
  recipe has three takes to a **production version**, which is the budget: `SCROLL_PRODUCTION_V2_VERSION` changes whenever the v2
  writer or the job's steps change (`versions.test.ts` pairs it with the writer's version), and the older version's jobs do not count.
  `regenerationStanding` and `planRegeneration` (`domain/library/serving.ts`) are the pure rules.

## The support check of an ask order's answer (S-7b and S-7c, D-250 to D-252, D-263, D-265 to D-267)

Status: **implemented**, runtime-verified with labelled CI fixture models on real PostgreSQL. **Planned:** the second measurement on real
MiniMax, which the coordinator makes on dev with `content ask-check` over the five real answers of #580 and #591 (how many are checked, whether the
checker flags the two known faulty sentences, how many sentences code sets aside, and by which rule).

- **The check** (`ask-support.ts`, `ask-support-step.ts`, `writer-stage.ts`, `domain/ask-support.ts`). For the answer to a question (mode `question`),
  after the writer's answer has passed the validator and compiled, the role `content.ask-support-check` (`ask-support-check.v3`) is shown the
  passages the answer cites and the answer's numbered sentences, and no question, brief or stop. The title, the dek, each heading and a callout's title
  are sentences too and rest on everything the answer cites; every other sentence rests on the passages its own block cites. The title, the headings
  and the callouts' titles are **labels** (`label: true`). It replies `{sentences: [...]}`, one verdict for each sentence in order: `supported` with a
  quote, `unsupported` with a fixed `kind` and a short problem, or `no_claim`.
- **Batches (D-267).** A long answer is checked a batch of at most ten sentences at a time (`ASK_SUPPORT_BATCH_SENTENCES`), one request and one run each
  (`askSupportRunId(job, draft, batch)`), in order. A batch carries the passages its own sentences cite and keeps its sentences' own numbers. The first
  batch with no usable reply makes the whole check unusable and the later batches are not asked. The harness repairs one unusable reply in the whole
  check, wherever it happens, so a draft costs its batches plus one. An answer of more than four batches (`ASK_SUPPORT_MAX_BATCHES`, 40 sentences; the
  real answers of the 1 Nov check had 21) is not checked: `support_check_answer_too_long`, with no request sent.
- **What code checks, and what it cannot (D-263, D-265, D-266).** Two kinds of rule. **The shape of the reply** refuses it whole (one harness repair): not valid JSON or cut
  off, a verdict that is not well formed, a sentence skipped, repeated or reordered. **Each verdict is judged on its own sentence**, and a verdict that
  breaks a rule makes *that sentence* `unsupported` (kind `not_stated`, a fixed note, the rule's code kept) while every other verdict stands:
  `quote_too_short` (fewer than three words, letters and numbers count, a dash does not; with an ellipsis, two words in each part),
  `quote_not_in_cited_passages` (the quote is not, word for word, in a passage that sentence cites: curly or straight quotes, any dash, non-breaking or
  repeated spaces, case, an ellipsis for words left out and `4,096` for `4096` make no difference), `quote_not_about_sentence` (it must carry at least
  two of the sentence's key words: uncommon words of three letters or more, compared by their first five letters, or all of them when there are fewer),
  `no_claim_without_ground` and `too_many_no_claim`. `no_claim` has a ground code can see: a question; a title, heading or callout title of at most four words with no figure (a longer one states something and is judged), or the title of a limits callout ("What this does not explain"); a
  plain admission of a gap that is the *whole sentence* (`namesTheGap`, a small fixed list: "The pages do not say...", "This answer cannot tell...", "That detail
  remains unspecified here"; a sentence with a number, or one that goes on after the admission with a semicolon, "but" or a second clause, is judged); or a figure-free sentence that shares no key word with its
  passages. When more than half the sentences of a request are marked `no_claim` on that last, weakest ground, those sentences are set aside.
  **Whether the quoted words support the sentence is the checker model's judgement**, which code cannot check; it is measured on dev with the replay
  before anything relies on it (D-250, D-252, D-263 to D-267).
- **Code decides.** Nothing unsupported: the Scroll is published. An unsupported sentence, the checker's or one code set aside, earns the writer **one**
  repair in a run of its own, with the fixed hint of each kind, the sentence's words and the note (the checker's, or the rule's fixed one) as data, and
  its draft (none when the harness already repaired the draft for the validator). The repaired draft is checked in turn; a sentence that stands ends
  the job rejected (`support_check_failed`).
  **A check that gave nothing usable refuses the answer** (`support_check_<code>`; unknown outcome ends the job `unknown`, never resent): no
  one reads an ask order, so it is never served unchecked, unlike a library Scroll (D-198). A spent budget or quota pauses the job, also between two
  batches, and the writer's kept answer and the batches already answered are read from the ledger on resume. The person sees the existing honest state and
  Try again (three takes in all).
- **The bound (D-267)** is twelve paid requests a take (`REQUEST_BOUND_ASK_ORDER` = 2 + 2 x (4 batches + 1)): the writer once and one repair, and for each of the
  two drafts its batches and one repair of an unusable reply. The claim is sized for it (`PRODUCE_SCROLL_CLAIM_SECONDS`, 4,020 s).
  `requestBoundOf(key, mode)` needs the order's mode, which only the job knows once it has read the order. The Quick answer (supply) uses the same
  checker in one request and keeps its own bound of six.
- **Runs and receipts.** The check's runs (one for each batch of each draft) and the repair's run are derived from the job and closed with it. The
  `support_check` receipts keep sentence numbers, kinds and rule codes only, with the batch count (D-231).
- **The replay** (`ask-support-replay.ts`, worker `ask-check-operator.ts`). `content ask-check (--asset <id,…> | --recent <n>) --out <file>` runs
  the same role, in the same batches, over stored answers (the authored answer and the research the job kept), through the production harness, writing
  nothing to content. Counts go to stdout, including how many sentences each rule code set aside (`codes`) and the batches; sentences, cited passages,
  verdicts and each sentence's rule code go to the file. Runbook: [scroll-production.md](../../../../../../docs/v2/operations/scroll-production.md).
- **Versions.** `question-writer.v4` and `ask-support-check.v3` are a pair (`versions.test.ts`). `SCROLL_PRODUCTION_VERSION` stays `scroll-production.v14`
  because an order has a job of its own and the version is shared with v1 library recipes and what-ifs.

## Jobs, takes and who sends them

Production is the `content.produce-scroll` job (`events.ts`), one per **recipe, recipe version and
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
   repair notes (`repairNotes`): the copied words themselves, cut from the research text with the same
   check that refused the answer and sent in a `<repair-notes>` block, so the repair rewrites only
   those sentences. The nine-word rule is unchanged.
4. **Compile** (`compileGeneratedScroll`). Code converts the authored document into the canonical
   draft, derives the claim bindings from the citations and runs every check: structure, the
   simulation grid proof, numbers (a figure must appear in a passage the block cites; a chart plots
   only such figures), copy limits (no nine words in a row from the sources), reading length (two to
   eight minutes), no source or publisher names, the requested block is present, and stored-document
   admission. Findings are reported at the block the writer wrote (`blocks.7`, `title`).
5. **Publish.** In one transaction under the production root: close the writer run, store the
   immutable revision and its private provenance, mark the job published and project the topic.

Numbers and quotations are checked mechanically; they do not prove that a sentence is entailed by
its passage. Human sampling of generated Scrolls is still required.

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
| `reasoning.production_*` (0013, 0050) | The writer run, every possible paid attempt, and the refused answers kept 30 days for diagnosis | Stable writer run UUID | Harness retention and liability policy |

Lock order: production root → production job row → asset advisory lock → asset rows. Short
transactions freeze or apply data; no model or HTTP wait holds one. Every rejection and the final
write require their expected stage under the root and job lock, so a delayed delivery reports the
advanced job instead of acting on it. `--resume` continues the same frozen research and the same
writer run through the ledger after a crash. An unknown attempt stays unknown and is never resent.
A rerun reports the existing state; a terminal rejection stays rejected for its take. A changed recipe is
a new `SCROLL_PRODUCTION_VERSION` (and `WRITER_PROMPT_VERSION`), never an edit of an old job.

When a Scroll fails, `reasoning rejected` lists the refused answers with the validator's findings
(`packages/backend/src/reasoning/README.md`); that is where to look first.

Jobs: `content.produce-scroll` (above). Notices: none. Erasure: nonpersonal supply, nothing to erase.
Operator steps: `docs/v2/operations/scroll-production.md`.

The recipes the producer runs are the library plan in `../domain/library/` (one file per topic
system); `topics.ts` is only its index. The recipe key, the brief, the research pages and the
interactive block kind (`interactiveKind`) all come from the plan. Neither private research nor
provenance is reachable through content's client-facing read ports.

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

Two things are then written in that same transaction, both decided by code from the recipe in
`TOPICS` (the library plan in `domain/library/`, D-033):

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
  about 230 to 340 words in prose only, say what the passages do not cover, end with a limit callout; the question is data). Code enforces the ending: an answer whose last block is not the limit callout is refused (`limit_callout_required`, with a fixed repair hint).
  The prompt version is `question-writer.v4` (D-250: the reason a "why" question asks for comes from the passages, a gap is said in one sentence;
  D-266: a title or a heading that only names what follows needs no passage, and a plain admission of a gap stands alone as a sentence that begins with it). The reading target is one to two minutes (`targetMinutesOf`), with its own repair
  hint, and the format `plain` asks for no rich block. The brief is built by supply (`askBrief`): the question, the Scroll's title and
  the words of the stop. It is written with the v1 writer and published as an order, so it never goes through the review gate (D-138).
  A brief wiped by an erasure (empty) is no subject: the job is skipped and nothing is written for erased words.
- **Identity.** The kicker and the framing come from the order (copied by code, never written by the model).
- **Publication.** An order publishes with `attribution: 'none'`: `completeWriterPublication` skips the topic projection and
  the coverage step, so a hypothetical Scroll never grows real-world coverage. An unknown order key is
  `unknown_recipe` and does nothing.

## Writer v15 and the v2 spike (S-0 and S-1a, D-120 to D-126)

Status. **Implemented** and covered by unit tests and by an integration test of the command over a CI fixture model and real PostgreSQL. v14 was **runtime-verified** on real MiniMax in the S-0 spike (#471, D-123). v15 (S-1a) is implemented and **not yet re-measured** on real MiniMax: the runbook has the command line for the Seasons parts. **Planned**: publishing a v2 Scroll (admission, storage and coverage v2 are slices S-1 and S-2); until then v14 and v15 never write to a content table, and `scroll-writer.v13` still produces the library.

- **`writer-v2.ts`.** Writer prompt `scroll-writer.v20` for `scroll-authoring.v2` (`@knowscroll/scroll-model/producer`): `writerInstructionsV2(recipe)`, `writerRoleV2(context)` and `compileGeneratedScrollV2`. The role id is `content.scroll-writer`, as for v13. The instructions are misconception first (the recipe's myth is named; the first Call it tests it), second person, stops of at most 60 words, two or three Call its and one Final call, a limits aside before the Final call, a `simple` text per stop, 700 to 850 words, and the v13 rules about copying, figures and source names. For a stage recipe they describe the picture from the recipe's own kit (`stageKit`, D-194): what it draws, its keys and words and what code derives (for Earth & sky the view, month, Moon phase and focus, with the tilt, pins and Ray derived; for the Human body kits of D-201 the point of the beat and the valves, or the point of the spike and the channels), and they say that a call never changes the picture and that the stop after a call shows its answer; for Earth & sky they also say that Earth's axis is tilted and never sideways (the authoring rules refuse a stage text that says so); for a plain recipe they say there is no picture. In the myth call the correct option is first and the wrong option that states the myth is second (no number to count); the Final call must be a new case (D-124 to D-126). For a recipe whose plan hands the reader Earth's tilt (`finalCall: tilt`, D-187) they also ask for a "what if the axis were not tilted" Final call and for a last picture in June or December; code adds the slider, the binding and the landmark (D-188), and admission refuses a bound Scroll whose stage ends in March, in September or on the Moon view, where turning the tilt changes nothing (`final_call_binding_invalid`). For a recipe whose plan names play blocks or a guide (`blocks` and `guide` on `scrollV2`, D-207) they add a section for each block, with the rules about figures of D-208 (a figure exactly as the passage writes it, a word such as "million" as `magnitude`, never converted, rounded or filled in), and a guide section (Ray speaks at most twice, a line at most 25 words, cited like the stop it sits on); a recipe that names none gets the v19 text unchanged. The brief's words about diagrams, sliders and steppers are to be ignored, except where the recipe names the block. Status of the blocks: **implemented**, not yet runtime-verified (the spike `blocks-v20`).
- **Checks.** The producer's (`compileAuthoredV2`: word limits, call budget, Final call, limits aside, stage, citations, figures, copying, reading time, document validation) plus the writer's own: no source or publisher names (the same fixed list as v13). The repair catalogue is `REPAIR_HINTS_V2` plus one hint per source name. One repair, carrying the refused answer and, for copying, the copied words (`<repair-notes>`), as in v13.
- **`spike-v2/`.** The operator's spike. `topics.ts` holds the 20 recipes, the Seasons line (`SEASONS_SPIKE_TOPICS_V2`), the eight sky-kit recipes (`SKY_SPIKE_TOPICS_V2`, D-194), the five Space-kit recipes (`SPACE_SPIKE_TOPICS_V2`, D-204) and what the spike decides for them: stage or plain, and the kit, come from the recipe's own `stageKit` (D-125), the misconception is the spike's table (D-122); `run.ts` runs a topic (`makeWriterSpikeV2`) and a batch (`runSpikeBatch`); `writer-v2.fixture.ts` is the CI fixture (an invented planet, never product content).
- **Operator command.** `content writer-spike-v2 --topics <keys> [--out <file>] [--concurrency <1-4>] [--spike-id <id>]` (worker `writer-spike-operator.ts`; how to run and read it: [operations runbook](../../../../../../docs/v2/operations/scroll-production.md)). For each recipe: research by code, the v15 writer through the production harness (one request and at most one repair), validate, assemble. It admits and publishes nothing and creates no table.
- **Reliability.** No model call or network wait is inside a transaction: research is fetched first, the harness owns its own short transactions, and the production scope is entered only to read the run's accounting and to close it. Every paid attempt is in the attempt ledger and counts against the production caps; an unknown attempt is never resent and its run stays open. The batch starts no new topic after a spent budget or quota, an unknown attempt, a refused harness, a model other than `MiniMax-M3.1-Flash`, or two provider failures in a row. Authority is the production root, rechecked by the harness.
- **Failure and recovery.** A topic that stops early is simply run again with `--topics` naming what is left; each run is a new business run. The refused answers of a topic stay readable for 30 days with `reasoning rejected --attempt <id>` (the line prints the attempt ids).
- **Tables, jobs, erasure.** None added. The command uses `reasoning.production_runs`, `production_attempts` and `production_rejected_answers`, and reads no content table apart from the library plan in code. Erasure: nonpersonal, nothing to erase.

## Reels

Reels are not produced here. A Reel is a request to Cutroom, which has its own service, budget and
queue; its ordering, ledger and publication are in `../README.md` ("Reels from Cutroom").
