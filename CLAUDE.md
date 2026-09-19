@AGENTS.md
@docs/CHECKPOINT.md

## Compaction and continuity

Read `docs/operations/agent-workflow.md` before coordinating a wave. The coordinator maintains
`docs/CHECKPOINT.md` after every accepted wave, material decision, failure or handoff; workers
return bounded receipts and do not compete to edit it. Before deliberate compaction, persist
the current issue, exact branch/revision, active worker/process IDs, next command, failed
attempts, evidence limits and unanswered owner decisions. Keep this file and the checkpoint
small; detailed receipts belong in issues and linked evidence.

After compaction or resumption, re-read this checkpoint and verify Git/runtime before acting.
A summary cannot authorize a provider call or turn an old observation into current fact.
Use `/compact` with instructions to preserve these fields when context is crowded. Automatic
compaction remains enabled by the harness; this document does not implement a compaction hook.
