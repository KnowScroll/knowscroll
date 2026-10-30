# Producing Scrolls

Scrolls are produced by `content.produce-scroll` jobs on the worker. The pipeline and the reasons for
its shape are in `packages/backend/src/modules/content/production/README.md`. Two things send jobs:
Quartermaster, when a person's request needs content that does not exist, and the operator, to seed the
library.

## Run it

The operator commands refuse every world except `local`, `ci`, `dev` and `stage`, before they touch the
database or the provider. The production root `scroll-supply` must be enabled in the database
(`reasoning.production_scopes`, generation 1) and in the worker's environment.

```sh
# worker environment (names only; the key stays in the process environment, never on a command line)
KS_WORLD=dev DATABASE_URL=… MINIMAX_API_KEY=…
KS_REASONING_PROVIDER=minimax KS_REASONING_PRODUCTION_ENABLED=1
KS_MINIMAX_MODEL=MiniMax-M3.1-Flash          # the default for every role
KS_MINIMAX_REQUEST_TIMEOUT_MS=300000         # the largest accepted; a writer request takes up to ~2 minutes
KS_SCROLL_PRODUCTION_GENERATION=1            # must match the database root
KS_REASONING_PRODUCTION_REQUESTS_PER_DAY=200 # the production scope's own caps (the defaults)
KS_REASONING_PRODUCTION_TOKENS_PER_DAY=3000000
KS_SUPPLY_CREATE_DAILY_CAP=10                # API and worker: productions people's requests may start per day
KS_SUPPLY_PLANNER_CREATE_DAILY_CAP=5         # API and worker: the part the Planner's demand may use (default 5)
KS_SUPPLY_SCENARIO_DAILY_CAP=6               # API: branches of content threads (What if, perspectives) per day (D-049)
KS_SUPPLY_SCENARIO_THREAD_CAP=6              # API: branches one thread may have ordered over its life (default 6)

# seed the library through the same jobs Quartermaster sends (the worker runs them)
node dist/operator.js content production-status [--only seasons,tides]
node dist/operator.js content produce-library --dry-run [--only seasons,tides] [--interactive-first]
node dist/operator.js content produce-library [--only seasons,tides] [--interactive-first]

# run one job directly through the same use case (debugging)
node dist/operator.js content produce-scroll --topic seasons --dry-run
node dist/operator.js content produce-scroll --topic seasons [--take 2]
node dist/operator.js content produce-scroll --topic seasons --resume   # after a crash only
```

`produce-library` sends a job for every recipe that needs one and prints what it queued
(`queued`), what was already queued or running (`alreadyQueued`), the recipes it takes again after a
rejection (`retaking`) and the ones with nothing left to do (`skipped`, with `published` or `stopped`).
A recipe whose job is still running is sent again on purpose: that resumes a run a crash or a spent
budget left open. It is safe to run it again at any time.

`production-status` lists every recipe with its standing: `not_started`, `running`, `published`,
`retryable` (every take so far was rejected and another may start) or `stopped` (an attempt of unknown
outcome, or all three takes used), the latest job state, how many takes exist, the Scroll's asset and
revision once admitted, and the paid attempts so far.

### Takes

A rejected recipe can be taken again, at most three times in all, because a rejected job is final for its
take. Take 2 or 3 starts only when every earlier take was rejected: never after a published job or an
unknown attempt. Each take is a new business run, so nothing an earlier take sent is sent again.
`produce-library` and Quartermaster send the next take by themselves. Check `reasoning unknown` before
deciding what to do about a `stopped` recipe: it needs an operator, not another take.

### Caps and pauses

The production scope has its own daily caps (`KS_REASONING_PRODUCTION_*`, above), larger than the
per-person ones, because seeding the library takes about 70 writer requests and 1.4M tokens. The global
and role caps still apply. When a cap or the provider's quota (`KS_MINIMAX_QUOTA_FLOOR_PERCENT`, default
25) is used up, a run **pauses** (`outcome: paused`): nothing is sent and the job stays open. Run
`produce-library` again after the window or the UTC day resets.

