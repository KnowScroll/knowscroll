# @knowscroll/worker

## Startup and schedules

The worker starts pg-boss as a `consumer`, builds the Nest context and registers every consumer of
its explicit registry (`src/jobs.ts`). It creates and removes no schedule. Recurring schedules belong
to `dist/migrate.js` (`applyQueueDeclarations`), which registers each declared queue's schedule and
deletes the schedule of any queue that is no longer declared (logged as `jobs.schedule_removed`),
once per deploy while the old release is quiesced. A transient database error therefore fails the
migrate, which the deploy reports before the new release starts, and never a running worker.
Status: implemented and covered by `tests/integration/infrastructure/jobs.test.ts` against real
PostgreSQL.

## Clear exploration maintenance

Related: #345.

The explicit consumer registry includes `identity.clear-exploration`. Its IDs-only payload
locates an existing account-lifetime operation; durable core_done determines whether the
worker may obtain core-removal authority or only exact-set accounting authority. Selective
removal uses the complete verified owner registry and preserves every Saved/place/Social
row. Accounting retries cannot run a broad eraser or dispatch paid work. On a final handler
failure the consumer tries to record a coarse completion_unverified failure. The separate
`identity.recover-clear-operations` scheduled consumer reconciles durable due operations if that
write also fails, or if a final delivery expires or is lost before the handler can run its catch.
Identity bounds each recovery wave, rechecks exact operation authority and live delivery state,
and commits the recovery marker with its fixed-queue wake. Completed operations can recover
only their due exact-set accounting cleanup; they never reacquire core-removal authority.

The Clear core callback is the closed `eraseCurrentExploration` runner from the actual backend
erasure root. It runs the schema inventory, runs the real registry's owner removals and marks that
exact Clear transaction only after every owner reports `completed`. The worker accepts no
caller-provided registry or lookalike callback as lifecycle proof. Exact-set accounting and
recovery retain their separate existing authority; they cannot reacquire core removal.

This composition requires the durable core from PR #348 and the reviewed current lifecycle/schema
prerequisites; older installed schemas or an incomplete lifecycle cannot be certified by wiring.
Actions installed-release fixtures exercise the normal API and worker with disposable data
and no provider. Actual dev/stage privacy journeys require separate deployment evidence.

## Account deletion and export (D-043)

Related: #246.

The registry also holds `identity.delete-account` (erases one accepted account deletion in one transaction
through `eraseCurrentAccount`), `identity.recover-account-deletions` (every five minutes: hands pending, due
deletions back to the queue) and `identity.build-export` (builds one export file through
`exportCurrentPerson`). On a final failed delivery the consumer marks the receipt `needs_retry` (deletion) or
the export `failed`, best effort: the recovery cron and a retry are the other ways out. Their payloads are IDs
only (the operation or export id, never a person), and the logged outcomes carry no account, universe or
receipt id. The sweep `identity.sweep-sign-in-records` also retires exports.

## Quiet sweep (v3 U-3, #467, D-104, D-105)

The registry holds `geography.sweep-quiet` (every 15 minutes: the oldest 100 universes whose `next_quiet_at` has passed are looked at; each that can be
settled gets one `geography.settle-quiet` job in the same transaction, any other is parked a day ahead) and `geography.settle-quiet` (one universe: a short transaction under the
personal root that applies only the activity changes current support implies). Both are rules only: no model call, no ledger run, no network
wait. Both follow `KS_CARTOGRAPHER_ENABLED`. The settle runs as a system actor and rechecks the account, epoch and recording generation
itself; it stands aside while recording is paused or a Cartographer run holds the universe. Logs `geography.quiet_swept` (count handed
over) and `geography.quiet_settled` (outcome code and places changed). Status: implemented, covered by
`tests/integration/modules/quiet-sweep.test.ts`; not yet runtime-verified on dev.

## Visit list refresh (#241, D-047)

The `scenes.project` consumer calls Social's `REFRESH_VISIT_PUBLICATION` after it has projected a universe, so
planets formed after a person chose their systems reach the friends who may visit. It runs as a system actor
in its own transaction (`social.refresh-visit`), rechecks the universe and epoch itself, does nothing for a
universe that shares nothing, and writes nothing when the list is unchanged. A failure retries the job; the
projection that already committed is not repeated. No queue of its own, no model call and no network wait.

