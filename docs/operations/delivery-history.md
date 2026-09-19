# Recent delivery and consequences

Status: historical index; source revision `cfe7aba` through September 19, 2026. These are the last
ten main changes at handoff, not an invented count of chat sessions. Later waves append entries
and refresh [CHECKPOINT](../CHECKPOINT.md); old evidence keeps its tested revision.

| Main revision / PR | Problem and delivered consequence | Remaining boundary |
|---|---|---|
| `289d243` / #71 | Wait for PostgreSQL disconnect before disposable teardown | Does not identify historical #57 cause |
| `b037213` / #65 | Record exact exposure-anchored literal Ask facts with privacy-safe replay | Recorded-only; no execution grant |
| `2f12c41` / #73 | Record owner's full UI/experience/live-video v1 bar | Scope agreement, no new capability |
| `0ada716` / #76 | Seal literal Ask context against original session and typed source dependencies | Separately supplied authorized Job only |
| `5782715` / #77 | Keep Scroll context through sources, deliberate discovery and recovery | Partial Android, desktop incomplete |
| `5d34403` / #79 | Safe internal direct-Job cancellation and expiry | No product enqueue/dispatch |
| `41e9ed4` / #80 | Reopen saved Traces with validated original source lineage | Read-only; changed sources fail closed |
| `2109356` / #83 | Safely completed/failed private context gets owner-selected seven-day retirement; bounded J004 test deadline corrected | No owner rollout; no invented terminal/apply loop |
| `62e8783` / #85 | Audit Cutroom source drift and host/import limitations | Source inspection, not real integration |
| `cfe7aba` / #87 | Strict internal Cutroom HTTP client and synthetic restart reconciliation | Unwired; newer upstream record schema now differs |

Detailed code/runtime receipts are indexed from [PROJECT-STATE](../PROJECT-STATE.md). Main CI
for `cfe7aba`: [run 35454296487](https://github.com/KnowScroll/knowscroll/actions/runs/35454296487).
Local acceptance for the last slice: 474 backend tests, 30 HTTP checks and separate synthetic
caller/server restart proof. Reviews in the later retention/audit/client waves used MiniMax M3;
earlier bounded workers used Sol/Terra. Review reports are not substitutes for coordinator checks.

## September 19 owner handoff decision (#88)

Owner selected **local Cutroom with SSD media**, requested a Claude Code ultracode handoff using
cheaper subagents, one durable shared checkpoint, truthful progress and removal of obsolete folders.
No new paid-call ceiling was supplied. Main `.env` contains configured names `MINIMAX_API_KEY`
and `FAL_AI_KEY`; `CUTROOM_BASE_URL` is blank. Values were not printed or copied to worker lanes.
See [Cutroom local handoff](cutroom-local-handoff.md), [cleanup inventory](worktrees.md) and
[runtime evidence](../journeys/evidence/claude-handoff/README.md).
