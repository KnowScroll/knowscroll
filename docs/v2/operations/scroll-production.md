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
KS_SUPPLY_ASK_DAILY_CAP=8                    # API and worker: ask orders (a short Scroll for one person's question) per day (D-218)
KS_SUPPLY_ASK_PERSON_DAILY_CAP=5             # API and worker: ask orders one person may have made per day (default 5; D-218)
KS_SUPPLY_SCENARIO_DAILY_CAP=6               # API: branches of content threads (What if, perspectives) per day (D-049)
KS_SUPPLY_SCENARIO_THREAD_DAILY_CAP=5        # API: branches one thread may have ordered per UTC day (default 5; D-158)

# seed the library through the same jobs Quartermaster sends (the worker runs them)
node dist/operator.js content production-status [--only seasons,tides]
node dist/operator.js content produce-library --dry-run [--only seasons,tides] [--interactive-first]
node dist/operator.js content produce-library [--only seasons,tides] [--interactive-first]

# make another take of a v2 Scroll that is already served (stored held; see "Running a library wave")
node dist/operator.js content regenerate --only seasons,seasons-hemispheres --dry-run
node dist/operator.js content regenerate --only seasons,seasons-hemispheres

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

`production-status` lists every recipe with its standing: `not_started`, `running`, `published`, `held`
(a v2 Scroll was produced and waits for you to read and release it, see "The review gate"),
`retryable` (every take so far was rejected and another may start) or `stopped` (an attempt of unknown
outcome, or all three takes used), the latest job state, how many takes exist, the Scroll's asset and
revision once admitted (`heldRevision` while it is held), and the paid attempts so far.
A v2 recipe also shows `regeneration` (`not_v2`, `not_published`, `available`, `running`, `held`, `spent`, `stopped`), `takesLeft`
(takes unused at this production version) and `check`, what the answer check said about the latest take (`passed`, `repaired`,
`flagged`, `unchecked`, with the flagged calls and the checker's problem for each).

### Takes

A rejected recipe can be taken again, at most three times in all, because a rejected job is final for its
take. Take 2 or 3 starts only when every earlier take was rejected: never after a published job or an
unknown attempt. The one exception is `content regenerate` (below), which makes another take of a v2 recipe whose Scroll an operator released.
Each take is a new business run, so nothing an earlier take sent is sent again.
`produce-library` and Quartermaster send the next take by themselves. Check `reasoning unknown` before
deciding what to do about a `stopped` recipe: it needs an operator, not another take. A v2 Scroll that an
operator rejected at the review gate counts as a rejected take; one still held does not, so no new take starts
until it is released or rejected.

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
`KS_SUPPLY_SCENARIO_THREAD_DAILY_CAP` (per thread, per UTC day), counted from `supply.scenario_orders`. Its recipe key is `order-<32 hex>`;
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

The bound is **two model requests per take for a v1 recipe**: the writer, and at most one repair. A v2 library recipe adds the
answer check (D-198): the bound is **six**, two writer requests (the draft and one repair, from the validator or from the check)
and the checker once for each of the two drafts, each with at most one repair of an unusable reply. A refusal ends the
take; a spent budget or quota pauses it; an unknown outcome halts the recipe, except the checker's, which leaves the Scroll
held and marked unchecked.
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
| `copied_passage` | Nine words in a row match a source passage. The repair is told, for each block, the passage words it copied (at most six runs of twenty words, `<repair-notes>`, D-294). The one revision after an ask's support check has no repair: a copy there ends the job. |
| `authoring_number_not_in_evidence` | A figure (or a plotted chart value) is in no passage the block cites. |
| `too_big` / `too_small` at a field | A length limit; the finding names the field and the limit. |
| `OUTPUT_NOT_ONE_JSON_OBJECT` | The reply is not one JSON object; the detail says where it stopped being JSON. |
| `OUTPUT_TRUNCATED` | The reply hit the token ceiling, usually because the model thought too long. |
| `reading_length_out_of_brief` | Under two or over eight minutes of reading. |
| `MODEL_MISMATCH` (attempt code) | The route answered with another model than the configured one. |

## The v2 writer spike (S-0)

Before any V3 engine is built, the team measures whether the writer can produce `scroll-document.v2` Scrolls reliably, and what a library wave costs (issues #471 and #472, decisions D-120 to D-126). The command runs the v15 writer on real library recipes, validates and assembles what it writes, and **admits and publishes nothing**. It needs no migration, so a branch with it can be deployed to dev by manual dispatch.

```sh
# worker environment as above: KS_REASONING_PRODUCTION_ENABLED=1, KS_MINIMAX_MODEL=MiniMax-M3.1-Flash (the only model it accepts)
node dist/operator.js content writer-spike-v2 --topics <recipe key,…> [--blocks <recipe=sort|fork|scale|chart>[+ray],…] [--out <file>] [--concurrency <1-4>] [--spike-id <id>]
```

The twenty topics of the first run, in order (the three Seasons parts first; nine Earth & sky and Space recipes, four of the human body, seven of computing, machine learning and history). That run used prompt v14, which gave a stage to every Earth & sky and Space recipe. Since v15 a recipe has a stage only where its library entry names a `stageKit` (D-125): three Seasons parts. The others run as plain Scrolls with calls:

```text
seasons,seasons-hemispheres,seasons-limits,tides,tides-spring-neap,greenhouse-radiation,greenhouse-balance,stars-fusion,exoplanet-habitable-zone,cardiac-cycle,blood-pressure,reflex-arc,immune-memory,dns-lookup,hash-tables,event-loop,gradient-descent,attention-mechanism,overfitting,industrial-causes
```

To measure the Seasons stage again with the v15 prompt (the three Seasons stages, and "Seasons elsewhere" as a plain Scroll to check its Mars and Uranus sources), at most eight requests. Since D-137 the plan marks these four recipes v2, and the spike runs them as the library produces them: the plan's picture choice and misconception, not the spike's own table:

```sh
node dist/operator.js content writer-spike-v2 --topics seasons,seasons-hemispheres,seasons-limits,seasons-elsewhere --concurrency 2 --spike-id seasons-v15 --out /var/tmp/ks-v3-spike/seasons-v15.jsonl
```

What to read in the lines for these four: `variant` is `stage` for the first three and `plain` for `seasons-elsewhere`, `stageStates` is at least 3 for the stage ones, and the `findings` have no `common_guess_*`, `stage_state_on_call`, `earth_axis_sideways` or `final_call_restates_call` that survive the repair. Then read each accepted document on the server: the picture must match each stop's words (the month decides the pins and Ray), no stage text calls Earth's axis sideways, and every statement about Mars and Uranus must be in the NASA pages the recipe cites. The recipes the drawing kits of D-194 give a picture are measured next (below).

To measure the eight Earth & sky and Space recipes the drawing kits give a picture (D-194: tides and spring and neap tides with `tides.v1`; `greenhouse`, `greenhouse-radiation` and `greenhouse-balance` with `greenhouse.v1`; `stars-fusion` and `stars-lifecycle` with `star.v1`; `exoplanet-transit` with `transit.v1`), at most sixteen requests. Each runs as the library produces it since D-217 marked them `scrollV2`: a stage Scroll drawn with its recipe's kit, no misconception, with its landmark:

```sh
node dist/operator.js content writer-spike-v2 --topics tides,tides-spring-neap,greenhouse,greenhouse-radiation,greenhouse-balance,stars-fusion,stars-lifecycle,exoplanet-transit --concurrency 2 --spike-id sky-kits-v17 --out /var/tmp/ks-v3-spike/sky-kits-v17.jsonl
```

What to read in the lines: `variant` is `stage` and `stageStates` at least 3 for all eight, and no `stage_choice_invalid` survives the repair (the writer used a word the kit does not have). Then read each accepted document on the server: the picture must match each stop's words (the Moon's phase decides spring or neap; the layer and `change` decide the energy bars; the mass and stage decide the star; the planet and place decide the dip), and no stop may say what the picture cannot (a coast, a temperature, a year, a real planet's size).

To measure the six Human body recipes the drawing kits of D-201 give a picture (`cardiac-cycle`, `blood-pressure` and `oxygen-transport` with `circulation.v1`; `action-potential`, `synapse-signalling` and `reflex-arc` with `nerve.v1`), at most twelve requests. Each runs as the library produces it (D-199, D-201): a stage Scroll drawn with its recipe's kit, no misconception, with its landmark. Read the results before the first wave of these recipes:

```sh
node dist/operator.js content writer-spike-v2 --topics cardiac-cycle,blood-pressure,oxygen-transport,action-potential,synapse-signalling,reflex-arc --concurrency 2 --spike-id body-kits-v18 --out /var/tmp/ks-v3-spike/body-kits-v18.jsonl
```

What to read in the lines: `variant` is `stage` and `stageStates` at least 3 for all six, and no `stage_choice_invalid` survives the repair. Then read each accepted document on the server: the picture must match each stop's words (the point of the beat decides the valves, the flow and the width of the arterioles decide the bars, where the blood is decides the oxygen handed over; the point of the spike decides the channels, the step decides the synapse and the reflex), and no stop may say what the picture cannot (a heart rate, a pressure figure, a voltage, a speed, a named chemical, "the heart squeezes all four chambers at once", electricity down a wire, a spike bigger for a stronger push, a reflex with no brain).

To measure the five Space recipes the starlight and black-hole kits of D-204 give a picture (`stars-colour-brightness` and `exoplanet-habitable-zone` with `starlight.v1`; `black-hole-formation`, `black-hole-horizon` and `black-hole-evidence` with `black-hole.v1`), at most ten requests, with prompt v19. As above, each runs as the plan marks it since D-217 (no misconception, with its landmark):

```sh
node dist/operator.js content writer-spike-v2 --topics stars-colour-brightness,exoplanet-habitable-zone,black-hole-formation,black-hole-horizon,black-hole-evidence --concurrency 2 --spike-id space-kits-v19 --out /var/tmp/ks-v3-spike/space-kits-v19.jsonl
```

What to read in the lines: `variant` is `stage` and `stageStates` at least 3 for all five, and no `stage_choice_invalid` survives the repair. Then read each accepted document: the picture must match each stop's words (the kind of star decides its colour, output and place on the chart; the orbit decides which zone holds the planet; the star and stage decide whether a black hole can form; the hole decides the horizon), and no stop may say what the picture cannot: that a planet in a zone has water or life, that colour alone gives a star's age, that a Sun-like star becomes a black hole, that a black hole sucks in everything, that the horizon is a surface, that the centre is understood, that the shadow is the horizon, or that one clue proves a black hole.

To measure the play blocks of D-207 (a sort, a growing chart, a scale, a fork and a guide) before any recipe is marked, at most eight requests, with prompt v20. The plan names no block, so `--blocks <recipe>=<sort|fork|scale|chart>[+ray],…` asks for them: `hybrid-sorting` a sort (the steps of Timsort), `industrial-causes` a chart (the population figures of its page), `black-hole-formation` a scale (the masses its page states) and `seasons-elsewhere` a fork between Mars and Uranus with Ray as the guide:

```sh
node dist/operator.js content writer-spike-v2 --topics hybrid-sorting,industrial-causes,black-hole-formation,seasons-elsewhere --blocks hybrid-sorting=sort,industrial-causes=chart,black-hole-formation=scale,seasons-elsewhere=fork+ray --concurrency 2 --spike-id blocks-v20 --out /var/tmp/ks-v3-spike/blocks-v20.jsonl
```

What to read in the lines: `blocksAsked` and `blocksWritten` agree for all four, and no `block_missing`, `block_unexpected`, `block_value_invalid` or `authoring_number_not_in_evidence` survives the repair. Then read each accepted document with `content review-show`: it prints the answer key of a sort, both paths of a fork, and every figure of a scale and a chart, so each can be checked against its page. The sort's order must be the order the page gives; each figure must be the page's and mean what its label says (a unit the page never names is not caught by code); the two paths must be two real readings of one idea. A person marks a recipe's `blocks` only after reading its Scroll.

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

Each run starts fresh and remembers nothing. Before running again, reconcile every attempt the last run left `unknown` with `reasoning unknown` (or write it off): re-running that topic before then would send a second paid request while the first is unsettled. Then re-run only the topics in `notStarted` plus `stoppedBy.key`, which is not in `notStarted`. Re-running all twenty repeats the finished ones and pays for them again.

## Producing a v2 Scroll (S-1b, D-127 to D-130, D-137)

A recipe becomes a `scroll-document.v2` Scroll only when the library plan marks it (`scrollV2` on the recipe: `variant` `stage` or `plain`, and its `misconception`, either `none` or a myth whose source label a person has `reviewed`). Every other recipe stays v1. The plan marks the four Seasons recipes (D-137), the thirty-five recipes of Human body, Computing, Machine learning and History (D-199) and the fifteen kit recipes of Earth & sky and Space (D-217): `seasons`, `seasons-hemispheres` and `seasons-limits` with a picture, the six heart and nerve recipes of Human body with a picture (D-201), the thirteen Earth & sky and Space recipes a kit draws (D-217), and every other marked recipe without one. Only `exoplanet-kinds` is still v1. The plan may also name a `landmark` (key and name) and a `finalCall` control (`tilt`) for a recipe; code sets both into the document, the writer never writes them, and a recipe without them awards no landmark (D-187, D-188). The v2 writer prompt is `scroll-writer.v20`. A v2 recipe is a job of its own version (`scroll-production.v20`, v1 recipes stay `.v14`), so a recipe already published as v1 is produced again and its Scroll becomes the next revision of the same asset. That version is the takes' budget: a recipe has three takes to a production version, and the version changes whenever the v2 writer or the job's steps change (D-197), which gives every recipe fresh takes.

**A produced v2 library Scroll is held, not published (D-138).** The job stores it with its provenance and coverage and then waits: nobody is served it until you have read it and released it (next section). The commands that start a job are the same for every recipe; the plan decides which writer runs and the gate decides what happens to the result.

```sh
node dist/operator.js content produce-library --dry-run --only <recipe key,…>   # a recipe with only a v1 Scroll is listed as not started
node dist/operator.js content produce-library --only <recipe key,…>
node dist/operator.js content production-status --only <recipe key,…>          # `held` once produced; `published` only after release
node dist/operator.js content readmit-coverage                                 # after a plan change; picks the rule that matches each revision
```

What to look at: `reasoning rejected` for the findings of a refused answer (the same catalogue as the spike); a recipe refused with `plan_refused` / `misconception_source_unreviewed` is a recipe problem (review the label or choose `none`): it is `stopped` in `production-status`, no job was reserved and no request was sent. Coverage is `scroll-recipe-coverage.v2` over the read stops (D-127); `coverage_too_few_body_blocks` in the job's outcomes means fewer than three read stops cited a documented claim, and `review-list` then shows `coverage: unmapped`.

A client that does not declare `scroll-document.v2` is offered the previous v1 revision of a regenerated Scroll (Explore and the Composer), and a direct open of a v2 asset by such a client says it needs an app update. Explore and `/scroll/<id>` of this app declare v2 and draw it with the Stage + Spine reader (D-135).

## The review gate for v2 library Scrolls (S-1e, D-138)

Every wave of v2 Scrolls gets a factual read by a person before anyone is served it (D-123). The gate is that read. It applies to a v2 library recipe however the job was sent: the operator's library run, `produce-scroll`, or a retry. A v1 recipe and a Scroll ordered from a thread publish as they always did.

**What held means.** The revision is stored, with its provenance, topic and coverage. It is not the asset's current revision, so discovery, Explore, series and related moves, the Universe's regions, sharing, saved items and opening a Scroll do not see it. A Scroll that already serves an earlier revision keeps serving it. A brand-new asset stays `held` and cannot be opened. `production-status` shows the recipe as `held` (with `heldRevision`), never `published`. `produce-library` skips a held recipe, and a person's ask never makes Quartermaster write a v2 recipe.

```sh
node dist/operator.js content review-list [--all]                   # held revisions: recipe, revision, title, words, minutes, picture, coverage. --all adds released and rejected, with who and when
node dist/operator.js content review-show --asset <asset id> [--revision <n>] [--sources]   # the Scroll as plain text, to read on the server
node dist/operator.js content release --asset <asset id> --revision <n>                      # serve exactly this revision
node dist/operator.js content reject  --asset <asset id> --revision <n> --reason "<why>"      # keep it out, free the next take
```

All four refuse worlds other than `local`, `ci`, `dev` and `stage`, use the shared database only, and call no provider. `review-list` prints one JSON line with titles and counts, never body text. `review-show` prints the text to the terminal and nowhere else: do not paste it into an issue or a pull request. `--sources` adds, under each stop, aside and the recap, the exact source passages it cites, and the pages at the end, so a statement can be checked against its source. `release` and `reject` record who ran them (`cli:<your user>`) and when, write a `content.review_decided` line to the event log on stderr (recipe key, outcome, revision, a refusal's code; no text), and are safe to repeat: a second `release` answers `already_released`, a second `reject` answers `already_rejected` and keeps the first reason. Exit status is 0 for a decision or a repeat and 2 for a refusal (`not_under_review`, `revision_rejected`, `revision_released`, `not_newer_than_served`, `asset_withdrawn`, `reason_invalid`).

### The answer check (S-6a, D-198)

Before a v2 library Scroll is stored, a second model checks that the answer key of each call agrees with the call's own words: the marked answer is the one the explanation supports, no other option is also right, the twist does not contradict the key. It sees no sources, so it does not check facts. Code decides what a verdict does:

| What `review-list` and `review-show` say | What happened | What you do |
|---|---|---|
| `passed` | Every call was consistent in the first draft. | Read it as usual. |
| `repaired` | The first draft had a flagged call. The writer corrected it once, and the stored draft passed. The first draft's flags are printed, each with the question, the options (the marked one is named) and the explanation as the checker saw them, because that draft is not stored. | Read those calls first in the stored draft: check the repair did not swap one problem for another. |
| `NOT CHECKED (<code>)` | The checker gave no usable answer (`provider_failed`, `outcome_unknown`, `invalid_output`, `refused_…`). The Scroll is held with no verdict. | Read every call's answer key yourself. For `outcome_unknown`, the attempt is listed by `reasoning unknown`. |
| _not run_ | The revision was made before the check existed. | Read every call. |

A Scroll still flagged after the one repair is not stored: its take is spent, `production-status` shows the recipe `retryable` (or `stopped` after three) with `check.outcome: flagged` and, for each flagged call, the checker's problem and the call itself (`check.flags[].call`: question, options, marked answer index, explanation), because no draft was stored. `review-list` carries the problems and call ids only. A draft the validator had already repaired has no repair left, so a flag on it ends the take at once. The check is a model's opinion: if a flagged problem looks wrong to you, the recipe's next take is the remedy, and three such takes is the signal to read the brief.

### What to read for

The checks the machine cannot make (D-123): the picture matches each stop's words (the month decides the pins and Ray); no sentence calls Earth's axis sideways; each statement is in the passages it cites (`--sources`); the correct option of each call is correct and the wrong ones are plausible; the Final call is a new case and not a repeat of an earlier call; the Plot twist reads warm; a plain Scroll about other worlds says nothing the pages do not state; nothing is invented (dates, temperatures, season lengths).

### Seasons on dev (S-1e)

The worker environment is the one above. Producing takes at most eight writer requests (four recipes, one repair each) and the answer check's requests (at most four a recipe, usually one) inside the MiniMax window.

```sh
# 1. What would be queued (nothing is sent). All four show as not started: the library holds v1 Scrolls of the first three, and v1 does not satisfy a v2 recipe.
node dist/operator.js content produce-library --dry-run --only seasons,seasons-hemispheres,seasons-elsewhere,seasons-limits
# 2. Queue them. The dev worker writes them and every one ends held.
node dist/operator.js content produce-library --only seasons,seasons-hemispheres,seasons-elsewhere,seasons-limits
# 3. Watch. held = waiting for you; retryable = the writer was refused (see "When a Scroll is refused"); running = still at it.
node dist/operator.js content production-status --only seasons,seasons-hemispheres,seasons-elsewhere,seasons-limits
# 4. Read each held Scroll against its sources.
node dist/operator.js content review-list
node dist/operator.js content review-show --asset <asset id from review-list> --sources
# 5. Decide, revision by revision.
node dist/operator.js content release --asset <asset id> --revision <n>
# 6. When the three series parts are released (seasons, seasons-hemispheres, seasons-elsewhere; seasons-limits is the related move), admit the series and the move.
node dist/operator.js content admit-continuity --dry-run
node dist/operator.js content admit-continuity
# 7. Decide coverage again from the plan (idempotent; the new Scrolls already have theirs and show as unchanged).
node dist/operator.js content readmit-coverage --dry-run
node dist/operator.js content readmit-coverage
```

Release all three parts before step 6. `admit-continuity` binds a series to the Scrolls that are served at that moment, so run it once the parts are served: a series with a part still held is skipped whole and named in `seriesSkipped`. A Part tab shows only after step 6. `seasons-limits` is a related move from `seasons-elsewhere`; when it is released after the others, run `admit-continuity` once more. After it, `seasons-limits` may keep a `previous` link into the old series revision 1 (D-125): decide then whether to retire it.

### If you reject

`reject` keeps the revision stored and unserved for good (it is never released), leaves the earlier revision served if there is one, and spends that take. `production-status` then shows the recipe `retryable` and `produce-library --only <key>` queues the next take, which writes a new revision (the next number). A recipe has three takes in all. If you reject all three, the recipe is `stopped`: the brief or the pages need a change in the plan, which is a code change and a new production version, so stop and say so in the issue. Tell the next person why in the reason (500 characters, plain words); `review-list --all` shows it with who and when.

Nothing in the gate edits a revision: a Scroll is released as it was read. To correct a wording, reject and produce again.

## Running a library wave (S-6a, S-6b, D-197 to D-199, D-217)

A wave is a set of recipes produced, read and released together. The goal of the first waves: at least 20 stage Scrolls and 30 with calls, all admitted, each series whole, each read by a person. The plan marks the Seasons recipes, the thirty-five recipes of Human body, Computing, Machine learning and History (D-199) and the fifteen kit recipes of Earth & sky and Space (D-217).

Size it first. A recipe costs one writer request and one small check request when all goes well, and up to six requests in the worst case. The earlier seeding of the library used about 20,000 tokens a writer request (about 70 requests, 1.4M tokens); the check reads only the calls, so it adds little. The production scope's daily cap (`KS_REASONING_PRODUCTION_REQUESTS_PER_DAY`, default 200) and the five-hour MiniMax window decide how many recipes run before a pause. Run a wave of about a dozen recipes at a time. A take can hold its worker claim for up to 35 minutes (six requests at the largest request timeout, 300 s, plus a margin); a job whose worker died is retried only after that, so do not expect a quick retry of a stuck take (`production-status` shows it as `running`).

The thirty-five recipes of D-199 go in four waves, one for each system (the Human body wave includes the six recipes a heart or nerve kit draws, D-201). Every series is inside one wave, so each can be admitted whole once its parts are released.

| Wave | Recipes |
|---|---|
| Human body (9) | `cardiac-cycle,blood-pressure,oxygen-transport,action-potential,synapse-signalling,reflex-arc,innate-immunity,adaptive-immunity,immune-memory` |
| Computing (9) | `dns-lookup,https-handshake,web-caching,rendering-pipeline,event-loop,same-origin-policy,big-o-growth,hybrid-sorting,hash-tables` |
| Machine learning (12) | `attention-mechanism,attention-example,attention-limits,transformer-architecture,token-embeddings,next-token-generation,gradient-descent,training-by-example,overfitting,long-input-cost,mixture-of-experts,subword-tokens` |
| History (5) | `industrial-causes,steam-power,factory-system,industrial-towns,industrial-debate` |

The fifteen recipes of D-217 go in two more waves, again one system each and every series inside one wave:

| Wave | Recipes |
|---|---|
| Earth & sky (7) | `tides,tides-spring-neap,tides-coasts,greenhouse,greenhouse-radiation,greenhouse-balance,greenhouse-limits` |
| Space (8) | `stars-fusion,stars-lifecycle,stars-colour-brightness,exoplanet-transit,exoplanet-habitable-zone,black-hole-formation,black-hole-horizon,black-hole-evidence` |

```sh
# 0. The wave's recipes (a row of the table above).
WAVE=cardiac-cycle,blood-pressure,oxygen-transport,action-potential,synapse-signalling,reflex-arc,innate-immunity,adaptive-immunity,immune-memory

# 1. What would be queued. A recipe with only a v1 Scroll shows as not started; nothing is sent.
node dist/operator.js content produce-library --dry-run --only $WAVE
# 2. Queue it. The dev worker runs the jobs: research, writer, validator, the answer check, and the hold.
node dist/operator.js content produce-library --only $WAVE
# 3. Watch. held = waiting for you; running = still at it; retryable = a take was refused (see "When a Scroll is refused");
#    stopped = no take can start. "paused" in the worker log means the budget or the window is spent: run step 2 again after it resets.
node dist/operator.js content production-status --only $WAVE
# 4. Read every held Scroll. The header says what the answer check found.
node dist/operator.js content review-list
node dist/operator.js content review-show --asset <asset id from review-list> --sources
# 5. Decide each revision.
node dist/operator.js content release --asset <asset id> --revision <n>
node dist/operator.js content reject  --asset <asset id> --revision <n> --reason "<why, in plain words>"
# 6. Once every part of a series is released, admit the series and the related moves, then decide coverage again.
node dist/operator.js content admit-continuity --dry-run
node dist/operator.js content admit-continuity
node dist/operator.js content readmit-coverage --dry-run
node dist/operator.js content readmit-coverage
```

A rejected take frees the next one: run step 2 again for the same recipes (it queues the next take of each `retryable` recipe). A recipe has three takes to a production version.

**Making a served Scroll again.** To replace a Scroll that is already served (a wrong answer found after release, a better writer), use `regenerate`. It sends the next take of a recipe whose v2 Scroll is served, stores it held as the next revision, and leaves the served one serving until you release the new one:

```sh
node dist/operator.js content regenerate --only seasons,seasons-hemispheres --dry-run   # wouldQueue, resuming, skipped with the reason
node dist/operator.js content regenerate --only seasons,seasons-hemispheres
node dist/operator.js content production-status --only seasons,seasons-hemispheres      # regeneration: held once produced
```

`--only` is required. A recipe is skipped with its reason: `not_v2` (v1 recipes are never regenerated), `not_published` (use `produce-library`), `held` (release or reject the waiting revision first), `spent` (its three takes of this production version are used; a new writer version gives new ones, D-197), `stopped` (an attempt of unknown outcome: `reasoning unknown`). Then read, release or reject, and run `admit-continuity` and `readmit-coverage` again, as above.

**Leaving a wave.** Record the yield (recipes held, released, rejected, unchecked), the tokens (sum the `attempts` of `production-status`) and the top findings of `reasoning rejected` in the tracker.

## Checking stored ask answers (S-7b to S-7d, D-250 to D-252, D-263, D-265, D-280 to D-282)

A person's question from a Scroll becomes a short answer made for them (an ask order, D-218). Nobody reads it first, so its job runs a second model, the **support
check**, which reads each sentence against the passages the answer cites; an answer with a sentence they do not support is repaired once or refused, and
the person gets the honest "could not prepare" state, never an unchecked answer. How it works: [content/production README](../../../packages/backend/src/modules/content/production/README.md).

`content ask-check` runs the same checker again over answers that were already made, to see what it says. It publishes, stores and changes nothing, and it
never reads a person's question (the check does not use one). It calls the production harness, so every request is an attempt in the ledger and spends the
production budget (`KS_REASONING_PRODUCTION_ENABLED=1`, `KS_MINIMAX_MODEL=MiniMax-M3.1-Flash`; any other model is refused).

```sh
node dist/operator.js content ask-check --recent 5 --out /var/tmp/ks-v3-spike/ask-check-580.jsonl
node dist/operator.js content ask-check --asset <asset id>[,<asset id>…] --out /var/tmp/ks-v3-spike/ask-check-580.jsonl
node dist/operator.js content ask-check --recent 5 --out /var/tmp/ks-v3-spike/ask-check-candidate.jsonl --checker-instructions /var/tmp/ks-v3-spike/checker-candidate.txt
```

`--recent <n>` takes the newest published ask answers (1 to 20), `--asset` names them (at most 20; an asset that is not a stored ask answer is reported as
`not_replayable` and asks the model nothing). `--out` is required.

**Trying a change to the checker's instructions (D-280).** `--checker-instructions <absolute path>` asks the checker with the instructions in that file instead of the production ones, so a
change can be measured on dev before it is built into a version. Copy the file to the server first (an absolute path, UTF-8 plain text, at most 16 KiB; the text of the version in the
repository is itself a valid candidate). Everything else is the same: the same batches, the same rules applied to every reply, nothing stored, and the model must
still be `MiniMax-M3.1-Flash`. A candidate has a role id of its own (`content.ask-support-check-candidate`), so its daily budget and its failure brake (five failed runs a day)
are its own: a candidate that keeps failing stops candidates until 00:00 UTC, and never the checks of real asks. It does count against the production scope's daily request cap
(`KS_REASONING_PRODUCTION_REQUESTS_PER_DAY`), which is shared by every role, so a replay of 20 answers can use up requests that asks and library takes also need. Every line on standard output (and every line in the file) then carries `"candidate": true` and `"candidateSha256"`, the SHA-256 of the file, and the ledger
records the requests under the role version `ask-support-check.cand-<first 8 characters of the hash>`, so a candidate's runs are never taken for the production checker's. A file that is
not absolute, under `/etc`, `/proc` or `/root/.ssh`, a link (or reached through one), not a plain file, too big, not UTF-8, blank, not plain text, or not instructions for this checker
(any `NAME=value` line, or any of `"supported"`, `"unsupported"`, `"no_claim"` missing: a settings file named by mistake is refused) is refused with a one-word code and exit status 2, before anything is touched.
The text goes to the provider and into the request store, so never put a secret in a candidate file. No other operator command
accepts the option, and the job that serves people never reads such a file. To compare, run the same `--asset` list with the candidate and without it, and read `codes` first: a
high `quote_not_about_sentence` or `no_claim_without_ground` count is the code's rule deciding, not the checker's judgement.

- **Standard output** is one JSON line for each answer: its asset ID, `outcome` (`checked`, `unchecked` with a `code`, `paused`, `not_replayable`), the counts of
  sentences, supported, unsupported and no-claim, the batches (a long answer is checked ten sentences at a time), the requests sent (one for each batch, and one
  more when the harness repaired an unusable reply) and `codes`: how many sentences code set aside as unsupported, for each rule that did it
  (`quote_not_in_cited_passages`, `quote_not_about_sentence`, `quote_too_short`, `no_claim_without_ground`, `too_many_no_claim`), and how many `no_claim` verdicts passed on each ground (`no_claim_label`, `no_claim_gap`, `no_claim_question`, `no_claim_unshared`): a high `no_claim_label` or `no_claim_unshared` is the place to look for a checker that waves sentences through. No sentence, title or question is
  printed, so the output may be pasted into an issue.
- **The file** gets one JSON line for each checked answer: its title, and every sentence with the passages it cites and the checker's verdict (the quote for a supported
  sentence; the kind and the note for an unsupported one, and the rule's `code` when code set it aside). It holds the answer's own words, which can echo a person's question, so read it from the server shell, never paste it into an issue, and **delete the file as soon as you have read it** (`shred -u <file>` or `rm <file>`). The command creates it readable by its owner only.
- **Exit status:** 0 when it ran to the end, 2 when it was refused or stopped early (a spent budget or quota, an attempt of unknown outcome, the wrong model), 1 on a failure.

What the checker is, and is not: code checks the shape of the reply (a sentence skipped or reordered refuses the reply), and judges each verdict on its own sentence: a `supported` verdict that does not quote real words of a passage the sentence cites, or whose words are not about the sentence, makes that sentence unsupported with a `code` (D-250, D-263, D-265). A high count in `codes` means the checker's quotes are the problem, not the answer's sentences. Whether the words support the sentence is the checker model's judgement, and this replay is how it is measured. What to look for: the sentences you know are wrong should be `unsupported`; a good answer's sentences should be `supported` with a quote you can find in the answer's
passages, and the quote should say what the sentence says, not only share its words. Many `unsupported` verdicts on sentences that are fine mean the checker is too strict (people will see "could not prepare" more often); `supported` on a
sentence that says more than its passage means it is too lenient. Both are reasons to change the checker's instructions (a new `ask-support-check` version and the
pair in `versions.test.ts`), not to read answers by hand.

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