A paused job is not lost, and nobody has to wait for the next `produce-library`: a person who asks for the
same Scroll joins the group, and a join sends the group's job again (same identity, so a queued job is
never doubled). That also revives a job the queue dead-lettered. A run that pauses again and again uses up
the step's attempt slots (four unsent attempts per step, `attempts_exhausted`) and the take ends as
`rejected`; the next take starts fresh.

### Research that is down

A failed fetch (`dns_timeout`, `request_timeout`, `network_failed`, `http_refused`, or an unclassified error)
is a blip, not a verdict about the sources. The job stays at its research step, no take is spent, the
delivery fails and the queue retries it (two retries). Only a verdict ends a take: `soft_404`, a refused
host, an unusable page, or a rejected answer.

### Asks left open from before Create

Asks that were open when Create arrived have no resolver job and may stand on a group that commissioned
nothing. The recovery command sends one resolver job for each open ask. The resolver then commissions the
group (or joins one that has work behind it), binds content that exists, or closes the ask honestly:

```sh
node dist/operator.js supply recover-open-demand --dry-run   # counts open asks by state, sends nothing
node dist/operator.js supply recover-open-demand             # one job per open ask
```

It prints `open` (by state), `queued` and `alreadyQueued`. Running it again sends nothing new while the
earlier jobs are retained. It calls no provider; the productions it leads to run under the caps above.

### Who may start a production

Create has two daily counts, so the Planner cannot use what a person's own ask needs. People's asks use
`KS_SUPPLY_CREATE_DAILY_CAP`. The Planner's demand uses `KS_SUPPLY_PLANNER_CREATE_DAILY_CAP` (default 5),
and its effective value is never above the people's cap: setting the people's cap to 0 turns Create off
for both. A person may also have at most 10 asks open at once (a fixed limit; it bounds the polling work),
and an ask still open after 30 minutes reads as `could_not_prepare`, even if no job ever closed it.
Planned demand only ever binds to a Scroll the person has not met.

A thread's branch (a What if or Another perspective, D-049) is produced by the same jobs but is not a library recipe and not
a Create for a person's ask: it has its own two caps, `KS_SUPPLY_SCENARIO_DAILY_CAP` (the world's UTC day; 0 turns it off) and
`KS_SUPPLY_SCENARIO_THREAD_CAP` (per thread), counted from `supply.scenario_orders`. Its recipe key is `order-<32 hex>`;
`content production-status` lists the library plan's recipes only, so look a branch up in `scenarios.nodes` (its status
and `asset_id`; the `ops.jobs` view shows its production job). It publishes with no topic attribution and no coverage.

`--topic` takes a recipe key of the library plan, the record keys in
`packages/backend/src/modules/content/domain/library/` (one file per topic system). An unknown key
is refused before any database or provider work. A published Scroll gets its planet and facet
coverage from its recipe in the same transaction (D-033).

After editing the plan (a facet or planet added or reworded), decide coverage again for Scrolls that
are already published. It is idempotent and appends corrected heads only where the decision changed:

```sh
node dist/operator.js content readmit-coverage --dry-run
node dist/operator.js content readmit-coverage
```

## Series and related moves

The plan also declares which published Scrolls form a series (Part tabs) and which are related
perspectives (dashed Related tab), in `domain/library/continuity.ts`, by recipe key (D-059). Nothing
else makes these links, so Explore shows no Part or Related tab until this command has run. Run it
after a batch has published:

```sh
node dist/operator.js content admit-continuity --dry-run
node dist/operator.js content admit-continuity
```

It resolves each key to the Scroll admitted now and prints what it admitted, what was already there
(`seriesUnchanged`, `linksUnchanged`) and what it skipped because a Scroll is not published yet
(`seriesSkipped` names the missing recipes; a series is admitted whole or not at all, `relatedSkipped`
names the move). Run it again after more Scrolls publish: it adds only what is new and a second run
changes nothing. A recipe republished as a new revision gets a new series revision and replacement
links; the old rows stay as inactive history. It touches the shared database only: no provider, no
person's data.

