# Pinned, unwired Cutroom HTTP client

[#86](https://github.com/KnowScroll/knowscroll/issues/86) implements [ADR0020](../decisions/0020-cutroom-http-client.md) against Cutroom238df85411108a94377311363dd296d785688f70. The wire version remains1; the [source audit](cutroom-contract-audit.md) explains why implementation/schema pinning is also required. The original ADR0007 ownership boundary remains: Cutroom produces audiovisual artifacts; KnowScroll owns evidence, meaning, import and publication.

## Available code

`packages/contracts/src/cutroom-v1` contains seven unmodified upstream Zod modules and a per-file source manifest. `apps/worker/src/cutroom/http-client.ts` supplies preparation, submit, original-request lookup, status, events, result, record and cancellation. It is not imported by the ordinary worker/API and does not implement `CutroomHostAdapter.importFinishedAsset`.

Prepare validates the strict schema and the current server's omitted/shotCount variation restriction, then freezes canonical JSON bytes, requestId, stage and body digest. Keep those original bytes with the future authorized durable intent. Repeated explicit submissions reuse that exact stored string; the client never creates another request identity or automatically retries a POST. A reconstructed caller must verify its saved bytes/digest before any later write; the test fixture proves this only for its synthetic intent store.

An unusable submit/cancel acknowledgement retains write uncertainty. Lookup404 is a current absence observation and does not prove an earlier POST was unsent. Engine refusal, not-found, remote error, protocol mismatch, transport failure and unavailable result/record are separate outcomes. A409 result/record accepts the declared RunStatus shape and means pending data even if its state says finished. Only a validated RunResult identifies the actual ending; none of those endings alone publishes an asset or closes accounting.

## Limits and caller duties

Configure a literal loopback HTTP origin with an explicit nonzero port. No credentials, remote hostname, path/query/fragment or redirect is accepted. Requests are capped at256KiB; streamed responses default to1MiB and may be configured up to4MiB. Timeout defaults to5seconds and must be1–60,000ms. Identities must be nonempty, well-formed Unicode within1,024UTF-8 bytes; runIds cannot be dot path segments. Abort is propagated, including a pre-abort that makes no request. The fixture evidence uses IPv4 loopback.

The caller owns durable authorization, generation-intent identity, source/privacy epochs, budgets and uncertain-liability reconciliation. It also owns stored event cursors and lifecycle decisions. The client validates increasing event sequences and exact next cursor, preserving visible gaps rather than inventing missing events. It snapshots run-reference values before HTTP so subsequent caller mutation cannot substitute response authority.

Result paths are untrusted engine-host strings. The client never opens them, imports media or supplies mobile URLs. Host choice, artifact-root containment, verified file copying, rights/provenance/truth/continuity gates, inventory eligibility and playback remain future implementation. A remotely located engine requires a separately accepted host/transport arrangement; it must not be exposed without authentication by relaxing this client.

`budgetCents` and `costCents` follow the wire contract but are not verified complete paid-attempt accounting. No ordinary product call or live experiment is authorized by this module. Configure and pin the actual deployed engine, resolve metering gaps, and obtain the applicable bounded experiment authorization before live verification.

## Verification

Source `scripts/env.sh` so package caches and temporary fixture files stay on the configured SSD. `pnpm exec tsx --test tests/cutroom-http.test.ts` exercises a real local HTTP stand-in; `pnpm exec tsx scripts/run-isolated-cutroom-http-journey.ts artifacts/cutroom-http.json` replaces both caller and stand-in processes and verifies reconciliation/cleanup. Neither command invokes Cutroom or a provider. CI runs the latter after the existing reasoning/privacy journeys.

[Evidence and review](../journeys/evidence/cutroom-http/README.md) record exact revisions, source hashes and limitations. These checks do not prove actual engine idempotency, video generation, host-file lifetime, complete spend, publication or the full v1 experience.
