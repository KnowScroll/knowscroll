# Scroll production

Writer roles belong to content (blueprint §§11, 15). `production/` owns the evidence packaging, the
writer's instructions and checks, the job state and the application of a result.
`infrastructure/research` owns the public HTTP boundary, and the shared reasoning engine keeps
transport, admission and the external attempt ledger.

Status: the pipeline below is **implemented** and has been **runtime-verified** with real
`MiniMax-M3.1-Flash` calls against a local database (summary in the pull request for #232). It is
not yet running on dev.

## The pipeline

```text
operator ─▶ job (research) ─▶ evidence passages ─▶ writer (1 call + 1 repair) ─▶ compile ─▶ publish
```

1. **Job.** `makeProduceScroll` reserves one job per `(topic, SCROLL_PRODUCTION_VERSION)` in
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

| Stored table                                        | Role                                                                                                                                                                                                                    | Main query                             | Lifetime                                                               |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------- |
| `content.scroll_production_runs` (0015, 0045, 0050) | Authoritative, private job: research pages, the authored document and the cited claims once published, code-only outcomes, the revision pointer. States `research`, `writer`, then `published`, `rejected` or `unknown` | Unique `(topic, policy_version)`, UUID | Nonpersonal public supply; retained for correction, no account erasure |
| `content.asset_revisions` / `asset_provenance`      | Immutable admitted consumer bytes / internal evidence and generation lineage                                                                                                                                            | Asset + revision                       | Shared content; no account erasure                                     |
| `reasoning.production_*` (0013, 0050)               | The writer run, every possible paid attempt, and the refused answers kept 30 days for diagnosis                                                                                                                         | Stable writer run UUID                 | Harness retention and liability policy                                 |

No jobs are registered yet: the worker operator triggers the sequence (`docs/v2/operations/scroll-production.md`).
Lock order: production root → production job row → asset advisory lock → asset rows. Short
transactions freeze or apply data; no model or HTTP wait holds one. Every rejection and the final
write require their expected stage under the root and job lock, so a delayed delivery reports the
advanced job instead of acting on it. `--resume` continues the same frozen research and the same
writer run through the ledger after a crash. An unknown attempt stays unknown and is never resent.
A rerun reports the existing state; a terminal rejection stays rejected. A changed recipe is a new
`SCROLL_PRODUCTION_VERSION` (and `WRITER_PROMPT_VERSION`), never an edit of an old job.

When a Scroll fails, `reasoning rejected` lists the refused answers with the validator's findings
(`packages/backend/src/reasoning/README.md`); that is where to look first.

Jobs: none. Notices: none. Erasure: nonpersonal supply, nothing to erase.

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

## Reels

Reels are not produced here. A Reel is a request to Cutroom, which has its own service, budget and
queue; its ordering, ledger and publication are in `../README.md` ("Reels from Cutroom").