Before a batch, check that every research page of the plan is still accepted by the fetcher and
yields a usable passage pool (it fetches slowly, about three seconds a page, because Wikipedia
rate-limits bursts):

```sh
pnpm build
node scripts/check-library-sources.mjs [--only seasons,tides]
```

The bound is **two model requests per take**: the writer, and at most one repair. A refusal ends the
take; a spent budget or quota pauses it; an unknown outcome halts the recipe.
Output is one JSON line with IDs, outcome codes, attempt states and token counts; never prompts,
drafts or page text. A rerun of a finished take reports its stored outcome. A new recipe version
(`SCROLL_PRODUCTION_VERSION`) is a new job; an old terminal job is never edited or resumed. No
provider call runs from CI. Never place keys on a command line, in logs, reports or artifacts.

`--resume` continues an unfinished job with its frozen research and the same writer run. It never
resends an attempt whose outcome is unknown: if a process may still be running, let it finish first,
then inspect with `reasoning unknown` and write the attempt off only when sure.

## When a Scroll is refused

```sh
node dist/operator.js reasoning rejected                    # newest first: attempt, step, verdict, number of findings
node dist/operator.js reasoning rejected --attempt <uuid>   # the redacted answer text and the validator's findings
```

Each refused answer of a production attempt is kept for 30 days, redacted and cut at 64 KiB, with
the same fixed findings the repair request carried (`blocks[7]: copied_passage`, …). The text is
the model's own writing about public sources; read it from an operator shell, never paste it into
an issue or a pull request. `reasoning purge-expired` removes expired ones on demand.

Usual findings and what they mean:

| Finding | Meaning |
|---|---|
| `copied_passage` | Nine words in a row match a source passage. The repair is told the copied words (`<repair-notes>`). |
| `authoring_number_not_in_evidence` | A figure (or a plotted chart value) is in no passage the block cites. |
| `too_big` / `too_small` at a field | A length limit; the finding names the field and the limit. |
| `OUTPUT_NOT_ONE_JSON_OBJECT` | The reply is not one JSON object; the detail says where it stopped being JSON. |
| `OUTPUT_TRUNCATED` | The reply hit the token ceiling, usually because the model thought too long. |
| `reading_length_out_of_brief` | Under two or over eight minutes of reading. |
| `MODEL_MISMATCH` (attempt code) | The route answered with another model than the configured one. |

## The v2 writer spike (S-0)

