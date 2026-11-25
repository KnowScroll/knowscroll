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
KS_SUPPLY_GROWTH_DAILY_CAP=10                # API and worker: new Scrolls from stored recipes per day, held for a read (default 10; D-412)
KS_SUPPLY_ASK_DAILY_CAP=8                    # API and worker: ask orders (a short Scroll for one person's question) per day (D-218)
KS_SUPPLY_ASK_PERSON_DAILY_CAP=5             # API and worker: ask orders one person may have made per day (default 5; D-218)
KS_SUPPLY_SCENARIO_DAILY_CAP=6               # API: branches of content threads (What if, perspectives) per day (D-049)
KS_SUPPLY_SCENARIO_THREAD_DAILY_CAP=5        # API: branches one thread may have ordered per UTC day (default 5; D-158)

# seed the library through the same jobs Quartermaster sends (the worker runs them)
node dist/operator.js content production-status [--only seasons,tides]
node dist/operator.js content produce-library --dry-run [--only seasons,tides] [--interactive-first]
node dist/operator.js content produce-library [--only seasons,tides] [--interactive-first]

# recipes stored in the database (D-412): propose them, list them, make them (see "New recipes for planets that exist")
node dist/operator.js content propose-recipes --topic earth.tides --dry-run
node dist/operator.js content propose-recipes --topic earth.tides [--facet earth.tides.<facet>] [--retry 1]
node dist/operator.js content recipes [--status checked|queued|produced|retired]

# new topics under existing systems (D-422): the candidate pages code found, and a model's placement of one (see "New topics grow from pages the library trusts")
node dist/operator.js content topic-candidates [--status pending|eligible|rejected|proposed|refused|admitted|blocked_unknown]
node dist/operator.js content propose-topic --page https://en.wikipedia.org/wiki/<candidate page> --dry-run
node dist/operator.js content propose-topic --page https://en.wikipedia.org/wiki/<candidate page>
node dist/operator.js content topic approve --topic <topic id>
node dist/operator.js content topic reject --topic <topic id>
node dist/operator.js content produce-library --only gen-<key> --dry-run

# the topic catalogue as data (D-419): import the library plan as the next release, make topics with released supply servable (see "The topic catalogue")
node dist/operator.js content catalogue sync --dry-run
node dist/operator.js content catalogue sync
node dist/operator.js content catalogue status

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

### The Scrolls made to order are switched off (D-436, #784) and have no writer (#818, D-443)

