# Cutroom integration readiness — September 19, 2026

Issue [#84](https://github.com/KnowScroll/knowscroll/issues/84), under #9/#8/#72. This is a source audit and a bounded next-contract proposal. It neither runs Cutroom nor enables generation. The existing adapter is still a port declaration. [ADR-0007](../decisions/0007-cutroom-separate-http-service.md) remains the accepted architectural boundary; its September15 pin remains a historical reference until a successor implementation contract adopts a new pin.

## Evidence boundary

Compared the same eight files at `60ba257cbe9bfbdd32040a1acd793644c00e74e5` and observed upstream `238df85411108a94377311363dd296d785688f70` (September19). [Manifest](evidence/cutroom-contract-audit/source-manifest.json) records all16 SHA-256 hashes. The source snapshots and audit logs are on the external SSD. This is not a repository-wide audit, deployment discovery, live compatibility certification, paid-attempt audit or video-quality assessment.

MiniMax M3 independently compared seven file pairs; the coordinator inspected the actual differences, verified both version modules, and reconciled [review findings](evidence/cutroom-contract-audit/review.json) with KnowScroll's existing ownership. Suggested new upstream endpoints were not adopted.

## What changed

| Boundary | Verified current source | Consequence for KnowScroll |
|---|---|---|
| Version | Both [version modules](https://github.com/KnowScroll/Cutroom/blob/238df85411108a94377311363dd296d785688f70/packages/reel-contract/src/version.ts) still declare1 | A matching integer version is insufficient to establish compatible request shape; pin the implementation/schema revision too |
| Criteria | [Request schema](https://github.com/KnowScroll/Cutroom/blob/238df85411108a94377311363dd296d785688f70/packages/reel-contract/src/request.ts) now requires each criterion's `type` to be `presence` or `event`; `mustNotShow` accepts only `presence` | Older untyped criteria fail validation. The trusted depiction-policy compiler must supply the type; do not infer it from arbitrary criterion prose |
| Requested stage | [Server](https://github.com/KnowScroll/Cutroom/blob/238df85411108a94377311363dd296d785688f70/apps/api/src/server.ts) removes the older plan-only422 gate | Current HTTP admission accepts `plan`, `stills` and `video` schema values. This alone does not prove renderer/provider success |
| Record handler | The server now calls `readRecord` instead of returning an empty record | The [record schema](https://github.com/KnowScroll/Cutroom/blob/238df85411108a94377311363dd296d785688f70/packages/reel-contract/src/record.ts) remains pictures plus degradations, not all takes or all paid attempts |
| Other wire definitions | [Responses](https://github.com/KnowScroll/Cutroom/blob/238df85411108a94377311363dd296d785688f70/packages/reel-contract/src/responses.ts), [routes](https://github.com/KnowScroll/Cutroom/blob/238df85411108a94377311363dd296d785688f70/packages/reel-contract/src/routes.ts), [events](https://github.com/KnowScroll/Cutroom/blob/238df85411108a94377311363dd296d785688f70/packages/reel-contract/src/events.ts), record and version files are byte-identical across the audited pins | No new file-download, authentication, usage, cancellation-body or idempotency-header contract follows from this change |

The [amended upstream contract](https://github.com/KnowScroll/Cutroom/blob/238df85411108a94377311363dd296d785688f70/docs/features/reel-contract.md) describes real video support and pictures-only records. Those are upstream declarations in this audit; KnowScroll has not exercised them. It also explains that a stills ceiling refusal compares the pictures' share of the estimate. An estimate or aggregate `costCents` is not independent proof of complete paid-attempt settlement.

## Keep the actual HTTP boundary

`POST /v1/runs` carries `requestId` in the body, a positive integer `budgetCents`, narration, opaque claims, typed criteria, style and stage options. The server checks version/schema and supported variation before calling `submitRun`; invalid input is422, conflicting identity is409, acceptance/replay is202. `planVaryOn` currently permits only omitted or `shotCount` at the server, despite the broader schema union. The audit did not inspect `submitRun` internals, so canonical-equivalence and restart/idempotency proof remain requirements for the adapter suite.

The remaining declared routes are lookup by requestId, run status, events since a cursor, finished result, finished record, and cancellation. Result/record return409 while unfinished. Polling is the contract; do not invent SSE. An ambiguous submission must preserve the original request identity and immutable body for lookup/reconciliation. A cancellation acknowledgement is not proof that a remote paid operation was undone or that liability is zero.

## File import, hosting and accounting

The server **enforces** binding to127.0.0.1 and checks no authentication credential in the reviewed handlers. The documented V1 assumption is same-host loopback, not a remotely accessible authenticated service. The owner has been asked which host the real integration should target; no remote exposure or service configuration has been performed.

Result schemas accept non-empty path strings. The documentation says these are absolute engine-host file paths and promises no retention duration. KnowScroll must validate an expected configured artifact root, resolve path/symlink boundaries, copy and verify bytes into its own SSD/media store, and only then consider publication. A result path is neither trusted filesystem authority nor a mobile URL. A remote host needs a separately accepted authenticated transport; this audit does not invent one. If files are unavailable, retain honest import failure and keep the asset ineligible.

The existing record does not certify all paid attempts. Before a live bounded experiment, inspect actual provider/render accounting and the configured host, agree its cap and stopping rules, and preserve uncertain spend. A positive request budget and returned `costCents` do not establish a release-grade all-in meter. No such experiment is authorized by this audit.

## Next bounded implementation proposal

Adopt the audited newer revision in a successor contract before implementing a provider-free HTTP protocol client. Give that client strict request/response validation, a fixed configured loopback origin, bounded reads/timeouts, no automatic new identity after uncertainty, original-request lookup, monotonic cursor validation and distinct acceptance/refusal/running/terminal/protocol/transport outcomes. Test it against the exact upstream shapes and local fault fixtures; label that evidence as fixture compatibility. No public generation route, product queue or publication consumer belongs in that client slice.

Separately settle the host/file transport, build the scoped ContentDemand/GenerationJob and inventory ownership contracts, implement validated import, and connect truth/provenance/rights/continuity gates before a Reel becomes eligible. Real Cutroom generation, media import/playback, interruption recovery, costs and owner acceptance remain required by #9 and [full v1](../product/v1-release.md). Neither this audit nor an isolated HTTP client completes those gates.