Background worker: a Nest application context with no network listener. pg-boss claims jobs for
the queues in the explicit consumer registry (`src/jobs.ts`); nothing is discovered by
decorators. HTTP guards never run here, so every consumer's use case rechecks authority itself
under `withPersonalScope`.

| File | Role |
|---|---|
| `src/main.ts` | Validate config → database → Nest context → pg-boss (`consumer` role) → register consumers; on SIGTERM drain (bounded) → close context → close pool, exit 0 |
| `src/worker.module.ts` | Composition root: database, `withPersonalScope`, consumer wiring |
| `src/jobs.ts` | Explicit consumer registry: `evidence.apply-action` → `applyActionEvidence`; `evidence.project-scroll-reading` → `projectScrollReading` (qualifies a reading, commits an evidence revision, hints the account); `identity.sweep-sign-in-records` |

Variables: `docs/v2/engineering/runtime-configuration.md`.

`node dist/operator.js content import-cutroom-reel --run <approved uuid> --script <greenhouse|seasons-v5|tides-v4>`
imports approved existing output at no spend. Required worker-only settings: `KS_WORLD`, `DATABASE_URL`,
`KS_MEDIA_ROOT`, `KS_CUTROOM_ORIGIN` (HTTP loopback only), `KS_CUTROOM_ARTIFACT_ROOT`; optional
`KS_FFPROBE_PATH` defaults `/usr/bin/ffprobe`. Only dev/stage/ci/local operator worlds are accepted.
The worker unit alone receives `SupplementaryGroups=ks-pool`; the API receives no Cutroom origin or
artifact access group. This importer sends nothing to Cutroom. `--fixture` additionally requires ci/local and
a disposable `ks_it_*`/`knowscroll_fixture_*` DB, and marks content visibly. Operator output is one
sanitised result line; external errors never log URLs/paths/response text. Failed copy/probe/admission
can leave an unreferenced object; never delete referenced bytes during rollback.

