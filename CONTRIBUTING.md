# Working together

## Start a session

Read CHECKPOINT → README → PROJECT-STATE → assigned issue → relevant ADR/contract and scoped AGENTS. Check `git status`, fetch remote, and inspect `pnpm state` when changing runtime. Do not reconstruct the project from historical proposals.

Claim an issue in GitHub and name your lane. Use a separate worktree under `/Volumes/Mrigesh SSD/knowscroll-worktrees/`. Do not let two sessions own the same schema or contract edit. Shared contracts land first, then dependent consumers rebase. A worktree isolates files, not ports, databases or provider budgets: give running lanes distinct ports/databases; integration uses the coordinator environment.

## Main brain

The coordinator selects the next useful outcome, clarifies acceptance and dependencies, assigns bounded lanes, reviews the actual diff and evidence, integrates contracts/ADRs, verifies the joined journey, and updates project state. Claude Code, Codex and GitHub are enough. No KnowScroll-specific orchestration service is required.

## Review and integration

Use `codex/<issue>-<name>` or the chosen harness prefix; PRs target main. Keep main runnable. No force pushes or resets of another session's work. Keep Cutroom changes in Cutroom with an explicit versioned contract proposal. Agent advice is untrusted until reviewed.

A PR explains the user-visible change, relevant issue/ADR, changed boundaries, implementation checks, observed journey and exact limitations. Put routine session handoffs in the issue or PR, not permanent chat transcripts. If work pauses before a PR exists, leave the same short handoff in its issue.

## Truth update rule

A substantial change reconnects six things: owner outcome → issue requirements → ADR/architecture → code → runtime receipt → next-session entry point. Update only artifacts whose truth changed. A fresh snapshot belongs in evidence; a new permanent capability belongs in PROJECT-STATE. Architecture changes supersede ADRs instead of editing history away.

Do not mark a journey proven because typecheck passed. Do not mark target components implemented because an interface exists. Do not commit secrets, local database content, raw provider thinking, or large generated media.

## GitHub enforcement limitation

GitHub returned HTTP403 when enabling branch protection for this private repository on the current plan. The repository remains private. CI and PR templates are active, but required checks/reviews and force-push protection are not server-enforced. Use the documented review workflow; enabling enforcement later requires an eligible GitHub plan. No subscription was changed.

## Shared checkpoint

Read [system navigation](docs/operations/system-navigation.md) and keep the coordinator-owned
[checkpoint](docs/CHECKPOINT.md) current through compaction and handoffs. Runtime observations
are timestamped and distinct from source status. [Delivery history](docs/operations/delivery-history.md)
links decisions to changes; GitHub remains the task board.
