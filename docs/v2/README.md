# KnowScroll v2 documentation

| Path | What it is | Status |
|---|---|---|
| [architecture/](architecture/README.md) | The authoritative greenfield blueprint, its handoff and the design brief | Specification (not proof that anything runs) |
| [design/](design/README.md) | The v2.1 design export: tokens, components, every artboard, the clickable storyboard | Visual specification; example data only |
| [design/v3/](design/v3/README.md) | The final v3 designs for the Universe, Scrolls, rooms and Talk (owner, 29 and 30 Oct 2026) | Visual specification; example data only |
| [v3-revamp/](v3-revamp/README.md) | The change map from the v3 designs to the code, and its three findings | A starting map, not proof |
| [decisions.md](decisions.md) | Decisions made during implementation, including design conflict resolutions | Binding, append-only |
| [carried-forward-facts.md](carried-forward-facts.md) | Owner rulings and operational facts kept from the v1 docs | Binding where not changed by `decisions.md` |
| `operations/` | Runbooks for environments, deploys, backups, providers and inspecting the running system | Procedures; verify the named environment before claiming an operation ran |

Package and backend-module READMEs live next to their code. Each one says what is planned, implemented and runtime-verified.

For a focused starting point use the [issue workflow](engineering/issue-context.md). Earlier [discovery snapshots](../archive/README.md) describe the pre-implementation system.

For a first code change, use the [repository entry guide](../../README.md), then the owning
package README. [Runtime configuration](engineering/runtime-configuration.md) names settings;
[Status](../STATUS.md) and linked CI/deployment evidence say what was checked. Immutable design
exports and their authored examples remain inputs, not product data. Historical rollout notes in
module guides do not replace the current source or authorize a migration, provider call or release.
