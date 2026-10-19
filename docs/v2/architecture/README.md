# Architecture snapshot (authoritative inputs)

These files are the authoritative architecture inputs for the v2 implementation, copied byte-for-byte from the architecture pass on 19 October 2026.

| File | Role |
|---|---|
| [02d-greenfield-blueprint.md](02d-greenfield-blueprint.md) | The architecture, algorithms, contracts, UI specification, code organisation and observability design. Governs architecture and product behaviour. |
| [02e-future-session-handoff.md](02e-future-session-handoff.md) | The decisions that must survive context loss. |
| [00-status.md](00-status.md) | Provenance and verification record of the documentation pass. |
| [03-design-brief.md](03-design-brief.md), [04-claude-design-prompt.md](04-claude-design-prompt.md), [design-references/](design-references/README.md) | The design handoff that produced the v2.1 export in [`../design/`](../design/README.md). |

**Scope note.** These documents say "documentation only" and forbid implementation, issue changes and deployments. The owner's implementation request of 19 October 2026 supersedes those task-scope restrictions; it preserves every product, privacy and reliability rule and does not reinstate any retired approval gate. Decisions taken during implementation, including blueprint/design conflict resolutions, are recorded in [`../decisions.md`](../decisions.md). The blueprint text is not edited here; when the implementation deliberately deviates, the decision log says so.

**Provenance.** Source: the untracked `docs/plans/personal-universe/` folder of the `codex/72-personal-universe-architecture` worktree, preserved in Git as commit `2a302917` on that branch. That commit also keeps the earlier discussion documents (`01-product.md`, `02-architecture.md`, `02a-contracts.md`, `02b-user-journey.md`, `02c-harness.md`) and the portable design pack. They are superseded by the blueprint and were deliberately not copied here; links to them from `00-status.md` resolve only on that branch.