Before any V3 engine is built, the team measures whether the writer can produce `scroll-document.v2` Scrolls reliably, and what a library wave costs (issue #471, decisions D-120 to D-122). The command runs the v14 writer on real library recipes, validates and assembles what it writes, and **admits and publishes nothing**. It needs no migration, so a branch with it can be deployed to dev by manual dispatch.

```sh
# worker environment as above: KS_REASONING_PRODUCTION_ENABLED=1, KS_MINIMAX_MODEL=MiniMax-M3.1-Flash (the only model it accepts)
node dist/operator.js content writer-spike-v2 --topics <recipe key,…> [--out <file>] [--concurrency <1-4>] [--spike-id <id>]
```

The twenty topics of the first run, in order (the three Seasons parts first; nine Earth & sky and Space recipes with a stage, four of the human body, seven of computing, machine learning and history without one):

```text
seasons,seasons-hemispheres,seasons-limits,tides,tides-spring-neap,greenhouse-radiation,greenhouse-balance,stars-fusion,exoplanet-habitable-zone,cardiac-cycle,blood-pressure,reflex-arc,immune-memory,dns-lookup,hash-tables,event-loop,gradient-descent,attention-mechanism,overfitting,industrial-causes
```

Each run is two requests at most per topic (the writer and one repair), at most 40 for the twenty, inside the production scope's daily caps (`KS_REASONING_PRODUCTION_*`) and the MiniMax window. `--concurrency` (default 1, at most 4) runs topics side by side. `--out` appends the assembled documents of accepted topics to a file, one JSON line each; the file holds the model's own text about public sources, so read it on the server and do not paste it into an issue. A recipe key that is not one of the twenty runs as a plain Scroll with no misconception, and the line says `recipeDefaulted: true`.

### Reading the output

One JSON line on stdout for the start (`result: "starting"`), one for each topic as it finishes (`result: "topic"`), and one for the end (`done` or `stopped`). The exit status is 0 when every topic was accepted or rejected on its merits, 2 when the command was refused or stopped early, 1 on a failure.

A topic line has these fields (never any text of the Scroll):

| Field | Meaning |
|---|---|
| `key`, `variant`, `misconception` | The recipe, `stage` or `plain`, `myth` or `none`. |
| `outcome` | `accepted_first_take`, `accepted_after_repair`, `rejected` (the writer and its repair were both refused), or why nothing was judged: `research_failed`, `evidence_insufficient`, `provider_failed`, `model_mismatch`, `paused` (a cap or the quota stopped it; nothing sent), `unknown` (never resent; see `reasoning unknown`), `refused`, `scope_refused`. |
| `requests` | Paid requests sent: 1 for a first take, 2 after a repair. |
| `findings` | For each refused answer, `{attempt, code, path}`: the validator's fixed code and the writer's item (`items[4]`, `recap`). A repaired Scroll lists the findings that caused the repair. Count the codes over all topics for the top findings. |
| `words`, `readingMinutes` | Reader words (stops, calls, asides, recap) and the measured minutes at 230 words a minute plus 10 seconds a call. |
| `stops`, `calls`, `stageStates`, `asides` | Counts in the accepted document. |
| `tokens` | `input`, `output` (thinking included), `thinking`, and `complete: false` when the provider did not report every count. |
| `attempts`, `models` | Each paid attempt's id, step, state and usage, and the model they report. The transport fails an attempt whose reply names another model (D-031), so a line with `models` other than `MiniMax-M3.1-Flash` is `model_mismatch`. |
| `notices` | `misconception_source_unreviewed`: the placeholder source label of a spike recipe (only the seasons myth has a reviewed one). |
| `wallMs` | `research`, `writer` and `total` milliseconds. |
| `runId`, `spikeId`, `code` | Identity of the run and of this spike run; `code` is the reason for a non-accepted outcome. |

The end line has `requested`, `completed`, `notStarted` (topics never started because an earlier outcome stopped the batch) and, if it stopped, `stoppedBy {key, outcome}`.

To read a refused answer: `node dist/operator.js reasoning rejected --attempt <attemptId>` (kept 30 days, redacted). To size a wave: sum `tokens` and `wallMs.total` over the lines, and note how much of the five-hour MiniMax window the run used.

### Running it again

Each run starts fresh and remembers nothing. Before running again, reconcile every attempt the last run left  with `reasoning unknown` (or write it off): re-running that topic before then would send a second paid request while the first is unsettled. Then re-run only the topics in `notStarted` plus `stoppedBy.key`, which is not in `notStarted`. Re-running all twenty repeats the finished ones and pays for them again.

## Facts about the model

`MiniMax-M3.1-Flash` thinks before it answers and refuses `thinking: disabled`; thinking tokens
count against `max_tokens`. Without a hint it can think for the whole budget and never answer, so
the writer asks for `medium` effort and a 16,000-token ceiling. Its replies are plain text JSON.
Unknown model names are silently served by another model; the adapter checks the reply's `model`.
Quota: `GET https://www.minimax.io/v1/token_plan/remains`, entry `general`.

## Research

Policy `public-research.v1`: individually reviewed HTTPS hosts, default port, no URL
credentials/query/hash, no cookies, manual redirects (at most three) with every URL and DNS answer
rechecked, public addresses only, identity encoding only, at most 2 MiB of HTML, bounded plain-text
extraction, soft-404 refusal. Code chooses the pages; the model never does. Snapshots stay private
in the nonpersonal production row.

## Evidence for acceptance

Label what a result is: source inspection, CI fixture, real database, real provider, browser or
device, dev or stage deployment. A generated Scroll counts only after it is published through this
pipeline and read in the connected app; a fixture publication does not establish it. Human review
notes cover accuracy, clarity, the interactive block, unsupported inference and where an analogy
stops.
