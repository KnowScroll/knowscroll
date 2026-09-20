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

## September 20 — Claude Code coordinator, wave 1 (#89)

Owner decisions: KnowScroll does **not** modify or develop Cutroom and integrates only against its
published reel-contract; a live test (≤ $2 total) waits until upstream ships real providers; H3 is
fal MiniMax H3 Max, used only by Cutroom; desktop is a TypeScript web app (ADR-0022, #92).

| Change | Problem and delivered consequence | Remaining boundary |
|---|---|---|
| `7449677` / #93 (#89) | Upstream `86d6e2c` made `RunRecord.takes` required; client repinned with strict tests. KnowScroll-owned `ops/cutroom-host/` runs pinned upstream API/worker as separate SSD processes (stand-ins + ffmpeg); 12-scenario joined proof against real service/SQLite | No real providers, import, publication, playback or product dispatch; proof not in CI |

Workers: Claude Code Sonnet (`claude-sonnet-5`, forced via `CLAUDE_CODE_SUBAGENT_MODEL`) for host,
proof (two phases) and independent review; coordinator Opus reproduced self-check, joined proof and
the full backend suite on the integration head. Upstream's own suite shows 16 deterministic macOS
failures at the pin (recorded, not filed upstream per owner). Measured workflow usage: 4 agents,
~1.31 M subagent tokens, ~3 h wall time.

| Change | Problem and delivered consequence | Remaining boundary |
|---|---|---|
| `e5573b4` / #95 (#92) | v1 needs a desktop surface and none existed. Owner chose a TypeScript web app (ADR-0022); `apps/web` reaches reader parity on existing endpoints with §9.5 desktop interaction, exposure only when genuinely visible, epoch-scoped storage and a loopback dev-only auth proxy | Chromium only; Playwright not in CI; no production identity (#2); no Reel/branch/world/social surfaces |
| `b8bfe3e` / #96 (#91) | A person could not see why a Scroll appeared, and could not end a device session. Both now exist on Android, built from returned facts only, with a real 204/401 sign-out that erases no history | Open sheet does not survive Activity recreation (#97); no mobile Ask (ADR-0016); no owner visual acceptance |
| `363c818` / #98 (#94) | No path existed from an authorized request to a verified media file. ADR-0023 + migration 0013, the generation runtime and verified local-host import now carry a job from an editorial brief to a content-addressed MP4, with request bytes persisted before dispatch, original-identity reconciliation, a bounded identical-bytes resend, recorded overage that pauses a grant, and J005 6/6 against a real local Cutroom with stand-ins | No real providers or generation quality; no complete paid-attempt metering; nothing eligible, published, served or playable; J005 local-only; no owner deployment |

Coordinator reproduced every slice before merging: #92's browser journey and an independent bundle
secret check, #91's on-device journey on a fresh AVD, and #94's J005 plus 539 backend tests. The #94
review found a real contract defect of the coordinator's own — an over-ceiling cost was
unrepresentable and wedged the job — fixed before merge. Workers were `claude-sonnet-5` throughout.
