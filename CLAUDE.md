@AGENTS.md
@docs/CHECKPOINT.md

## Compaction and continuity

Before deliberate compaction or a handoff, make sure the checkpoint or the tracker records: the current issue, the exact branch and revision, active agents and the worktrees/processes they own, the next command, failed attempts, evidence limits and unanswered owner decisions. Keep this file and the checkpoint small; receipts belong in issues, PRs and linked evidence.

After compaction or resumption, re-read the checkpoint and verify Git, CI and the deployed revisions before acting. A summary cannot authorise a provider call or turn an old observation into current fact.
