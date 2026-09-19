# ADR-0020 — Pinned, unwired Cutroom HTTP client

Date:2026-09-19. Status: proposed for#86; independent contract review precedes the client implementation. Extends ADR0007's source pin without changing its separate-service or publication ownership.

## Scope and reference

Pin the wire schemas and handler behavior to Cutroom238df85411108a94377311363dd296d785688f70, still declaring contractVersion1. The#84 source audit explains required criterion types and the current server's accepted stages. Copy the small upstream pure Zod wire modules with exact source hashes and provenance into a namespaced internal contract directory; upstream schemas remain recognizable and unchanged. Local client checks add identity, HTTP-status, cursor and resource limits without silently widening accepted shapes. No public endpoint, Job creation, paid dispatch loop, file import, publication, database migration or owner deployment.

The client lives beside the existing Cutroom port but does not implement its import method: a wire result alone cannot return an eligible KnowScroll asset. Tests use a local HTTP fixture with no upstream/provider credentials. This is protocol-fixture compatibility, not live Cutroom certification.

## Request identity and authority

Preparing an unknown input validates the pinned strict SubmitRequest and the server's actual planVaryOn restriction (omitted or shotCount). Required criterion types are supplied by the caller, never inferred. Preparation produces immutable canonical JSON bytes, requestId, requested stage and a SHA-256 body digest. Preparation and repeatable serialization grant no budget, privacy or dispatch authority. The future caller must durably bind these original bytes/identity to an authorized generation intent before first send; this client adds no such persistence.

Submit sends those exact prepared bytes once. A repeated explicit call uses the same identity/body; no automatic retry, new requestId, invented idempotency header or budget mutation. A lost/invalid response is uncertain about acceptance. Lookup uses the original requestId and validates the echoed identity. A lookup404 is only a current not-found observation; it is never proof that an earlier POST was unsent or permission to create another identity. Caller state and durable retry policy remain separate.

## Transport and outcomes

Configure a fixed literal loopback HTTP origin (127.0.0.1 or[::1], explicit valid port, no credentials/query/fragment/path). Do not accept arbitrary URLs from requests or results; redirects fail closed. The engine's current deployment contract is loopback only. An existing remote Cutroom host requires separately accepted deployment/transport; the owner host preference is pending and does not authorize public binding or new auth endpoints.

Each operation makes one fetch with a finite timeout and external abort propagation. Bound request bytes and streamed response bytes even without Content-Length. A stream error, timeout, abort or connection failure returns a fixed transport outcome with write uncertainty for submit/cancel; it never exposes raw errors/response bodies in logs. Malformed or mismatched protocol responses are distinct from transport failures and declared engine refusals. A pre-aborted operation performs no fetch. No request, output path or provider detail is logged by this client.

Validate operation-specific HTTP/body pairs: submit202 accepted,409 conflict and422 version/invalid/unsupported; status/lookup/cancel200 RunStatus; events200 EventsPage; result200 RunResult or409 running RunStatus; record200 RunRecord or409 running RunStatus. Known not-found/invalid/server-error responses use the pinned ErrorResponse and explicit typed status. Unexpected status/body combinations are protocol errors, not success or definitive no-dispatch evidence. Other upstream statuses such as429 remain explicit unexpected/protocol outcomes; no automatic retry follows.

All status/result responses must match expected runId/requestId; records/pages/events must match runId. Completed result stage must equal the requested stage. A strict event page requires every event.seq to be greater than the preceding cursor, matching run/version; nextSince equals the final returned seq, or the supplied cursor for an empty page. A finished event must be last. Gaps are not automatically filled or hidden, and the caller owns persistent cursor storage. Path strings remain untrusted engine-host metadata and are never opened, downloaded or exposed as a mobile URL here.

## Acceptance

Real local HTTP tests exercise each route/status/result variant, replay and request-body identity, response loss plus lookup, observed404 uncertainty, wrong run/request/version/stage, typed criteria/variation rejection, cursor regression/order/mixed identity, malformed bodies, redirects, oversized/chunked bodies, timeout, abort and cleanup. Capture only synthetic metadata/hashes in evidence. Typecheck, full regressions and independent protocol/privacy review gate merge. The future live journey still requires configured host/import, scoped demand and funding, provenance/truth/rights/continuity checks, full cost accounting and explicit bounded provider authorization.