"You asked" (an ask order), "What if" and "Another perspective" (a branch inside a thread) are the Scrolls made to order: each was a production for one person or
one thread, written with the v1 writer, which is deleted (#818, D-443: the owner's "Delete it now."). One switch turns all three off together: `KS_MADE_TO_ORDER_ENABLED`, read by the API
**and** the worker, **off in every world** unless it is `1` (the Ansible roles do not set it, so no world has it on). While it is off:

- the API refuses to make one: an ask closes `budget_unavailable` with the limit `off`, a retry is `not_retryable`, a What if draft or a choice is `made_to_order_off` (answered as `SHARING_UNAVAILABLE`, 404);
- the worker ends every `content.produce-answer` job and every `order-…` job of `content.produce-scroll` as skipped (`content.scroll_production_finished` with `outcome: skipped`, `reasonCode: made_to_order_off`). A skipped delivery is complete, so pg-boss never retries it, and no run, attempt or paid request is made;
- the app (it asks the API, `GET /v1/account/features`) shows no way in: no Ask row or key, no suggested questions, no What if or Another perspective, no branch cards or Map, and no question asked from a Scroll in "Your requests".

Nothing is deleted: orders and Scrolls already made stay in the database and can still be read by ID; the cleanup of the dev database is a separate step that needs the owner's go. To check the switch in a world,
read `GET /v1/account/features` as a signed-in person: `madeToOrder` is `false` unless the API's environment sets it. **Turning them back on needs a document v3 writer for these Scrolls first** (D-436). There is no writer now: with the
switch set to `1`, an `order-…` job that reaches production is ended before any research or request as `rejected` with the code `made_to_order_unavailable` (`content.scroll_production_finished`, `outcome: rejected`), so setting the switch alone writes nothing and spends nothing. The product rules the v1 writer carried for the three modes are kept word for word in D-443.

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

### Planned demand that lost its resolver

The Planner's demand (`deferred` rows of origin `planner`) is closed by its resolver at the 30-minute limit. A row still
open ten minutes past it has lost its resolver (a poll chain dead-lettered, a worker down): the next plan that asks for the
same brief closes it, and for a planet no plan asks about again this command does:

```sh
node dist/operator.js supply expire-stale-planned-demand --dry-run            # counts the stale rows, sends nothing
node dist/operator.js supply expire-stale-planned-demand --limit 100           # one resolver job for each, oldest first
```

It prints `stale`, `queued`, `alreadyQueued` and `more` (run it again when `more` is true). Running it twice on one day
sends nothing new. The resolver closes each row as `could_not_prepare` under the person's own scope and commissions
nothing for demand this old; the command itself calls no provider and changes no row. What became of the Planner's
opportunities (reused, commissioned, not commissioned and why, expired) is counted in `ops.planned_demand_outcomes` and
shown under "Planner demand" in panel 3 of the Operator screen.

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
are already published, and for the Reels made from an approved script (a Reel's coverage is decided at
its publication too, D-421). It is idempotent and appends corrected heads only where the decision changed.
After the release that gave Reels coverage, run it once: the Reels already published get their first head, and
the readers of their units are marked for another look at their places.

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

The bound is **six model requests per take** for a library recipe (all of them are document v3 recipes): the writer once and at most two repairs (the second only when copies are all that is left, D-445: three requests at most, so the claim of 2,100 s is unchanged), and the answer check of a document v3 sends none (a v2 take's checks were deleted, #815). The v1 writer's two-request take is deleted with it (#818). A refusal ends the
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
| `copied_passage` | Nine words in a row match a source passage. The repair is told, for each block, the passage words it copied (at most six runs of twenty words, `<repair-notes>`, D-294). |
| `authoring_number_not_in_evidence` | A figure (or a plotted chart value) is in no passage the block cites. |
| `too_big` / `too_small` at a field | A length limit; the finding names the field and the limit. |
| `OUTPUT_NOT_ONE_JSON_OBJECT` | The reply is not one JSON object; the detail says where it stopped being JSON. |
| `OUTPUT_TRUNCATED` | The reply hit the token ceiling, usually because the model thought too long. |
| `reading_length_out_of_brief` | Under two or over eight minutes of reading. |
| `MODEL_MISMATCH` (attempt code) | The route answered with another model than the configured one. |

## The v2 writer spike (deleted)

`content writer-spike-v2` is gone (#815). It ran the v15 writer of `scroll-document.v2` on real recipes before the V3 engine was built (S-0, D-120 to D-126), and nothing produces a v2 Scroll any more. The measure of the document v3 writer is the spike below. What the v2 spike found stays in the decisions it produced.

## The v3 writer spike (#771)

Before any recipe is planned as a `scroll-document.v3`, the team measures how the document v3 writer does on real recipes, in two arms. Arm `a` asks for the whole Scroll in one reply. Arm `b` asks for the prose, then asks a second request to stage it (the pictures, and what each paragraph shows, links and controls). The command **admits and publishes nothing** and needs no migration. Status: implemented, **not yet run on real MiniMax**.

```sh
# worker environment as above: KS_REASONING_PRODUCTION_ENABLED=1, KS_MINIMAX_MODEL=MiniMax-M3.1-Flash (the only model it accepts)
node dist/operator.js content writer-spike-v3 --topics <recipe key,…> --arms <a,b> [--raw-dir <absolute dir>] [--out <file>] [--concurrency <1-4>] [--spike-id <id>]
node dist/operator.js content writer-spike-v3-blind --in <out file> --page <html file> --key <key file> [--seed <n>]
```

The ten recipes, each with a plan of the spike's own (the library marks none as v3). Every plan has three sections and no misconception. A recipe with named pictures must write exactly those kinds; for the others the writer chooses one to three kinds.

| Recipe | Shape | Named pictures |
|---|---|---|
| `seasons` | argument | a statement, a grid |
| `tides-spring-neap` | mechanism | a cycle |
| `greenhouse-radiation` | mechanism | two flows |
| `cardiac-cycle` | mechanism | a cycle, a grid |
| `black-hole-formation` | story | a flow, a grid |
| `gradient-descent` | mechanism | the writer chooses |
| `dns-lookup` | mechanism | the writer chooses |
| `industrial-causes` | argument | the writer chooses |
| `immune-memory` | mechanism | the writer chooses |
| `exoplanet-kinds` | argument | the writer chooses |

Each recipe runs in each arm: `--topics` times `--arms` jobs. A job sends at most three requests in arm `a` and six in arm `b` (the writer or the stager, and up to two repairs of each, D-445). All ten recipes in both arms is at most 90 requests. Run them in two halves of five recipes if the MiniMax window is short; the production scope's daily caps (`KS_REASONING_PRODUCTION_*`) apply as for every production call.

```sh
node dist/operator.js content writer-spike-v3 --topics seasons,tides-spring-neap,greenhouse-radiation,cardiac-cycle,black-hole-formation --arms a,b --concurrency 2 --spike-id writer-v3-1 --raw-dir /var/tmp/ks-v3-spike/raw --out /var/tmp/ks-v3-spike/writer-v3-1.jsonl
node dist/operator.js content writer-spike-v3 --topics gradient-descent,dns-lookup,industrial-causes,immune-memory,exoplanet-kinds --arms a,b --concurrency 2 --spike-id writer-v3-2 --raw-dir /var/tmp/ks-v3-spike/raw --out /var/tmp/ks-v3-spike/writer-v3-2.jsonl
```

### Reading the output

One JSON line on stdout for the start (`result: "starting"`), one for each job as it finishes (`result: "job"`), and one for the end (`done` or `stopped`). The exit status is 0 when every job was accepted or rejected on its merits, 2 when the command was refused or stopped early, and 1 on a failure. A job line never holds any text of the Scroll.

| Field | Meaning |
|---|---|
| `key`, `arm`, `spikeId` | The recipe, the arm and this spike run. |
| `outcome` | As for v2: `accepted_first_take` (no step needed a repair), `accepted_after_repair`, `rejected` (a step and its repair were both refused), `research_failed`, `evidence_insufficient`, `provider_failed`, `model_mismatch`, `paused`, `unknown`, `refused`, `scope_refused`. In arm `b` a refused prose means the staging was never sent. |
| `steps` | One entry for each harness run: `step` (`one`; or `prose` then `staging`), `runId`, `roleVersion`, `outcome`, `requests`, `findings` (`{attempt, code, path}` for each refused answer: the repair's reason, at the model's own item or at `stage.N` for staging), `tokens`, `attempts`, `models` and `wallMs`. |
| `requests`, `tokens`, `wallMs` | Totals over the steps (`wallMs` has `research` and `total`). `tokens.output` includes thinking. |
| `document` | For an accepted job: `sections`, `beats`, `words` (the paragraphs' words, which the 350 to 700 bound counts), `readingMinutes`, `picturesByKind`, `shows`, `links`, `controls`, `asides`, `takeawayWords`, and `plannedKinds` against `writtenKinds`. `null` otherwise. |
| `rawFiles`, `rawFilesFailed` | The raw reply files written, and how many could not be. |

To compare the arms: for each recipe, put the two lines side by side. Compare the outcome, the requests and tokens (arm `b` always pays at least two requests), the findings, and the `document` numbers. Then read the essays blind.

### Raw replies and the blind read

With `--raw-dir`, every paid attempt is written to `<raw dir>/<spike id>/<recipe>.<arm>.<step>.<n>.json`: `{ key, arm, step, attempt, attemptId, state, model, text }`. `text` is the accepted output (written again as JSON), or the refused answer the harness kept (`null` if it kept none). Read a refused answer's findings with `reasoning rejected --attempt <attemptId>` as for v2.

`--out` appends one line for each accepted job: `{ key, arm, spikeId, document, citations }`.

`content writer-spike-v3-blind` turns the `--out` file into one HTML page and a key file. The page shows each essay under a letter (Essay A, B, C and so on, in an order the seed decides): title, dek, section titles, paragraphs, quotations with who, work and year, asides marked as asides, "To sum up", and a boxed line wherever a paragraph shows a picture, with the picture's title and the words a screen reader would hear. The page names no arm, recipe, run or model. It is one self-contained file: open it in a browser, on a phone or in dark mode. The key file maps each letter to `{ key, arm }`; open it only after reading. Without `--seed` the command picks one and prints it, so the same order can be made again.

The raw folder, the `--out` file, the page and the key hold the model's own text about public sources. They are local files: keep them outside the repository, and never paste them, or the essays, into an issue or a pull request. Paste the job lines (they hold no text) instead.

### Running it again

Each run starts fresh and remembers nothing: reconcile every `unknown` attempt first (`reasoning unknown`), then re-run only the jobs in `notStarted` and `stoppedBy.job`. A new `--spike-id` gives a new raw folder.

## Producing a document v3 Scroll (#783)

A recipe becomes a `scroll-document.v3` Scroll only when the library plan marks it: `scrollV3` on the recipe, with the kind of essay (`shape`), one intent for each section, the pictures it must have (kind and purpose, optional: without them the writer chooses one to three kinds) and its `misconception`, either `none` or a myth whose source label a person has `reviewed`. A person decides it, recipe by recipe, in a pull request; the writer and the system never do. A recipe carries `scrollV3` or `scrollV2`, never both. Status: implemented, tested with a fixture model; **not yet run on real MiniMax**. The 22 recipes that had a drawing kit are marked since #787 (next section); no other recipe is.

The writer asks the model once for the whole Scroll (arm (a) of #771) and the harness repairs one refusal, so a take sends at most two paid requests. The model never sets the kicker, the theme, the framing or the misconception: the plan does. A v3 library Scroll is **held**, like a v2 one, and the commands are the same.

Once a recipe is marked and the build is on dev:

```sh
node dist/operator.js content produce-library --dry-run --only <recipe key,…>   # lists the recipe as wouldQueue; a recipe that already has a document v3 is skipped
node dist/operator.js content produce-library --only <recipe key,…>
node dist/operator.js content production-status --only <recipe key,…>          # `held` once produced; `published` only after release
node dist/operator.js content review-show --asset <asset id> --sources         # read it as a reader does, with the passages each part cites
node dist/operator.js content release --asset <asset id> --revision <n>        # or reject, with a reason; or leave it to the release policy
```

A direct run of one recipe is `content produce-scroll --topic <key> [--take <n>]`. A take is refused until the earlier one was rejected, or released (a document v3 may be taken again after a release, as a v2 may: the new revision is held and the served one keeps serving). A recipe has three takes at a production version; the current one for a document v3 is `scroll-production-v3.v5` (D-445: a second repair when the first repair's findings are all copies, and a repair changes only the parts its notes name; `.v4` was D-444, `.v3` D-441 and `.v2` D-438). Takes made at an earlier version do not count against `.v5`, so every recipe whose served Scroll is not yet a document v3 has three new takes (the four recipes stopped after three takes included), and a recipe whose served Scroll is already a document v3 is still skipped by `produce-library`. The revisions `.v1` to `.v4` wrote still read, release and are served. A take sends at most three writer requests now (the writer and two repairs); the second repair is for copies only, and every other finding keeps its one repair. `industrial-towns` can still be held only if its second chart is not the planned line of 17 in 1801 and 54 in 1891, which the figure rule does not accept (D-444, "Open"): decide that before spending its three takes.

**D-438.** A link of a paragraph that the writer's compile cannot place (its phrase is not in the paragraph exactly once, it overlaps a link kept before it, no picture is on screen, or its label is not a part of that picture) is dropped, and the Scroll is not refused for it. The job's `outcomes` then hold a receipt `{role: 'checks', kind: 'links_dropped', dropped: n}` with the count, never the words. The validator is as strict as before. A control that lights an item (a scrub along items, a pick) also reveals it, so a reader who chooses an item the beat's `upTo` had not reached sees it; the support check reads the words of that revealed state.

**D-439.** Before the research and the writer send anything, the job reads the recipe's asset once (no lock, no transaction held): if it is withdrawn or not a Scroll, the take ends at once as `rejected` with the `asset_conflict` receipt and no model request; `publish` still checks under the asset's lock. A take that ended `asset_conflict` (`{role: 'checks', kind: 'rejected', code: 'asset_conflict'}`: the Scroll passed every check and the publication step refused the asset) was refused before anything was stored and is not the writer's fault. It does not count toward the three takes while the asset is not withdrawn: `content production-status` then shows `takes` (those that count), `takesLeft`, `latestTake` (the highest take number) and `refusedTakes` (those that do not count, present only when there are some). A refused take keeps its number, because the number is part of the job's identity, so the next take follows the highest one (`content produce-library` and the status name it); a recipe never has more than three takes that count, and no take is numbered past six, so refused takes cannot loop paid production. While the asset is withdrawn, every take counts and the recipe stops at three, as before. A recipe whose only takes were refused is `retryable`, not `stopped`.

What happens after the job, with no person:

1. The delivery that held the Scroll sends its **support check**, under the checker version that reads a document v3 (`support-check-v3.…`). The sweep (every ten minutes) sends any it missed. `review-list --show-check` shows the verdict, once you have decided to look at it (D-415).
2. The **release policy** (when the owner has switched it on and approved the topic) releases the Scroll if every check passes, and holds it, with a code, if any does not. A document v3 that replaces a served v1 or v2 is released by the policy too, and its release retires the v1 or v2 (decisions 6 and 9 on #771). A v3 that would replace a served v3 (`replaces_served`) waits for a person: no decision covers releasing a served v3 again without one.

A refusal of the writer's reply that the repair does not mend ends the take as `rejected` with `invalid_output`. The job's receipts and `content production-status` show the code and the attempts, never the model's text. Fix the plan or the instructions and bump the writer version, which gives every recipe new takes. A **paused** take (a spent daily cap or quota) sends nothing and resumes the same job on the next send.

What to read for in a held v3 Scroll, besides what a v2 asks: the first paragraph stands alone as the cover; each picture says what its paragraph says (the support check reads the words of a picture, not what it draws); the "To sum up" is a person's plain ending, not the dek again; a negative figure is written with its sign.

## The kit recipes as document v3 Scrolls, kit by kit (#787)

The 22 recipes a drawing kit used to draw carry `scrollV3` and no kit. Marking them changes nothing a reader is served: each keeps serving its
current v1 or v2 Scroll until a v3 Scroll is produced, read and released. Until then `production-status` shows the recipe `not_started` (its served
Scroll is not a document v3), and `produce-library` queues its first take at `scroll-production-v3.v1`. Nothing was produced by the change; **an operator
does it on dev, one kit at a time**, in this order, and reads each kit's rewrites before anyone deletes that kit's code:

| # | Kit | Recipes | `--only` |
|---|---|---|---|
| 1 | black hole (`black-hole.v1`) | `black-hole-formation`, `black-hole-horizon`, `black-hole-evidence` | `black-hole-formation,black-hole-horizon,black-hole-evidence` |
| 2 | starlight (`starlight.v1`) | `stars-colour-brightness`, `exoplanet-habitable-zone` | `stars-colour-brightness,exoplanet-habitable-zone` |
| 3 | Earth & sky (`earth-sky.v1`) | `seasons`, `seasons-hemispheres`, `seasons-limits` | `seasons,seasons-hemispheres,seasons-limits` |

One recipe, the exact command (the first row's `black-hole-formation`; nothing is sent by the dry run):

```sh
# worker environment as above: KS_REASONING_PRODUCTION_ENABLED=1, KS_MINIMAX_MODEL=MiniMax-M3.1-Flash
node dist/operator.js content produce-library --dry-run --only black-hole-formation   # wouldQueue, take 1 at scroll-production-v3.v1
node dist/operator.js content produce-library --only black-hole-formation             # queues the job; the dev worker writes it and it ends held
node dist/operator.js content production-status --only black-hole-formation           # held = waiting; running; retryable = refused (see "When a Scroll is refused")
node dist/operator.js content review-list
node dist/operator.js content review-show --asset <asset id from review-list> --sources
node dist/operator.js content release --asset <asset id> --revision <n>             # or reject with a reason; or leave it to the release policy
```

For a kit with several recipes, name them all in `--only`, as in the table. A v3 that replaces a served v1 or v2 is released by the release policy when every
check passes; one that replaces a served v3 waits for a person (above). When the parts of a series are released, run `content admit-continuity` and
`content readmit-coverage` (steps 6 of "Running a library wave"): the Seasons series also holds `seasons-elsewhere`, the tides series
`tides-coasts` and the greenhouse series `greenhouse-limits` (document v3 recipes since #790, produced by "The other 33 recipes as document v3 Scrolls, by system" below), so admit those series after every part is released.

What to read for, besides the list under the previous section: the briefs of these recipes were narrowed to what their pages state (the library README says
how), so a Scroll that states more than its page is a finding; every figure in a picture is in a passage the writer was offered. A recipe has three takes
at the production version; if all are rejected, the plan or the brief needs a change (a code change), so stop and say so on #787.

The deletion of a kit is a later change, one kit at a time, after the owner has read that kit's rewrites. The v2 plans these recipes had were kept for the v2 spike until the v2 writer was deleted (#815); the kit's own code and the table left together.

## The other 33 recipes as document v3 Scrolls, by system (#790)

The other 33 recipes of the library carry `scrollV3` too, so **no library recipe is planned as v1 or v2 now**: the 32 plain v2 recipes (their v2 plans went with the v2 writer, #815) and the v1 recipe `exoplanet-kinds`. As for the kit recipes, marking
them changes nothing a reader is served: each keeps serving its current v1 or v2 Scroll until a v3 Scroll is produced, read and released, and
until then `production-status` shows it `not_started`. Supply never commissions a recipe the plan marks v2 or v3, so only this operator run makes
them. One thing does change for supply: `exoplanet-kinds` was the last code recipe supply could commission (a v1 recipe, D-138), so since #790
a reader's ask or the Planner's demand for a Scroll the library has not made yet starts production only for a stored (`gen-`) recipe, within
the growth cap; with none, the ask closes as `no_recipe_left` and is counted as a gap. Nothing was produced by the change. **An operator does it on dev, one batch at a time**, in this order (small batches first; every series
is inside one batch, except the three Earth & sky parts, which wait for their kit batch above: Earth & sky; the tides batch is done, #799, and the greenhouse batch, #802, and the nerve batch, #809):

| # | Batch | Recipes | `--only` |
|---|---|---|---|
| 1 | Space (v1 today) | `exoplanet-kinds` | `exoplanet-kinds` |
| 2 | Human body, immune system | `innate-immunity`, `adaptive-immunity`, `immune-memory` | `innate-immunity,adaptive-immunity,immune-memory` |
| 3 | History | `industrial-causes`, `steam-power`, `factory-system`, `industrial-towns`, `industrial-debate` | `industrial-causes,steam-power,factory-system,industrial-towns,industrial-debate` |
| 4 | Computing | `dns-lookup`, `https-handshake`, `web-caching`, `rendering-pipeline`, `event-loop`, `same-origin-policy`, `big-o-growth`, `hybrid-sorting`, `hash-tables` | `dns-lookup,https-handshake,web-caching,rendering-pipeline,event-loop,same-origin-policy,big-o-growth,hybrid-sorting,hash-tables` |
| 5 | Machine learning, attention and its neighbours | `attention-mechanism`, `attention-example`, `attention-limits`, `transformer-architecture`, `token-embeddings`, `next-token-generation` | `attention-mechanism,attention-example,attention-limits,transformer-architecture,token-embeddings,next-token-generation` |
| 6 | Machine learning, training and cost | `training-by-example`, `gradient-descent`, `overfitting`, `long-input-cost`, `mixture-of-experts`, `subword-tokens` | `training-by-example,gradient-descent,overfitting,long-input-cost,mixture-of-experts,subword-tokens` |
| 7 | Earth & sky, after the Earth & sky kit batch (3) | `tides-coasts`, `greenhouse-limits`, `seasons-elsewhere` | `tides-coasts,greenhouse-limits,seasons-elsewhere` |

One batch, the exact command (the first batch of three recipes, number 2; nothing is sent by the dry run):

```sh
# worker environment as above: KS_REASONING_PRODUCTION_ENABLED=1, KS_MINIMAX_MODEL=MiniMax-M3.1-Flash
node dist/operator.js content produce-library --dry-run --only innate-immunity,adaptive-immunity,immune-memory   # wouldQueue, take 1 each at scroll-production-v3.v1
node dist/operator.js content produce-library --only innate-immunity,adaptive-immunity,immune-memory             # queues the jobs; the dev worker writes them and each ends held
node dist/operator.js content production-status --only innate-immunity,adaptive-immunity,immune-memory           # held = waiting; running; retryable = refused (see "When a Scroll is refused")
node dist/operator.js content review-list
node dist/operator.js content review-show --asset <asset id from review-list> --sources
node dist/operator.js content release --asset <asset id> --revision <n>             # or reject with a reason; or leave it to the release policy
```

When a batch is released, run `content admit-continuity` and `content readmit-coverage` (steps 6 of "Running a library wave"): the immune-system, web-requests, algorithms, Industrial
Revolution, attention and training series are each inside one batch, so each can be admitted whole.

What to read for: the briefs of these recipes were narrowed to what their pages state, and three recipes got a second page because the first one did not state the brief's central point
(`dns-lookup`, `attention-limits`, `next-token-generation`), so a Scroll that states more than its pages is a finding. Every figure in a
picture is in a passage the writer was offered; a chart that shows `142` for the autumn of Mars (`seasons-elsewhere`) rests on a page that writes it as "142 days" beside three lengths in sols,
which fill the Martian year, so check that Scroll's chart. A recipe has three takes at the production version; if all are rejected, the plan or the brief needs a change (a code change): stop and say so on #790.

## A v2 Scroll is no longer produced (#815)

No recipe is planned as a `scroll-document.v2` Scroll, and the code that wrote one is deleted: the v2 writer, its stored compile, the plan fields (`scrollV2`, `stageKit`, `stagePlan`) and the spike. Every library recipe is a document v3 recipe (#787, #790): see "Producing a document v3 Scroll". What stays is the reading side, because stage and main still store and serve the v2 Scrolls the writer made: the review gate and the release policy over a stored v2 revision, its coverage, its reading facts and its serving to an older app (D-433). `content produce-library`, `produce-scroll`, `production-status` and `readmit-coverage` work as they do for document v3 recipes.

A client that does not declare `scroll-document.v2` is offered the previous v1 revision of a regenerated Scroll, and a direct open of a v2 asset by such a client says it needs an app update. Explore and `/scroll/<id>` of this app declare v2 and draw it with Folio's essay (D-425).

## The review gate for v2 library Scrolls (S-1e, D-138)

Every wave of v2 Scrolls gets a factual read by a person before anyone is served it (D-123). The gate is that read. It applies to a v2 library recipe however the job was sent: the operator's library run, `produce-scroll`, or a retry. A v1 recipe and a Scroll ordered from a thread publish as they always did.

**What held means.** The revision is stored, with its provenance, topic and coverage. It is not the asset's current revision, so discovery, Explore, series and related moves, the Universe's regions, sharing, saved items and opening a Scroll do not see it. A Scroll that already serves an earlier revision keeps serving it. A brand-new asset stays `held` and cannot be opened. `production-status` shows the recipe as `held` (with `heldRevision`), never `published`. `produce-library` skips a held recipe, and a person's ask never makes Quartermaster write a v2 recipe.

```sh
node dist/operator.js content review-list [--all] [--show-check]    # held revisions: recipe, revision, title, words, minutes, picture, coverage, what the answer check said. --all adds released and rejected, with who and when. --show-check adds what the support check said (hidden while it is measured)
node dist/operator.js content review-show --asset <asset id> [--revision <n>] [--sources] [--show-check]   # the Scroll as plain text, to read on the server
node dist/operator.js content release --asset <asset id> --revision <n>                      # serve exactly this revision
node dist/operator.js content reject  --asset <asset id> --revision <n> --reason "<why>"      # keep it out, free the next take
```

All four refuse worlds other than `local`, `ci`, `dev` and `stage`, use the shared database only, and call no provider. `review-list` prints one JSON line with titles and counts, never body text. `review-show` prints the text to the terminal and nowhere else: do not paste it into an issue or a pull request. `--sources` adds, under each stop, aside and the recap, the exact source passages it cites, and the pages at the end, so a statement can be checked against its source. `release` and `reject` record who ran them (`cli:<your user>`) and when, write a `content.review_decided` line to the event log on stderr (recipe key, outcome, revision, a refusal's code; no text), and are safe to repeat: a second `release` answers `already_released`, a second `reject` answers `already_rejected` and keeps the first reason. Exit status is 0 for a decision or a repeat and 2 for a refusal (`not_under_review`, `revision_rejected`, `revision_released`, `not_newer_than_served`, `asset_withdrawn`, `reason_invalid`).

### Reviewing in the app (#780)

On `dev` and `stage` an operator can do the same read in the app instead of a terminal. Sign in with an operator account (`KS_OPERATOR_ACCOUNTS`), open `/operator`, and press **Review held Scrolls** (`/operator/review`).

1. The list shows every held revision, oldest first: title, kicker, document version, topic, recipe, when it was held, and in words what the support check and the answer check said and whether coverage is mapped. **Refresh** reads it again.
2. Open one. You see its **cover** as Explore draws it, with the checks in plain words above it (a model's opinion that informs the read and decides nothing). Press **Read** to open the essay in Folio, with its pictures drawn by the real renderer. **Sources** puts, under each beat, the passages it cites word for word with the title of their page, and the parts no beat carries (a picture, "To sum up") at the end. **Unfold** and **Fold** show or hide the checks; the sentences the support check could not clear are listed first.
3. At the end of the essay, **Release** and **Reject** each ask once, in the page. Reject needs a reason (up to 500 characters). Both call the same review gate as `content release` and `content reject`: idempotent, one transaction under the asset's lock. After a decision the app returns to the list. If the gate refuses (for example `coverage_missing`: a document v3 cannot be released until its coverage is mapped), the page says why in words and stays.

Only an operator account sees any of it, and only in an operator world (`dev`, `stage`, `ci`, `local`, as the CLI): in `live` every route answers not found even to an address in `KS_OPERATOR_ACCOUNTS`. Anyone else, and a revision that is no longer held, gets the same "This page isn't here". A decision made in the app records `app:` and a short fingerprint of your account id as who decided it, never your address. It is not counted by the support check's replay (D-415), because the app shows you the verdict: for the measure, keep deciding blind with `review-list` and `review-show` (no `--show-check`). After a release, run `content admit-continuity` and `content readmit-coverage` as before: the app does not run them.

### The answer check (S-6a, D-198)

Before the v2 writer was deleted (#815), a second model checked, before a v2 library Scroll was stored, that the answer key of each call agrees with the call's own words. That model step and the writer's one repair after a flag are deleted with the writer: a document v3 has no calls, so its job records the check as passed, with no request. A stored v2 revision keeps the check its job recorded, and the review and the release policy still read it:

| What `review-list` and `review-show` say | What happened | What you do |
|---|---|---|
| `passed` | Every call was consistent in the first draft. | Read it as usual. |
| `repaired` | The first draft had a flagged call. The writer corrected it once, and the stored draft passed. The first draft's flags are printed, each with the question, the options (the marked one is named) and the explanation as the checker saw them, because that draft is not stored. | Read those calls first in the stored draft: check the repair did not swap one problem for another. |
| `NOT CHECKED (<code>)` | The checker gave no usable answer (`provider_failed`, `outcome_unknown`, `invalid_output`, `refused_…`). The Scroll is held with no verdict. | Read every call's answer key yourself. For `outcome_unknown`, the attempt is listed by `reasoning unknown`. |
| _not run_ | The revision was made before the check existed. | Read every call. |

A v2 Scroll that was still flagged after the one repair was never stored (its take was spent), so no stored revision says `flagged`; `production-status` may still show `check.outcome: flagged` for an old job, with the checker's problem and the call itself.

### What to read for

The checks the machine cannot make (D-123): the picture matches each stop's words (the month decides the pins and Ray); no sentence calls Earth's axis sideways; each statement is in the passages it cites (`--sources`); the correct option of each call is correct and the wrong ones are plausible; the Final call is a new case and not a repeat of an earlier call; the Plot twist reads warm; a plain Scroll about other worlds says nothing the pages do not state; nothing is invented (dates, temperatures, season lengths).

### If you reject

`reject` keeps the revision stored and unserved for good (it is never released), leaves the earlier revision served if there is one, and spends that take. `production-status` then shows the recipe `retryable` and `produce-library --only <key>` queues the next take, which writes a new revision (the next number). A recipe has three takes in all. If you reject all three, the recipe is `stopped`: the brief or the pages need a change in the plan, which is a code change and a new production version, so stop and say so in the issue. Tell the next person why in the reason (500 characters, plain words); `review-list --all` shows it with who and when.

Nothing in the gate edits a revision: a Scroll is released as it was read. To correct a wording, reject and produce again.

## The topic catalogue (#674, slice 2.1, D-419)

Systems, planets and facets live in Postgres as numbered, append-only releases, so adding a topic needs no deploy of the code that reads it. The library
plan in TypeScript is still where an author writes them, and the first release is exactly that plan.

1. **Edit the plan** (`content/domain/library/*.ts`): add a planet with at least two facets, or a facet after the others, or change a meaning. A meaning
   that only rewords the old one lists the old text in `sameMeaningAs` of the same node (certificates decided against it stay valid); leave it out for a
   change of meaning. A new system may leave out its `sceneFamily` and `haze`.
2. **Preview.** `content catalogue sync --dry-run` prints the release it would make (counts, codes, how many nodes the plan no longer names) and writes nothing.
3. **Import.** `content catalogue sync` appends the release (the plan's changes, in as many releases as the 20,000-node limit needs) and then makes servable the
   topics whose supply has been released. Running it again makes nothing. Any refusal (an id taken, a parent missing, a duplicate label, a meaning out of
   bounds, a topic with fewer than two facets, a changed silhouette or haze) writes nothing and prints its code and the node.
4. **A new topic is invisible** to readers (not offered, not matched to a request, not a room, not a scout's choice) until the library has released three
   explanations over two of its facets. Write for it as for any planet (`content propose-recipes --topic <new planet>`, `content produce-library --only gen-<key>`,
   `content review-list`, `content release`); `showServableTopics` runs in the gap scan's every pass and in `content catalogue sync`, and makes the topic
   servable in a release of its own (`source` `visibility`).
5. **After a change of meaning**, run `content readmit-coverage [--dry-run]` to decide coverage again for the published Scrolls. A release changes
   only the digest, not any certificate: nothing needs doing after adding a topic.

`content catalogue status` prints the release, its digest and the counts of systems, planets, facets, servable planets, planets waiting for supply and, of those, the ones that grew and wait for your approval (`awaitingApproval`). A release is never
undone: a node is retired by a later release, never deleted, and its id is never reused. Nothing here calls a provider.

## New recipes for planets that exist (#674, slice 2.2, D-412)

Recipes can live in the database, and the system proposes new ones for the planets and facets the library already has. It makes no
planet, facet or system. A stored recipe is a **document v3** recipe (#781, owner decision 4 on #771): the proposal carries the `shape` of the essay
(`argument`, `mechanism` or `story`) and one intent per section (two or three), and the writer picks the picture kinds from the closed set by what its passages
hold; the statement picture is always available. A proposal may name a picture in its brief, but never a quiz or anything interactive. Every Scroll made from a
stored recipe is held for your read, like any document v3 library Scroll, and nobody is served it before `content release`. **The document v3 writer produces a stored recipe
(`content produce-library --only gen-<key>` runs it like a v3 library recipe, at `scroll-production-v3.v5`), and proposing and listing work.** A stored row that still holds the old plain v2 plan is refused as a plan problem (`plan_refused`, `stored_recipe_plan_not_v3`) and no job is
reserved. The flow:

1. **Propose.** `content propose-recipes --topic <planet id> [--facet <facet id>] [--retry <1-2>]` asks the model once (and repairs once) and stores the
   drafts code accepts as `checked` recipes. It sends no production job. `--dry-run` prints the counts of what it would send and calls no provider. It needs
   pages code already holds: a planet none of whose recipes was ever produced has none, and the command says `no_candidate_pages` without a request. The
   same request on the same UTC day reaches the same run and pays nothing again, even after other recipes were stored in between (the first delivery froze
   its context). Another day or another facet is a new request.
   The result lists the accepted recipes (key, facet, title, passage pool) and a count of refusals by code: `title_shape`, `brief_shape`,
   `text_has_address`, `text_has_markup`, `brief_names_block` (a quiz or something interactive named in the brief), `sections_shape` (not two or three
   distinct plain lines of 4 to 120 characters), `sections_name_block` (a quiz or something interactive named in a section), `facet_unknown`, `facet_not_requested`, `pages_duplicate`, `page_not_candidate`,
   `page_refused`, `pool_out_of_range`, `near_duplicate` (the same words, or the same facet on the same pages in other words), `identity_taken`. A refusal
   is a verdict on the draft, never a reason to loosen a check. The checks run again where the recipes are stored, under a lock for the planet, so
   two operators proposing at once cannot store the same angle.
   If a run ended without recipes, the same request says `closed_failed` (the model answered nothing code accepted, or its answer was invalid, or the
   provider refused) and gives `nextRetry`: ask again the same day with `--retry <n>`, at most twice. A `failed` result with `closed: false` (an attempt
   of unknown outcome, a refusal of the harness, a switched-off scope) leaves its run open: running the same command again resumes it and never resends
   an attempt that may have been sent. Write off an unknown attempt with `reasoning write-off` as for any other run.
2. **List.** `content recipes [--status]` shows each stored recipe with its planet, facet, status, page count and pool. It shows no brief and no page address.
3. **Produce.** Either wait for a reader's ask or the Planner's demand for the planet (Create may choose a stored recipe within
   `KS_SUPPLY_GROWTH_DAILY_CAP`, default 10 a day, counted apart from the people's and the Planner's caps), or send the job yourself with
   `content produce-library --only <key>` (or `content produce-scroll --topic <key>`). Your own runs are not capped, as before. Six paid requests at most a take,
   three takes at most, like any v2 or document v3 library recipe.
4. **Read and release.** `content review-list` shows the held Scroll with its recipe key; `content review-show --asset <id>` and `content release` or
   `content reject` are as in "The review gate" above. After a release, `content admit-continuity` and `content readmit-coverage` as before.
5. **Retire.** There is no command yet to retire a recipe. A recipe whose three takes were all rejected is `stopped` and never chosen again.

A reader's ask closes `could_not_prepare` once its stored recipe's Scroll is held, and can be tried again after the release (D-410).

## The library notices where it runs out (#674, slice 3.1, D-414)

The gap loop proposes new recipes by itself where readers are running out of content, within the day's budget. It makes no planet, facet or system, and
it releases nothing: every Scroll it makes is held for your read like any v2 library Scroll, so **your review is the one gate and the slow step**. It is
**off in every world** until `KS_SUPPLY_GROWTH_ENABLED=1` on the API and the worker (the coordinator turns it on for dev); the brief job also needs
`KS_REASONING_PRODUCTION_ENABLED=1` on the worker. To stop it, set the switch to `0` and restart: no signal is recorded, nothing is scanned, no model is asked
and no job is sent. `KS_SUPPLY_GROWTH_DAILY_CAP` (default 10) is the day's limit on new Scrolls from stored recipes, the same cap `content propose-recipes`' flow
uses; `KS_SUPPLY_GAP_DEPTH_TARGET` (default 6) is how many released explanations a planet should have before it stops counting as shallow.

1. **See the gaps.** `supply gaps [--status open|briefed|commissioned|closed|rejected|blocked_unknown]` prints the counts by status and kind, then the gaps,
   most pressing first: kind (`thin_planet`, `empty_facet`, `shallow_planet`, `demand`), planet, facet, priority, readers (reader-days over the last
   14 days), attempts, a reason code and how many recipes. It prints codes and catalogue ids only. `ops.supply_gaps` is the same data for a query.
2. **Read what it made.** A gap goes `open`, then `briefed` (recipes stored), then `commissioned` (production sent) as the job works through it, at most three gaps
   and one for each planet in a pass (twice an hour). Its Scrolls appear in `content review-list` as held, with their recipe keys, like any other.
   `content review-show`, `content release` and `content reject` are as in "The review gate" above. When you release a Scroll, the next scan (every fifteen minutes)
   closes the gap as `released`, and opens a fresh one if the planet is still thin. **A rejected take does not strand the gap**: when you reject a Scroll
   and its recipe may be taken again, and nothing else of the gap is running or held for your read, the scan puts the gap back to `briefed` and the loop
   commissions that same stored recipe again under the growth cap (another take, no model call); when every recipe ended for good the gap goes back to `open`
   and the model is asked for new recipes. Each of these counts a failed production round on the gap (`rounds` in `supply gaps`), and at
   `KS_SUPPLY_GAP_MAX_ROUNDS` (default 3) the gap is rejected as `production_rejected` and not tried again, so reject for a reason, not for taste.
3. **The loop's brake.** It does not pile work on your read: a planet with three recipes running or held, or a facet with one, is only noted as
   `commissioned` and nothing is spent. It proposes only while the growth cap leaves room to produce what comes back, and the day's proposing attempts stay
   below the cap. A planet that holds no page yet (none of its recipes was ever produced) is rejected at once as `no_candidate_pages`, at no cost, and looked
   at again after seven days: produce its first recipe by hand (`content produce-library --only <key>`) to let the loop take over.
4. **A rejected gap.** After two attempts that stored nothing, a gap is `rejected` with the reason (`nothing_accepted`, `model_failed`, `closed`). It opens
   again only when readers point to the same planet or facet after seven days. A planet or facet the catalogue no longer holds is never opened again.
5. **A blocked gap** (`blocked_unknown`). Its proposing attempt has an unknown outcome (the worker stopped while the request was out, or the harness refused after
   dispatch): the loop never sends it again. Find the attempt with `reasoning unknown` and write it off with `reasoning write-off --attempt <uuid> --reason <text>`
   as for any other unknown attempt (the write-off settles the ledger's liability; it does not reopen the gap). The gap stays blocked while its hole remains, so the
   loop never tries that hole again on its own; the scan closes it once the hole fills (say, when you produce and release a Scroll for it by hand). To let the loop
   try again, or to end it, use `supply gaps settle --key <the gap's 64-character key> [--reopen | --close]` after the write-off: it refuses, and says why, while the
   attempt is still reserved, dispatched or unknown in the ledger, for a gap that is not blocked, and for one that names no run (`supply gaps settle --key <hex>` with
   neither flag only reports whether the ledger is settled). `--reopen` counts the blocked attempt as a failed one, so the next request is a new one.
6. **Cost.** At most one model request and one repair for each proposing attempt, on the production harness and its attempt ledger, counted against the
   production caps. Two passes never overlap (the second does nothing while the first holds its lock), and a test account's reading is never counted. A redelivered job or a restarted worker repeats nothing that was paid: the gap pins the UTC day of its attempt and the same request is
   answered by the ledger, even after midnight.

## New topics grow from pages the library trusts (#674, slice 3.4, D-422)

Topics can grow under the systems that exist, with no engineer choosing them. Code finds the candidate pages, a model places one and names its facets, code admits it
or not, and the topic then waits, **invisible to readers**, for the same supply every new topic waits for: three explanations over two of its facets, released by you.
It makes no system (new systems are the owner's), serves nothing and releases nothing: every Scroll written for it is held for your read like any other, and **a topic that grew is not servable until you approve it** (step 2), however much supply it has. It is **off in
every world** until `KS_SUPPLY_GROWTH_ENABLED=1` **and** `KS_TOPIC_GROWTH_ENABLED=1` on the worker (and `KS_REASONING_PRODUCTION_ENABLED=1`); the coordinator turns it on for dev. Set either to
`0` and restart to stop it: no page is read, no model is asked, nothing is written. The research host list stays a human decision (`research/public-pages.ts`): growth fetches
nothing from a host that is not on it.

1. **See the candidates.** `content topic-candidates [--status ...]` prints the counts by status and the candidates, newest first: the page's address, its host, the status
   (`pending` found but not read, `eligible` read and fit, `rejected` with the code why, `proposed` a run in flight, `refused` with the code why, `admitted` with the topic made,
   `blocked_unknown`), the verdict code, how many attempts, and for an admitted one the topic's label, its facets' labels and whether it is servable yet. Rejection codes:
   `not_an_article`, `disambiguation`, `list_page`, `stub`, `duplicate_topic`, `duplicate_page`, `recipe_page`, `page_unreachable` and `page_<the fetch's code>`.
2. **Approve each topic before it can be served.** The label, meaning and facets of an admitted topic are the model's words, and they reach readers when the topic becomes servable. Read them
   in `content topic-candidates --status admitted` (the topic's label and meaning, each facet's label and meaning, whether it is servable, and your decision, which starts `pending`).
   `content topic approve --topic <id>` records who approved and when, and makes the topic servable at once if the library has already released its three explanations over two facets; otherwise it becomes
   servable at the next gap scan after they are. `content topic reject --topic <id>` retires the topic and its facets by a release (its id is never reused) and its held Scrolls need never be released.
   Nothing, not the gap scan, `content catalogue sync` nor a release made by hand, can make an unapproved topic servable (`not_approved`). A decision is made once and cannot be taken back; rewording or merging
   a topic that grew is not built, so reject it and let the loop find the page again only if the owner wants that. Recipes and Scrolls for a topic you have not decided yet may be produced meanwhile (held, within the growth cap).
3. **Its recipes and Scrolls.** The gap scan sees an admitted topic as a `thin_planet` hole (`supply gaps`) and the brief job proposes its first recipes from the page it grew from,
   within the growth cap; or ask yourself: `content propose-recipes --topic <the new topic id>`. Then it is the flow in "New recipes for planets that exist" and "The review gate":
   `content produce-library --only gen-<key>`, `content review-list`, `content release`; at three released explanations over two facets the next gap scan makes the topic servable in a release of its own.
4. **Ask by hand.** `content propose-topic --page <the address of an eligible candidate> [--dry-run]` asks the model once (and repairs once) for that candidate (it refuses with `busy` while a scheduled pass holds the lock, and with `backed_off` for a candidate that failed or that no system had room for today); `--dry-run` prints the
   counts of what would be sent and calls no provider. The page must be one code found: an operator never names a page of their own. A candidate that is `blocked_unknown` had an attempt of unknown outcome
   (find it with `reasoning unknown` and write it off as for any unknown attempt); it is never asked again.
5. **The brake.** At most one proposal a pass (twice an hour); no new run once today's runs reached `KS_SUPPLY_GROWTH_DAILY_CAP` (default 10); none while as many topics wait for supply as that cap;
   none when every system holds `KS_TOPIC_GROWTH_MAX_PER_SYSTEM` topics (default 12, servable or not). A candidate is asked about twice at most, on different days, and a candidate whose attempt failed waits for the next UTC day. If the provider is down the role's failure brake (five failed runs a day) pauses the step and blocks no candidate. Each request is at
   most one model request and one repair on the production harness (background class), counted against the production caps; a redelivered job repeats nothing that was paid.

## Running a library wave (S-6a, S-6b, D-197 to D-199, D-217)

A wave is a set of recipes produced, read and released together. The goal of the first waves: at least 20 stage Scrolls and 30 with calls, all admitted, each series whole, each read by a person. The plan marked the Seasons recipes, the thirty-five recipes of Human body, Computing, Machine learning and History (D-199) and the fifteen kit recipes of Earth & sky and Space (D-217). Since #787 the 22 recipes a kit drew are document v3 recipes, and since #790 all the others are: the commands below produce them as v3 Scrolls, and "The kit recipes as document v3 Scrolls, kit by kit" and "The other 33 recipes as document v3 Scrolls, by system" say in what order.

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

## Checking stored ask answers (deleted, #818, D-443)

`content ask-check` (it ran the support check again over stored "You asked" answers, with `--recent`, `--asset` and `--checker-instructions`) is deleted with the v1 writer and the ask order's support check (D-250 to D-376). Made to order is switched off in every world (D-436) and has no writer, so there are no new ask answers to check; the answers already stored stay readable. The checker role itself stays, because a Quick answer, a resident's answer in a room and the library support check use it: [content/production README](../../../packages/backend/src/modules/content/production/README.md), "The shared support checker". What the library check measures, and how, is the next section.

## Measure the library support check (#674 slice 3.2, D-415)

Every held library Scroll gets a second model's reading of its sentences, the **support check**: each sentence a reader sees (the title, the dek, each stop's lines and plain restatement, the points of a scale or a chart, calls' explanations and twists, asides, the recap) is read against the passages
its own stop, aside or the recap cites, and the model says `supported` (with a quote from one of those passages), `unsupported` or `no_claim`. Code checks each verdict (a quote that is not in a passage the sentence cites, or is about something else, makes the sentence `unclear`, not `supported`; "no fact" is accepted only for a label of a few words or a plain admission of a gap, never because a sentence shares no word with its passages) and decides the revision's verdict
under a policy: `library-support-policy.v2` **passes** a revision with no `unsupported` sentence, no `unclear` one and at most eight labels passed as stating no fact, and **flags** any other. The worker runs it for you: the delivery that holds a Scroll sends it, and a sweep every ten minutes sends it for any held revision that has none. It is background work on the
production harness (role `content.library-support-check`, the background share of the daily caps, at most eleven requests for a Scroll over every try, its own failure brake). **It releases, rejects and serves nothing: you still read every Scroll.** It exists to be measured. When its verdict agrees with your own past
decisions well enough, the owner may let it approve per topic (slice 3.3); until then it is a hint, and not even that while it is being measured.

**You do not see it.** While the check is measured against your own decisions, `review-list` and `review-show` leave its verdict out, so your decisions stay your own. The results are stored all the same. `--show-check` on either command shows them (`supportCheck` in the list; the verdict, "Read these first" and a "Not covered:" line in the text); use it
only after the measurement, and know that a decision you make with it visible is no longer an answer key. The checker version is a hash of the instructions, rules, policy and code that decide what it says (`library-support-check.` and eight hex digits), so any change to the check, the ask check's shared code included, is a new version and a new measurement.

**The measurement.** Run it on dev after you have released and rejected some Scrolls (the more, the better; it uses your decisions as the answer key, and only a person's: `decided_by` must be `cli:<you>`). It needs the production grant and the model the harness allows, as `ask-check` does.

```sh
# 1. What is already stored, with no spend. Reads your decisions and any results the worker made.
node dist/operator.js content support-check-replay --max-requests 0
# 2. Check the decided revisions that have no result yet, within a cap. A check is about six requests; a revision that might pass the cap is skipped, not started.
node dist/operator.js content support-check-replay --limit 40 --max-requests 150
# 3. Only decisions since a date (an ISO date or date and time); fail with exit 2 if the cap left any decision out.
node dist/operator.js content support-check-replay --since 2026-11-01 --limit 100 --max-requests 300 --fail-on-partial
```

`--max-requests` is required (0 to 1,000): a replay is paid for, and the production scope's own daily cap and the background share still apply on top. `--limit` is how many of the newest decided revisions to look at (1 to 500, 50 by default). Running it again sends nothing for a revision already checked,
so a spent budget only means "run it again later"; a conclusive provider failure is tried again in a later round and asks only the batch that failed. It writes only the check's own result rows, the ones the worker writes: it changes no decision and no Scroll. It prints one JSON line for each revision (counts and codes, no sentence), then one for the end, so the output may be pasted into an issue.

Read the last line, in this order:

- `result` is `done`, `partial` or `stopped`. **`partial` means the cap left decided revisions out** (`skippedForCap`, by released and rejected); the agreement covers the rest only, so run it again with a larger cap before reading it. `stopped` says why (`stopped`: a spent budget or quota, an attempt of unknown outcome, a revoked root, the wrong model).
- `conclusion` says plainly whether the measure can conclude anything: it needs the upper end of the rejected-passed rate in the newer half of the decisions to be at most 10%, which takes about 30 rejected revisions with none passed. **If it says "Not enough to conclude", nothing below is a basis for stepping review down**, whatever the point estimates look like.
- `checked` is how many decided revisions entered the matrix: those whose result was made at or after your decision. `exposed` counts the decisions you made after a result already existed (the worker's sweep makes one soon after a Scroll is held, so decisions made after that are reported here, even though the verdict was hidden from you). They are in no matrix and no family. `notChecked` counts the decided revisions with no result and why (`not_checked` means none yet; a code is the stored reason): a large number is a reason to run it again before reading anything.
- `rejectedPassed` is **the dangerous number**: revisions you rejected that the check would have passed; `rejectedPassedRate` has its n (the rejected revisions checked), the Wilson 95% interval (`wilsonUpper` is the number to trust) and the rule of three (`ruleOfThree`, 3 / n) when none passed. `releasedFlagged` is the cost of the other mistake: Scrolls you served that the check would have held back (`releasedFlaggedRate`).
  `flagRate` is the share of all checked revisions it flags. `rejectedCaught`, `releasedPassedShare` and `agreement` are the plain shares.
- `split` is the older half of the decisions choosing limits (`chosen`, only with at least three rejected revisions in it, the loosest that passed none of them) and the newer half reporting them: `evaluationUnderPolicy` and `evaluationUnderChosen` are what the active policy and the chosen limits did on decisions that did not choose them. Quote the newer half, not the whole.
- `byFamily` is the same matrix for each recipe family (the system of the recipe: `earth`, `space`, `machine-learning`...), because a checker that does well on one subject may not on another. A family with few revisions says little.
- `choices` is the table of what looser limits would have done (`maxUnsupported`, `maxUnclear`, `null` for no limit) on the same stored results: if the policy flags nearly everything you released, the table shows whether tolerating a few `unclear` sentences fixes that and what it costs in `rejectedPassed`. It is not a choice: `split.chosen` is.
- Each revision's line has `codes` (how many sentences are `unclear` because of which rule: many `quote_not_about_sentence`, `quote_not_in_cited_passages` or `no_claim_without_ground` is the checker's quoting or its use of "no fact", not the Scroll) and `kinds` (what the checker found unsupported), and `blind` (whether it counts). Look at them before you decide the checker is too strict. The stored sentences keep each quote and how many key words it shares with its sentence, so a stricter rule can be tried later without asking the model again.
- `notCovered` lists what the check does not read: questions put to the reader, a call's options and answer key, a sort's items and order, a fork's branch labels, a scale's axis and marker and a chart's shape and unit, the misconception, the landmark's name, the picture and the Ask suggestions. A rejection for one of those looks like "passed".

**What the numbers cannot tell.** They say how the check agrees with you, not whether a Scroll is true: you may release a Scroll with a small flaw and reject one for its picture or its calls, which the check never reads. Revisions you rejected for a reason that is not a sentence's support will look like "passed"; say so when you read the
number. A Scroll counts once per checker version, so a new version is a new measurement to make.

Nothing is released automatically in this slice, and a policy or a checker change is a new version, not an edit. A `NOT CHECKED (<code>)` result means no sentence has a verdict: `outcome_unknown` (the attempt is listed by `reasoning unknown`; write it off when you have decided what it was), `invalid_output`, `provider_failed_final` (after three tries or when another try could pass the eleven requests),
`revision_too_long`, `citations_missing`, `provenance_unreadable` or `refused_<reason>`. A spent budget, quota or failure brake is not a result: the sweep asks again on its own. A revision that went through no review gate (a made-to-order one) is refused (`not_under_review`) and never stored.

## The release policy of held library Scrolls (#674 slice 3.3, D-418)

The review gate stays: a person reads every held Scroll until the owner decides otherwise. The release policy is the mechanism for the step after the measurement above: a person approves a **topic** once, and a worker then releases a later Scroll of that topic by itself, when the Scroll is new, not sensitive, its answer check passed and its **library support check passed under this build's checker version**. It is built and **off in every world**: `KS_CONTENT_AUTO_RELEASE_ENABLED` defaults to `0`, and with it off the worker's release step (`content.sweep-release-policy`, every ten minutes) reads nothing and releases nothing. Approving a topic changes nothing by itself.

```sh
node dist/operator.js content policy status                          # counts only: switch and cap as this shell reads them, approvals, releases (today, in all, withdrawn), and for each held Scroll's hold code how many
node dist/operator.js content policy approve-topic --topic <topic id>  # approve a catalogue topic (earth.seasons); refuses a sensitive or unknown topic; records who and when
node dist/operator.js content policy revoke-topic --topic <topic id>   # take the approval back; Scrolls already released stay served
node dist/operator.js content policy withdraw --asset <asset id> --revision <n>   # withdraw a Scroll the policy released and revoke its topic, in one go
```

All four refuse worlds other than `local`, `ci`, `dev` and `stage`, use the shared database only and call no provider. `status` prints counts and codes only (no asset, topic or text), so it may be pasted into an issue. Read its `held.byReason` before switching anything on: it says for each held Scroll why the policy would not release it now.

| Hold code | Why it stays for a person |
|---|---|
| `replaces_served` | An earlier revision of the asset is served (a `content regenerate` take). The policy releases a new asset, and a document v3 over a served v1 or v2; a v2 over a served Scroll, and a v3 over a served v3, wait for a person. |
| `no_topic` | The revision has no single primary topic. |
| `sensitive` | The catalogue puts its topic in a sensitive category (all of Human body and History), its words match the data file (`domain/release-sensitive-data.ts`: medicine, health, law, finance, political or religious history, current events, safety, or a year from 2023 to 2100), the topic is not in the catalogue, or a raise was recorded against it. |
| `topic_not_approved` | No live approval of its topic. |
| `unreadable`, `unmapped` | The stored document does not read, or no coverage mapping is active at its head. |
| `answer_check_not_passed` | The answer check did not pass on the first draft (`repaired`, not run and not checked all wait for a person). |
| `no_support_check`, `stale_support_check`, `support_unchecked`, `support_flagged` | No library support check, only one of another checker version, one that gave nothing, or one that flagged the Scroll. |

**Turning it on is the owner's decision, after the measure above says the support check can be trusted.** The steps are then: approve the first topics with `approve-topic`; set `KS_CONTENT_AUTO_RELEASE_ENABLED=1` (and, if five a day is wrong, `KS_CONTENT_AUTO_RELEASE_DAILY_CAP`) in the world's worker environment file and restart the worker; watch `content policy status` and the `content.release_policy_released` and `content.release_policy_swept` log lines. **Turning it off:** set the switch to `0` and restart the worker. A Scroll the policy released that should not have been: `withdraw` it (the asset stops being served everywhere, nobody can lock a call, ask or get a quick answer from it any more, its topic's approval is revoked so nothing more of the topic is released unread, and who withdrew it and when is kept in `content.release_withdrawals`). `withdraw` leaves a Scroll you released yourself alone.

A policy release is recorded in `content.revision_reviews` with `decided_by = policy:approved-topic-supported.v2` (releases made before the v3 rule were recorded as `…v1`) (`review-list --all` shows it). **The support-check replay counts only your own decisions (`cli:`), never a policy release**, so the measurement stays yours. After the switch is on, the Scrolls you still decide are the ones the policy held, so the measure no longer grows: measure first.

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
