# ADR-0007 — Cutroom stays a separate video-generation system

Date: 2026-09-15. Status: accepted under the owner’s delegated bootstrap authority.

## Context

Cutroom already exists in its own private repository. KnowScroll creates content demand and owns meaning, evidence and publication; Cutroom produces audiovisual artifacts through a strict HTTP contract.

## Decision

Pin contract v1 at upstream commit `60ba257cbe9bfbdd32040a1acd793644c00e74e5`, verified 2026-09-15. Implement the adapter in a later issue against these actual endpoints:

- POST `/v1/runs` with contractVersion, requestId, worldId, narration, opaque claims, criteria, style and options.
- GET `/v1/runs?requestId=` to reconcile ambiguous submission.
- GET `/v1/runs/:runId`, `/events?since=n`, `/result`, `/record`.
- POST `/v1/runs/:runId/cancel`.

The request requires a positive integer budgetCents. Same requestId and equivalent valid body replays; different content conflicts. Events are paged/polled; do not invent a streaming transport.

## Alternatives and why

Importing Cutroom implementation would duplicate ownership. Calling provider SDKs from the API/mobile would bypass this boundary. A new endpoint is a contract proposal in Cutroom, not a local assumption.

## Consequences

Results contain absolute filesystem paths on the engine host, not CDN or mobile URLs; retention is not promised. Host-local import or an authenticated transport must copy/check assets into KnowScroll-controlled storage. KnowScroll owns sources/truth/provenance, Visual Witness and reconciliation/publication gates. Cutroom has no sources card. Its /record is a read, not an accounting write endpoint. Loopback/no-auth hosting cannot be silently treated as a secure remote service. Verify actual paid-attempt metering and deployed transport before cost or integration claims; no live Cutroom run was performed in bootstrap.

## Sources and verification

[Pinned upstream contract](https://github.com/KnowScroll/Cutroom/blob/60ba257cbe9bfbdd32040a1acd793644c00e74e5/docs/features/reel-contract.md), [content lifecycle target](../architecture/target/23-CONTENT-DEMAND-AND-INVENTORY.md).

## Later source observation — September19

The [current contract audit](../operations/cutroom-contract-audit.md) records changes at upstream238df854, including required criterion types within version1 and video admission. It preserves this original pin and decision as history. A successor adapter contract must deliberately adopt its implementation revision; no live integration or new transport is established by the audit.

[ADR0020](0020-cutroom-http-client.md) now adopts238df854 for an unwired HTTP client and the updated criteria schema. It supersedes only this earlier implementation reference, preserving separate service, host-file and publication ownership. It does not certify a deployed engine or change remote transport.
