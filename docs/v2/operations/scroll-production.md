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
| `copied_passage` | Nine words in a row match a source passage. |
| `authoring_number_not_in_evidence` | A figure (or a plotted chart value) is in no passage the block cites. |
| `too_big` / `too_small` at a field | A length limit; the finding names the field and the limit. |
| `OUTPUT_NOT_ONE_JSON_OBJECT` | The reply is not one JSON object; the detail says where it stopped being JSON. |
| `OUTPUT_TRUNCATED` | The reply hit the token ceiling, usually because the model thought too long. |
| `reading_length_out_of_brief` | Under two or over eight minutes of reading. |
| `MODEL_MISMATCH` (attempt code) | The route answered with another model than the configured one. |

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
