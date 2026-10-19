# Discovery snapshots (2026-10-19)

Read-only discovery reports written before implementation started (evidence label: **source inspection**, plus read-only VPS/GitHub queries where stated). They describe what existed on 2026-10-19: the v1 repository at `dev@106c4701`, the VPS, GitHub settings, Cutroom and the v2.1 design export. They are inputs, not current truth; where they propose something, `../decisions.md` and the tracker record what was actually decided.

| Report | Contents |
|---|---|
| [design-screens.md](design-screens.md) | Every consumer artboard: states drawn and missing, controls → commands, conflicts, the five storyboard journeys, the **coverage matrix**, and the Scroll block inventory |
| [design-system.md](design-system.md) | Tokens (both registers), type, spacing, motion, 55 components, navigation and responsive rules, the Operator appendix, conflicts |
| [scroll-dsl.md](scroll-dsl.md) | The v1 Scroll implementations, the gap against v2.1, and the proposed `scroll-document.v1` DSL, limits and producer contract |
| [cutroom.md](cutroom.md) | Cutroom's HTTP contract at `94ee04a`, upstream drift, the v1 integration, live pool/budget state, and the proposed v2 `CutroomPort` |
| [deploy-ci-vps.md](deploy-ci-vps.md) | GitHub workflows, rulesets, environments, the `ks` deploy tool, the live VPS layout and the implications for v2 |

Renders of every artboard and storyboard step were made outside Git, in `/Volumes/Mrigesh SSD/knowscroll-dev/v2/design-reference/renders/` on the owner's SSD; regenerate them from `../design/` if needed.
