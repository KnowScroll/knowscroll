# Durable coordination across harnesses

Status: current workflow, #88. Start at [CHECKPOINT](../CHECKPOINT.md), then
[system navigation](system-navigation.md). Product issues and the existing GitHub Project remain
the delivery board; the checkpoint is a compact pointer into that truth, not a second backlog.

## One coordinator, bounded independent workers

The owner requests Claude Code ultracode with cheaper subagents for the next delivery. Use at
most three Sonnet workers concurrently, with separate implementation and independent review roles.
Coordinator owns ADRs, shared contracts, migrations, root configuration and integration. Workers
get an issue, exact dependency commit, SSD checkout/branch, database/port, owned/excluded paths,
acceptance checks and a receipt contract. Read-only review needs no duplicate runtime.

Each worker returns: actual model, commit/diff, commands/results, revision-bound evidence, first
failure and change made, limitations, active process/database ownership and next action. A worker
summary is untrusted until source and receipts are checked. Collect every result and clean up only
owned resources. Cap repair rounds; don't retry unchanged failures until green. Replan after two
unsuccessful attempts instead of escalating to an unbounded swarm. Subtasks must not spawn another
orchestration layer. Current user's Claude-native worker choice supersedes older pio preferences
for this handoff; historical pio records remain evidence only.

## Keep the owner and main session oriented

At wave start publish desired outcome, dependency ordering and what would prove success. During
work report material findings, failures, decisions and changes to scope; update the owner during
long work rather than going silent. At completion report shipped behavior, evidence level, gates
advanced, unresolved gaps and next action. Report actual worker models and measured usage when
available, never guessed token or cost savings. Project counts are bookkeeping, not product percent.

Update `docs/CHECKPOINT.md` after every material decision/failure, accepted wave and handoff. Keep
it under roughly120 lines with links, not raw logs. Coordinator alone owns this file; workers
write their assigned receipts. Persist current issue, revision, branch, modified paths, active
worker/process IDs, pending command/session, failed attempts, evidence limits, owner decisions and
next command. Move detailed durable change rationale into delivery-history.md and issue/PR records.

Before deliberate compaction, checkpoint first. Use `/compact` preserving the above fields when
context is crowded; leave automatic compaction enabled. After compaction/resume, read the root
CLAUDE imports, reconcile live Git/workers/runtime and resume the exact next action. If the checkpoint
is stale, update it from verified evidence before dependent work. A crashed session can leave stale
Markdown; the file's existence is not a freshness certificate.

Claude root `CLAUDE.md` imports AGENTS and CHECKPOINT. Scoped files still require explicit reading
for changed components. Official guidance: [memory/imports and compaction](https://code.claude.com/docs/en/memory),
[context management](https://code.claude.com/docs/en/best-practices),
[workflows](https://code.claude.com/docs/en/workflows),
[subagent model selection](https://code.claude.com/docs/en/sub-agents#choose-a-model).
The receiving session verifies its installed version and actual `/tasks` models. This repository
uses native compaction and durable Markdown; it does not install a hook that claims to synthesize
fresh project state automatically or bypass workflow permission checks.

## Integration and acceptance

Review the real diff against issue/product intent, component ownership and accepted contracts.
Then verify the intended UI/runtime path, not merely existence of modules. Separate implementation
checks, fixtures, actual services, live providers/media, release UI and owner acceptance. Record
what ran, the first divergence and what remains unproved. Preserve owner history, applied migration
checksums and old failure receipts. Schema/source integration does not deploy owner runtime.

Commit and push reviewed work, inspect final-head CI, merge only after acceptance, close the scoped
issue and update the Project. Keep parent epics open when their full criteria remain unmet. Update
only authorities whose truth changed. Every substantial wave reconnects owner outcome → issue →
ADR/architecture → code → observed runtime/visible result → next-session checkpoint.
