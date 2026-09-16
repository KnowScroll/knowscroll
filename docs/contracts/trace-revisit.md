# Saved Trace source revisit — #78

Status: accepted for #78 after independent Terra review of `d741217`; coordinator typecheck passed. Consumer implementation and journey proof remain pending. Extends the existing bootstrap HTTP surface; no schema or retention change.

## Read authority and source

`GET /v1/traces/:eventId` consumes a projected Keep event ID. On the same transaction as `authenticateAndLock`, hold the authenticated universe and session, then verify the private Trace → Keep Ledger → original exposure/event → decision chain. Every scoped row must belong to that universe and current privacy epoch, and all asset, event, payload and causation references must agree. A Trace is necessary; a merely admitted but unprojected Keep is not enough. A current authorized session of the owning universe may read; the original Keep session is not an additional access restriction.

Exactly one decision candidate must canonically match the asset UUID, including rejection of mixed-case duplicate UUIDs before parsing the selected candidate. Stored candidates are objects with recommendation metadata (currently `reason`); do not parse them directly with the strict response schema. `traceRevisitCandidate` validates and canonicalizes the nine named display fields (assetId, revision, kind, title, summary, body, sourceTitle, sourceUrl, truthState) and projects only those fields. It permits and ignores all additional selection metadata, including `reason`; metadata cannot supply displayed content or equality authority. Compare those nine fields with the current asset and return them through strict `traceRevisitScroll`, which excludes metadata. Never silently substitute the current asset row.

For this bounded slice, acquire the current shared asset row FOR SHARE after the owned private scope, compare every displayed field/revision with the selection, then recheck session liveness and current scope using database time without a new lock. A changed/missing source is unavailable. This retains the existing source-drift refusal used for direct context; historical-version display and correction propagation are separate later work. Holding the universe serializes Clear; holding the asset prevents a correction from racing the validated read. Once a response is delivered, later source updates cannot retract its already delivered bytes; no continuous revocation guarantee is claimed.

The route performs no domain writes: no decision, exposure, Keep, job, Trace, reasoning or accounting row. It does not count a revisit as fresh evidence or update learning. Explicit new discovery continues through the existing feed/exposure flow.

## Wire contract

Successful 200 response:

```ts
type TraceRevisit = {
  mode: 'kept_revisit';
  traceEventId: string;
  universeId: string;
  privacyEpoch: number;
  exposureId: string;
  keptAt: string;
  scroll: ScrollAsset;
};
```

`ScrollAsset` is the existing documented Scroll display shape, without a recommendation reason. `keptAt` is the original Keep Ledger row's `created_at`, not its later projection time; the existing universe Trace `createdAt` retains its current projection timestamp. The client may explain the explicit fact “Saved from your Keep”; it may not invent selection personalization. Canonical UUIDs are returned. The route accepts no body or alternative asset/decision/session identifiers. Invalid event ID → 400; rejected session → generic 401; missing/foreign/unprojected Trace → generic 404; stale epoch or changed source → 409; inconsistent/ambiguous/malformed lineage → 422. No private content or raw SQL errors appear in error bodies. Reuse existing error semantics with stable, brief messages.

`GET /v1/universe` retains its existing response shape. Trace titles must come from the unique valid original selected snapshot, not the mutable asset title. Malformed/unavailable selection history uses the neutral title “Saved Scroll unavailable” without preventing other valid entries from returning. This list does not certify current source availability; opening performs the full guarded read. Current source drift never renames the historical Trace.

## Native state and navigation

An accessible real Trace card opens this endpoint with that event ID. Loading/error/retry preserve the requested identity. Render only a successful response that matches the requested event ID, asset ID from the card when available, and reconciled universe/epoch. A revisit has a distinct origin from feed discovery. Keep displays its already recorded state and cannot send another interaction. Drawing or restoring a revisit never calls the exposure endpoint. Source/truth controls work normally; Back/Home returns to Universe. An explicit Next discovery is a fresh feed operation and becomes normal discovery only after success.

Persist only revisit identity, owner universe/epoch and reading position; do not persist its body or assume an old response is still authorized. Rotation may retain an in-memory view model; cold restoration must first reconcile server scope and refetch the trace. Clear, 401, changed owner/epoch, mismatched response, or unavailable-source response discards private revisit content and pending origin. Transport uncertainty keeps the requested identity for explicit retry but must not substitute a different Scroll. Reuse existing general authority/cache protections. Restore exact reading position only for the same successful trace identity/revision.

## Proof and limits

Real SQL/API adversaries cover missing/foreign/unprojected traces, old epochs, malformed and duplicate candidates, wrong causal/payload links, current source drift, resource-wait session expiry, Clear serialization and zero-write reads. Joined mobile proof covers Keep/projection/reopen/source/return, rotation/cold restore, unavailable network/retry, source change, Clear/revocation, compact layout and existing discovery regressions. Use disposable database/identities and `.journey` Android app, all local storage on the external SSD.

No Ask answer, public identity, offline source cache, historical correction/version UI, desktop, semantic world or full-v1 completion follows. The source-revisit boundary is an intermediate capability under #3/#72.