`node dist/operator.js journey <id>` and `journey --account <accountId>` (`src/journey-operator.ts`, #248) print one
record's timeline across modules, read from the `ops` views: IDs, states, codes and times only. `--json` prints one
JSON line. Exit 0 found, 2 not found or bad usage, 1 failure. Read-only; it needs only `KS_WORLD` and `DATABASE_URL`.
Runbook: `docs/v2/operations/looking-at-the-system.md`.

`node dist/operator.js reel <check|order|follow|receive|status|write-off|settle> …` orders Reels from
Cutroom and brings them in (`src/reel-operator.ts`; the use cases and the guarantees are in
`packages/backend/src/modules/content/README.md`, "Reels from Cutroom"; the runbook is
`docs/v2/operations/cutroom-and-spend.md`). Settings: the import settings above plus the shared pool,
which is `KS_POOL_DATABASE_URL` or, by default, the world's own `DATABASE_URL` pointed at
`knowscroll_pool`. Only `reel order --until video` can spend, only through a claim in the pool, and
only up to the ceiling, which must be Cutroom's own 75 cents. The worker service registers no Reel job:
every step is an operator command. Output is one JSON line per result; exit 0 done or under way, 2
refused or not ready yet, 1 failure.

The composition root binds `PRODUCTION_REASONING_HARNESS` and `WITH_PRODUCTION_SCOPE` separately
from the personal harness. Nonpersonal Scroll supply requires explicit worker configuration and
the database root enabled/generation gate; both default disabled. Shared sweep/purge/operator
maintenance still records and resolves production liabilities while production is disabled.

The `content.produce-scroll` consumer (`src/production-jobs.ts`, #239) runs the production use case for
one recipe and take per delivery, with resume, so a redelivery continues the same business run. It is
registered only when `KS_REASONING_PRODUCTION_ENABLED=1`; otherwise jobs wait in the queue. The
`supply.resolve-request` consumer advances a person's request (a free-text match, the scope step of a question asked from a Scroll, the wait for
production or for an ask order, binding) with the personal reasoning harness. `KS_SUPPLY_ASK_DAILY_CAP` and `KS_SUPPLY_ASK_PERSON_DAILY_CAP` (default 0 outside `local`, and 5) cap the ask orders it may commission (D-218). `KS_SUPPLY_CREATE_DAILY_CAP` caps the
productions Create may start per UTC day for people's asks (default 20 in `local`, 0 elsewhere);
`KS_SUPPLY_PLANNER_CREATE_DAILY_CAP` (default 5) caps the Planner's demand apart from it.

Three consumers belong to What if and Another perspective (#244, D-049, D-211). `scenarios.write-answer` writes the short answer card of
one what-if (IDs only in the payload; the run is the branch ID; the asker's own scope pays; no model is asked with fewer than two
claims to cite) and stores it only after the card's own checks. `scenarios.suggest-draft` asks the Scenario Planner
for the directions of one draft with the personal reasoning harness (IDs only in the payload; the run is the draft ID, so
a redelivery never pays twice) and commissions nothing. `scenarios.resolve-branches` runs every minute: it binds a
preparing branch to its admitted Scroll, sends the next take of a rejected one (up to three), closes a branch that cannot
be produced or is 30 minutes old, ends the wait for a short answer that took twelve minutes, and hints the thread's members; it
logs `scenarios.branches_resolved`. The worker
builds the thread guest, the made-to-order readers and the production sender for them (`threadGuestProviders`,
`madeToOrderProviders`, `scrollProductionSenderProviders`).

`node dist/operator.js supply recover-open-demand [--dry-run]` (`src/supply-operator.ts`) sends one
resolver job for every ask that is still open from before Create existed and prints the counts. It is
idempotent and calls no provider.

`node dist/operator.js scenes backfill-looks [--dry-run] [--limit <1-1000>]` (`src/scenes-operator.ts`, D-102) gives worlds
that were projected before looks existed their look. It sends one `scenes.backfill-looks` job for each universe that has
a projected system, planet or region without one (at most `--limit`, default 100, and it says when more are left), and the
`scenes.backfill-looks` consumer inserts the missing rows under that universe's lock. No slot, seed, family or anchor
moves, no provider is called, and running it again assigns nothing. It needs only `KS_WORLD` and `DATABASE_URL`.

`node dist/operator.js composer replay-policy --since <ISO date> [--limit <1-20000>] [--intent-weight <0-1>]
[--recent-topic-penalty <0-1>] [--sweep]` (`src/composer-operator.ts`, D-190) re-runs the retained vertical Composer decisions
recorded since a date under `composer-policy.v0` and v1 and prints counts and shares only: first offers that stay on the
source's topic, are another part of its series or move to another Jev subject, and how often sticky format fell back. It
names no person, session, asset, title or text, calls no model and writes nothing. It needs only `KS_WORLD` and
`DATABASE_URL`; exit 2 on bad usage. See the Composer README, "Policy replay".

`node dist/operator.js rooms seed [--dry-run]` (`src/rooms-operator.ts`, D-051) creates one idea room for each
library system and leaves rooms that exist as they are; `rooms moderator --room <slug> --account <uuid> [--remove]`
names an account with a claimed profile a moderator of a room, or takes the role back from a current member. Both write room rows only: no member, no message,
no provider call. The `rooms.contribute` consumer answers a member's ask of an AI inhabitant with the personal
harness (it ends the ask as failed while `KS_REASONING_PROVIDER=none`). The `rooms.cast-due` and `rooms.cast-pass` consumers
(v3 R-2, D-162) are registered only while `KS_REASONING_ROOM_ENABLED=1`: the first decides, with no model call, whether a resident
answers a message; the second makes the model call of an allowed turn under the nonpersonal `rooms` reasoning scope. So does
`rooms.summarise` (v3 R-3, D-169): one call per room and 12-hour window that writes "while you were away", under the same scope as an
`ambient` role, with kept-out members and removed messages left out of what it reads.

The ritual commands (`src/rooms-ritual-operator.ts`, v3 R-5, D-176) are `rooms rituals --room <slug> [--day YYYY-MM-DD] [--dry-run]`, `ritual-list [--state ...]` and
`ritual-review --ritual <uuid> --approve|--reject`: they draft, list and approve a room's daily question (a template, no call) and Spot the flaw (one call of the
`rooms.ambient-ritual` role under the `rooms` scope, so they need `KS_REASONING_ROOM_ENABLED=1` and a provider). The `rooms.nightly-rituals` consumer (cron `10 3 * * *`,
registered with the other room jobs only while `KS_REASONING_ROOM_ENABLED=1`) drafts today's day for every open room with a member; nothing it drafts is
shown to a member before an operator approves it (the rooms README, "Today's ritual items"). The same commands draft and approve a room's **Launch deck** (v3 R-6, D-179): five calls of the room topic's library Scrolls chosen by code, with no model call, listed with their right answers for the operator and re-read from their Scrolls when approved.

The `rooms.feed-heartbeat` consumer (cron `7 0,8,16 * * *`, v3 R-8, D-248) gives each open room that has someone listening one look by its residents: it writes the room's memory again when due and posts a find about a library asset the room has not seen (two roles, `rooms.ambient-memory` and `rooms.ambient-find-explainer` or `-skeptic`, under the nonpersonal `rooms` scope; no call when there is nothing to do). It is registered only where `KS_REASONING_ROOM_ENABLED=1` **and** `KS_ROOMS_FEED_ENABLED=1`, so a world that has residents on does not start posting until its own switch is on. `rooms feed --room <slug> [--dry-run]` (`src/rooms-feed-operator.ts`) makes one look at one room exactly as the heartbeat does, or prints the assets code would choose from; one JSON line. The room face commands (`src/rooms-face-operator.ts`, v3 R-4, D-166, D-170, D-171) are `rooms kit`, `kit-list`, `kit-review`, `backdrop`,
`backdrop-list`, `backdrop-review`, `spend`, `backdrop-reconcile` and `backdrop-write-off` (the rooms README lists their options). `kit` calls the
`rooms.station-kit` role under the `rooms` scope (it needs `KS_REASONING_ROOM_ENABLED=1` and a provider); `backdrop` asks MiniMax's `image-01` for one
still and stores it under `KS_MEDIA_ROOT` (it needs the same key and a media root), and is the only command here that spends money: it is refused
when the recorded total plus its estimate would pass $1 in all. `--dry-run` calls nothing. Every result is one JSON line; exit 0 done, 2 refused.

`node dist/operator.js content produce-library [--only <keys>] [--interactive-first] [--dry-run]` sends
the production jobs of recipes that need one (a rejected recipe gets its next take, at most three) and
`content production-status [--only <keys>]` lists every recipe's standing, and for a v2 recipe its regeneration state, the takes it has
left and what the answer check said. `content regenerate --only <keys> [--dry-run]` (`src/library-operator.ts`, D-197) sends the next take of a
v2 recipe whose Scroll is served; the new take is stored held. These touch only the shared database and pg-boss; no provider is called. `content ask-check (--asset <id,…> | --recent <n>) --out <file>` (`src/ask-check-operator.ts`, D-250 to D-252) runs the support checker again over stored ask answers through the production harness: counts on stdout, the sentences and verdicts in the file; it stores nothing (runbook: scroll-production.md). `content admit-continuity [--dry-run]` admits the library
plan's series (Part tabs) and related moves (Related tab) between the published Scrolls: idempotent,
shared database only (D-059).

`node dist/operator.js content review-list [--all]`, `review-show --asset <id> [--revision <n>] [--sources]`, `release --asset <id> --revision <n>`
and `reject --asset <id> --revision <n> --reason <text>` (`src/review-operator.ts`, D-138) are the review gate for v2 library Scrolls:
what is held, the text to read (with what the answer check said, D-198), and the two decisions, each recorded with who and when. They use the shared database only, refuse worlds
outside dev/stage/ci/local, and call no provider. `review-show` prints the Scroll to the terminal and never to the log.

The content production operator is `node dist/operator.js content produce-scroll --topic <recipe>
[--take <1-3>] [--dry-run] [--resume]`, a debugging tool over the same use case. It refuses worlds outside dev/stage/ci/local, defaults to
`MiniMax-M3.1-Flash`, prints the request maximum (two for a v1 recipe: one writer call and at most one repair; six for a v2 library recipe, D-198), uses the
explicit nonpersonal harness grant, and emits bounded IDs, outcome codes and reported usage only.
`--resume` reuses the frozen job and attempt IDs; unknown attempts never resend. When a Scroll is
refused, `node dist/operator.js reasoning rejected [--attempt <uuid>]` shows the kept, redacted answer
and the validator's findings. No production job or source text is placed on the HTTP path.

`node dist/operator.js content writer-spike-v2 --topics <recipe keys> [--blocks <recipe=sort|fork|scale|chart>[+ray],…] [--out <file>] [--concurrency <1-4>]`
(`src/writer-spike-operator.ts`, S-0 and S-1a, D-120 to D-126) runs the v15 writer for `scroll-authoring.v2` on library recipes through the
same nonpersonal harness grant (one request and at most one repair per topic, `MiniMax-M3.1-Flash` only) and prints one JSON
line per topic with its outcome, findings, measured minutes, counts and tokens. It admits and publishes nothing and creates no
table, so it needs no migration. How to read the output: the runbook, "The v2 writer spike (S-0)".

The explicit `planner.run` consumer (#236) calls the personal Planner with the delivery abort
signal. `KS_PLANNER_ENABLED` defaults to 1 in world `local` and 0 elsewhere (dev sets 1); with 0,
deliveries persist `blocked_disabled` with no reservation. The role spends the shared MiniMax plan
within the harness caps. Backend
`RequestPlanner(authority,{commandId,resumeRunId})` requeues the same blocked business ID after
review; unknown attempts remain ledger-bound and never resend. There is no direct paid Planner
operator command or consumer UI in this slice. Protected `planner.*` rows expose revisions/status
for operator inspection; ordinary logs contain no Planner context or proposal text.

The `composer.prepare-buffer` consumer (#234) prepares the next vertical Explore move for an offer the
person just activated and stores it for the next navigation (`modules/composer/README.md`). It reads the
session, candidates, Hide and the person's stored Jev assessments in one short transaction, may ask Jev
(`KS_JEV_ENABLED=1`) outside any transaction, only about shortlisted candidates that have no stored
assessment from the last 30 minutes (D-058), then adds what it paid for to the stored assessments, persists
the ranking and replaces the person's buffer in a second one. It ranks under the policy the world sets
(`KS_COMPOSER_POLICY`, `v0` unless set, D-190). A job for a
superseded intent, an unactivated offer or an old epoch is skipped. A redelivery does nothing. It logs
`composer.buffer_prepared` with the outcome code and counts only.

U05 (#363) normally registers the fixed `scenes.expire-formation` consumer and five-minute UTC
`scenes.recover-formation` scheduled consumer. They finalize only the exact current due claim as
skipped, never create formation, grant animation, consume content or invoke a model/provider.
Expiry has 120s/three 10s-backoff retries; recovery 180s/three 15s-backoff retries; both concurrency 1,
7d queued/2d settled plus declared dead letters. Recovery re-enters owner/epoch/root/Clear fences
with 250ms locks/2s statements and at most 30s between-op work per delivery. Generated bigint ordinal
pages read 101/process 100 against a captured ceiling; one required fixed advancing child commits
before any owner root acquisition. Live duplicate child cursors dedupe, final pages do not wake
again, and overlapping scheduled passes may revisit due rows. Exhausted final delivery/root lock
or crash leaves durable due state for the next finite pass. The ordinal-only global cursor has
no personal UUID or per-account effect authority; full/Clear erases the personal row and all exact
private expiry job states. Old late work cannot restore removed IDs or touch fresh-epoch data.

## Personal recording composition

Related: #381.

The worker binds Identity's actual own-account adapter and `FENCE_PERSONAL_RECORDING`. The
own-account adapter supplies the branded current lifecycle reader through the same actual gate;
root-only or pair-only authority cannot stand in for it. Each personal recording use case owns
its existing fresh root → one account UPDATE → original-generation protocol. The composition root neither acquires
a second gate nor creates a recording capability.

Planner and Geography inject the required `RECORDING_REASONING_HARNESS` built by
`personalRecordingReasoningProviders`, with BOTH actual module-owned run checkers. Its role
header/purpose/account/original-generation/claim/full-context/model-context proof is required
before private execution and apply. The generic compatibility harness and nonpersonal production
harness remain separate; neither substitutes for a missing recording-role owner. Missing tokens
or required owner effects fail construction rather than return a successful empty result.

Evidence receives the actual Experience lineage/channel readers, lifecycle reader and PC's
four-method activity effect. The required material callback passes the SAME genuine original-
generation capability and source revision to actual Planner and Geography in the caller's
transaction. Source intake, qualification and derived work retain their own finite bounds and
original delivery identities. The explicit consumer registry, same-business attempt ledger,
strict normal/retirement UUIDs and claim-fenced recovery remain owning; no additional queue,
provider allowance, poller or automatic paid retry is introduced.

These bindings preserve all feature/provider/production flags and paid permits, including their
default-disabled behavior. The existing installed release boot fixture constructs the real Nest
worker registry and checks start plus bounded SIGTERM drain; it is meaningful DI/process evidence
only when run by hosted Actions on the final composed candidate. Full positive recording,
paused/stale/cross-generation, retained-accounting and populated Clear behavior still require the
actual complete API/client/worker graph and separate hosted/real-service acceptance. Local
static checks and source review alone establish neither activation nor deployment.
