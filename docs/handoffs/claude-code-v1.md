# Claude Code handoff — full KnowScroll v1

Prepared 2026-09-19 under #88. This is a dated kickoff; current authority is `docs/CHECKPOINT.md`.
Paste the prompt below into an interactive Claude Code session opened in
`/Volumes/Mrigesh SSD/knowscroll-product`. It is intentionally broader than the next bounded issue.

## Launch on the SSD

Installed Claude Code was **2.1.278**. The official [workflow guide](https://code.claude.com/docs/en/workflows)
documents `claude --effort ultracode`; interactive `/effort ultracode` also enables it. Check your
installed capabilities if launching later. Use the configured strong coordinator model; do not
invent an unavailable model name. This invocation directs new Claude configuration/session files
to SSD and forces ordinary workflow/subagent workers to Sonnet:

```sh
cd '/Volumes/Mrigesh SSD/knowscroll-product'
source scripts/env.sh
mkdir -p "$KS_DEV_ROOT/claude"
CLAUDE_CONFIG_DIR="$KS_DEV_ROOT/claude" \
CLAUDE_CODE_SUBAGENT_MODEL=sonnet \
CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1 \
claude --effort ultracode
```

The SSD Claude config directory is new; authenticate through Claude's normal flow if required.
No existing user configuration or login was moved. Do not copy all home-directory settings/keys.
The official [subagent model guidance](https://code.claude.com/docs/en/sub-agents#choose-a-model)
documents these variables and exceptions (forks and inherited-model skill agents); inspect `/tasks`
for actual models and avoid those exceptions when cheaper workers are required. `/workflows`
shows workflow phases/usage. No permission-bypass flag is needed or prescribed.

## Prompt to paste

```text
ultracode: You are KnowScroll's lead engineer and architectural coordinator. Continue delivering
the whole product toward full v1, using bounded workflows and cheaper Sonnet subagents. Own
architecture, shared contracts, migrations, integration, runtime proof and the shared checkpoint.
Do the work through coherent reviewed delivery waves; don't stop after a plan, unit tests or
every routine merge to ask me to say continue. Keep me informed of actual progress and decisions.

AUTHORITATIVE START
Main checkout: /Volumes/Mrigesh SSD/knowscroll-product
Repository: https://github.com/KnowScroll/knowscroll
Issues: https://github.com/KnowScroll/knowscroll/issues
Project: https://github.com/orgs/KnowScroll/projects/1
Owner Alpha milestone: https://github.com/KnowScroll/knowscroll/milestone/2
Full-v1 tracker: https://github.com/KnowScroll/knowscroll/issues/72
Next bounded issue: https://github.com/KnowScroll/knowscroll/issues/89

First read CLAUDE.md / AGENTS.md and docs/CHECKPOINT.md. Then README, docs/PROJECT-STATE.md,
docs/operations/system-navigation.md, docs/operations/agent-workflow.md,
docs/operations/worktrees.md and docs/product/v1-release.md. Read the assigned issue and comments,
relevant accepted ADRs, component-map.json and scoped instructions before touching a component.
Read product definition and design direction for any UI. Do not load every historic proposal.

Verify live Git status, branch, remote, open PRs, issue/Project state, listener/process identities
and owner runtime before relying on this handoff. Last product code was cfe7ababdd9de0209582fd143c2ae71fc87b9602,
followed by the #88 documentation/handoff change in PR90: resolve its actual merged revision from GitHub.
Never reset another checkout or replace uncommitted work. Preserve both repositories' own rules.

FULL V1 — NEVER NARROW THIS
v1 requires the whole documented experience and journeys A-I; polished MOBILE AND DESKTOP UI;
real Cutroom generation, reconciliation, verified import, publication and playback; discovery,
reasoning, semantic and living worlds, social experience, recovery/privacy and owner acceptance.
Owner Alpha and other milestones sequence delivery; they do not remove later scope from v1.
Keep #72 open until those gates are actually met. No inferred learning, beliefs or identity as
facts. Reel and Scroll are the only consumption objects. Models propose; deterministic code
validates/applies. KnowScroll owns evidence, meaning and publication; Cutroom is separate.

WHERE WE ARE
Android supports sourced Scroll reading, source sheets, deliberate next discovery, explicit Keep,
saved Traces with original-source revisit, restoration and bounded Clear History. Full mobile UI
and desktop remain incomplete. Core is TypeScript/Fastify/PostgreSQL with a separate projection
worker. Literal Ask is recorded_only: no answer, paid grant or product queue. SQL reasoning
storage, fairness, context sealing, original-session authority, cancellation/expiry, unknown/late
accounting and private retirement primitives exist; ordinary reasoning dispatch is disabled.

Completed waves: #66 sealed Ask context (PR76), #74 reader navigation (PR77), #75 safe lifecycle
(PR79), #78 saved Trace revisit (PR80), #81 seven-day terminal retention and #82 bounded J004 test
deadline correction (PR83), #84 Cutroom audit (PR85), #86 strict HTTP client (PR87).
docs/operations/delivery-history.md explains the last ten main changes and their consequences.
Last slice passed 474 backend tests including 30 HTTP checks, synthetic separate caller/server
restart proof and backend/Android CI. Source and receipts are revision-bound. This proves no
live Cutroom/provider product path. Historical #57's original missing-cleanup-ack cause is still
unknown; retain first failures and do not rerun an unchanged failure until it happens to pass.

OWNER RUNTIME IS BEHIND SOURCE
At 2026-09-19 17:55:29 UTC, the owner PostgreSQL database had migrations0001-0009, while code
contains0001-0012. API health was false and projection heartbeat was stale. No production or
owner deployment of the later code is certified. Recheck now. Never silently run dev-init,
migrations, seeding, Clear or destructive journey tests on owner data to make evidence green.
Applied migration files are immutable. A future owner upgrade needs a concrete preserve-data
rollout with before/after schema/checksum/row evidence; separate it from disposable verification.

LOCAL CUTROOM — OWNER DECISION IS MADE
Run Cutroom on this Mac and keep ALL substantial storage on /Volumes/Mrigesh SSD. Source clone:
/Volumes/Mrigesh SSD/cutroom; observed main52a62dd8ea8cd3f258f9be2b167cbeac4a0bda2a.
Read docs/operations/cutroom-local-handoff.md and inspect current upstream before coding.
KnowScroll's client pin238df854 is now behind a required RunRecord.takes addition within wire
version1. The strict old record parser rejects the new response. #89 owns a reviewed repin and
actual local service boundary. Do not relax strict validation to conceal incompatibility.

Cutroom source has plan/stills/render stages, SQLite, exported startApi/startWorker, stand-in
model/image/video/voice/sensor ports and real local ffmpeg. There is NO ready serve/start command
and no wired real H3/FAL/M3 provider adapter at that observation. API binds127.0.0.1; default port0
means the OS chooses it and startApi returns baseUrl. Build/coordinate a minimal correct launcher
with explicit paths, adapters, lifecycle and graceful restart. KnowScroll's pnpm dev:api is not
the Cutroom launcher. Current reel-takes Slice2 is a prompt, not implemented acceptance. Cutroom's
README has stale bootstrap text; inspect code and its own decisions/journal/feature gates plus
steering-ref. Do not overwrite upstream authority or confuse its steering repo with this product.

KEYS AND ENDPOINTS
I supplied MiniMax M3/H3/FAL access in /Volumes/Mrigesh SSD/knowscroll-product/.env and have an H3
endpoint. The handoff scan saw configured MINIMAX_API_KEY and FAL_AI_KEY, blank CUTROOM_BASE_URL,
and no distinct H3 endpoint variable. Inspect only names/presence, validate mappings locally,
preserve existing values, never print keys, and ask privately for genuinely missing endpoint data.
Set CUTROOM_BASE_URL to the actual observed local Cutroom HTTP listener after startup; it is not
the H3 provider endpoint. Map keys only to the adapter contract that actually consumes them.
Do not put credentials in mobile, Git, issue text, artifacts, broad worker prompts or test lanes.
Key presence is not proof the adapter exists or works. No new paid-call cap was supplied in this
handoff; prepare a concrete bounded experiment and get that missing cap before paid execution.
Historical certification is not unlimited authority. Continue provider-free independent work.

THE NEXT WAVE
Use #89 under #9/#8, not a duplicate epic. Coordinator publishes the exact pin/IO/local-bootstrap
contract first. Assign independent workers for bounded client changes, service/bootstrap proof
and independent review, with dependencies respected. Verify the KnowScroll client against real
Cutroom API/SQLite with clearly labelled stand-ins first. Do not claim this is real generation.
Then address missing provider adapters, durable scoped generation intent/admission, all-attempt
accounting, verified host-file import and source/rights/truth/continuity publication gates. Keep
the full path visible: user intent → authorized bounded job → real Cutroom → reconciliation →
import → publication → playable Reel → Scroll/branch/world continuation. UI work can proceed in
parallel only against released contracts. Do not spend the entire project on infrastructure.

WORKERS AND SHARED MEMORY
At most three workers at once. Use Sonnet workers and an independent Sonnet reviewer; report
actual models from /tasks and workflow results, not intended settings. Coordinator remains on
the selected strong model. Never launch recursive/unbounded fan-out or unlimited retry loops.
Use native Claude workflows/subagents for this handoff, not a second hidden pio orchestration
layer. Every worker gets issue, exact dependency commit, isolated SSD checkout/branch, distinct
DB/port, owned and forbidden paths, acceptance checks and limits. The coordinator owns shared
schema/contracts and the main checkpoint. Workers return commit/diff, tests, receipt paths,
failures and limits; coordinator verifies, integrates, runs joined proof and merges after CI.

Keep docs/CHECKPOINT.md compact and current after every wave, decision, failure or handoff.
It is imported by root CLAUDE.md and reloaded after compaction. Before deliberate /compact,
persist current issue, exact revision, modified files, active workers/processes, pending commands,
first failure, evidence, unresolved decisions and next command. After resume, reread and verify.
Do not treat auto-compaction summaries or machine auto-memory as project authority. Preserve
history in issue/PR receipts and delivery-history.md, not an ever-growing root context file.
Use the owner outcome, chosen architecture, expected runtime path, observed divergence and next
decision as our shared steering record. Resolve contradictions explicitly.

PROGRESS AND PRODUCT PROOF
Keep existing issues, Project and milestones current. Owner Alpha had5 closed/6 open at handoff;
that is bookkeeping, not a v1 percentage. Report actual gates advanced and remaining gaps. No
full A-I journey has complete joined release-UI and owner acceptance recorded. For each journey,
show intended versus observed UI/API/job/provider/storage/UI path with exact builds, DB and
causal identity; distinguish source, unit checks, fixture integration, real local service, live
provider/media, release UI and owner acceptance. Inspect visible quality and failure/recovery.
Green types/tests or a valid media file alone cannot prove the desired product experience.

SSD FOLDERS AND CLEANUP
/Volumes/Mrigesh SSD/knowscroll-product = canonical current product Git checkout, owner .env and
existing local artifacts. /Volumes/Mrigesh SSD/knowscroll-worktrees = isolated temporary issue
lanes; start fresh, never assume a directory's old branch is current. /Volumes/Mrigesh SSD/knowscroll-dev
= shared SDK/AVD/Gradle/package caches, dedicated PostgreSQL55432, temp/evidence, pio history and
private archives. It is not a source repository and must not be cleared wholesale.
/Volumes/Mrigesh SSD/knowscroll-bootstrap was one-time setup scratch, now archived and removed.
Nineteen clean inactive old worktrees were removed after verifying Git-bundle and local-file
archives under knowscroll-dev/archive/2026-09-19-handoff. Git branches and referenced evidence
remain recoverable. revisit stays because ADB references it; don't delete it while active.
The handoff documentation lane is also present. Read worktrees.md for exact status/recovery.
Source scripts/env.sh before tools/builds/tests; do not install caches, models, media or new
worktrees on the internal drive. Keep Cutroom's own SQLite separate. Preserve databases, failure
logs, private archives and active processes. Do not delete a folder merely because it is old.

You may create focused issues/PRs, implement, push, merge reviewed changes after acceptance/CI,
close completed scoped issues and update Project/docs. Keep broad epics open until their real
acceptance. Stop for substantive owner decisions, a true external blocker or a necessary handoff,
not after routine progress. Start by verifying current truth and presenting the first bounded
wave plus its actual evidence gates, then execute it.
```
