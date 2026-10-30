# Scroll production

Writer roles belong to content (blueprint §§11, 15). `production/` owns the evidence packaging, the
writer's instructions and checks, the job state and the application of a result.
`infrastructure/research` owns the public HTTP boundary, and the shared reasoning engine keeps
transport, admission and the external attempt ledger.

Status: the pipeline below is **implemented** and has been **runtime-verified** with real
`MiniMax-M3.1-Flash` calls against a local database (summaries in the pull requests for #232 and
#239). It runs as worker jobs (next section). Not yet running on dev.

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
a published job or an unknown attempt, and never past three takes. Each take is its own business run with
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
- **Identity.** The kicker and the framing come from the order (copied by code, never written by the model).
- **Publication.** An order publishes with `attribution: 'none'`: `completeWriterPublication` skips the topic projection and
  the coverage step, so a hypothetical Scroll never grows real-world coverage. An unknown order key is
  `unknown_recipe` and does nothing.

## Writer v15 and the v2 spike (S-0 and S-1a, D-120 to D-126)

Status. **Implemented** and covered by unit tests and by an integration test of the command over a CI fixture model and real PostgreSQL. v14 was **runtime-verified** on real MiniMax in the S-0 spike (#471, D-123). v15 (S-1a) is implemented and **not yet re-measured** on real MiniMax: the runbook has the command line for the Seasons parts. **Planned**: publishing a v2 Scroll (admission, storage and coverage v2 are slices S-1 and S-2); until then v14 and v15 never write to a content table, and `scroll-writer.v13` still produces the library.

- **`writer-v2.ts`.** Writer prompt `scroll-writer.v15` for `scroll-authoring.v2` (`@knowscroll/scroll-model/producer`): `writerInstructionsV2(recipe)`, `writerRoleV2(context)` and `compileGeneratedScrollV2`. The role id is `content.scroll-writer`, as for v13. The instructions are misconception first (the recipe's myth is named; the first Call it tests it), second person, stops of at most 60 words, two or three Call its and one Final call, a limits aside before the Final call, a `simple` text per stop, 700 to 850 words, and the v13 rules about copying, figures and source names. For a stage recipe they also describe the four stage choices (view, month, Moon phase, focus; code derives the tilt, pins and Ray), say that a call never changes the picture and that the stop after a call shows its answer, and say that a recipe about another world gets Earth for comparison; for a plain recipe they say there is no picture. In the myth call the correct option is first and the wrong option that states the myth is second (no number to count); the Final call must be a new case (D-124 to D-126). The brief's words about diagrams, sliders and steppers are to be ignored.
- **Checks.** The producer's (`compileAuthoredV2`: word limits, call budget, Final call, limits aside, stage, citations, figures, copying, reading time, document validation) plus the writer's own: no source or publisher names (the same fixed list as v13). The repair catalogue is `REPAIR_HINTS_V2` plus one hint per source name. One repair, carrying the refused answer and, for copying, the copied words (`<repair-notes>`), as in v13.
- **`spike-v2/`.** The operator's spike. `topics.ts` holds the 20 recipes, the Seasons line (`SEASONS_SPIKE_TOPICS_V2`) and what the spike decides for them: stage or plain comes from the recipe's own `stageKit` (D-125), the misconception is the spike's table (D-122); `run.ts` runs a topic (`makeWriterSpikeV2`) and a batch (`runSpikeBatch`); `writer-v2.fixture.ts` is the CI fixture (an invented planet, never product content).
- **Operator command.** `content writer-spike-v2 --topics <keys> [--out <file>] [--concurrency <1-4>] [--spike-id <id>]` (worker `writer-spike-operator.ts`; how to run and read it: [operations runbook](../../../../../../docs/v2/operations/scroll-production.md)). For each recipe: research by code, the v15 writer through the production harness (one request and at most one repair), validate, assemble. It admits and publishes nothing and creates no table.
- **Reliability.** No model call or network wait is inside a transaction: research is fetched first, the harness owns its own short transactions, and the production scope is entered only to read the run's accounting and to close it. Every paid attempt is in the attempt ledger and counts against the production caps; an unknown attempt is never resent and its run stays open. The batch starts no new topic after a spent budget or quota, an unknown attempt, a refused harness, a model other than `MiniMax-M3.1-Flash`, or two provider failures in a row. Authority is the production root, rechecked by the harness.
- **Failure and recovery.** A topic that stops early is simply run again with `--topics` naming what is left; each run is a new business run. The refused answers of a topic stay readable for 30 days with `reasoning rejected --attempt <id>` (the line prints the attempt ids).
- **Tables, jobs, erasure.** None added. The command uses `reasoning.production_runs`, `production_attempts` and `production_rejected_answers`, and reads no content table apart from the library plan in code. Erasure: nonpersonal, nothing to erase.

## Reels

Reels are not produced here. A Reel is a request to Cutroom, which has its own service, budget and
queue; its ordering, ledger and publication are in `../README.md` ("Reels from Cutroom").
