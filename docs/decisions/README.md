# Architecture decisions

Read the relevant decision before changing its boundary. These choices were made under the owner’s explicit delegation; runtime success and product usefulness still need evidence.

- [ADR-0001 — One product monorepo, separate Cutroom](0001-monorepo-layout.md)
- [ADR-0002 — Native Kotlin and Compose for Android first](0002-native-android-compose.md)
- [ADR-0003 — TypeScript API and workers over PostgreSQL](0003-typescript-node-fastify-postgres.md)
- [ADR-0004 — Canonical history with derived state and exposure lineage](0004-ledger-events-derived.md)
- [ADR-0005 — SQL work admission and separate paid execution protocol](0005-sql-jobs-and-external-deferred.md)
- [ADR-0006 — AI SDK inside a bounded KnowScroll reasoning runtime](0006-ai-sdk-provider-port.md)
- [ADR-0007 — Cutroom stays a separate video-generation system](0007-cutroom-separate-http-service.md)
- [ADR-0008 — Adopt the full product foundation](ADR-0008-foundation-adoption.md)
- [ADR-0009 — Device sessions and privacy epoch fences](0009-device-sessions-and-privacy-epochs.md)
- [ADR-0010 — Clear Scroll history with a retryable privacy boundary](0010-clear-scroll-history.md)
- [ADR-0011 — Bounded MiniMax certification](0011-minimax-certification.md)

- [ADR-0012 — Durable reasoning admission and uncertain outcomes](0012-reasoning-admission-and-reconciliation.md)

- [ADR-0013 — Bounded reasoning fairness](0013-bounded-reasoning-fairness.md)

- [ADR-0014 — Sealed direct Scroll context](0014-sealed-direct-context.md)

- [ADR-0015 — Seven-day retirement of withdrawn reasoning jobs](0015-withdrawn-reasoning-retirement.md)

- [ADR-0016 — Literal exposure-anchored Ask facts](0016-explicit-ask-facts.md): source-only direct intent, strict replay/privacy boundaries; no reasoning queue or mobile answer.

- [ADR-0017 — Sealed literal Ask context](0017-sealed-ask-context.md): separate family, original-session authority and immutable scoped Job binding.

- [ADR-0018 — Safely withdraw idle direct Jobs](0018-idle-direct-job-withdrawal.md): original-session cancellation, trusted database deadline expiry, atomic fairness closure and bounded maintenance.

- [ADR-0019 — Completed/failed private retirement](0019-completed-failed-private-retirement.md): owner-approved168-hour finish clock, conservative legacy retention and bounded private cleanup.

- [ADR0020 — Pinned Cutroom HTTP client](0020-cutroom-http-client.md): fixed source revision, strict bounded wire outcomes and uncertainty-safe reconciliation; no import or product dispatch.

- [ADR-0021 — Cutroom successor pin and local SSD host](0021-cutroom-successor-pin-and-local-host.md): `86d6e2c` record with required takes; KnowScroll-owned operator host composing upstream API/worker with stand-ins only.

- [ADR-0022 — Desktop is a TypeScript web surface](0022-desktop-web-surface.md): owner-chosen React/TypeScript/Vite app in `apps/web`; loopback dev-only auth proxy; §9.5 desktop interactions.

- [ADR-0023 — Generated Reel supply](0023-generated-reel-supply.md): editorial briefs over sourced Scrolls, guarded budget grants and Cutroom attempts, verified local-host import; nothing eligible or published.

- [ADR-0024 — Publication gates, eligibility and media serving](0024-publication-gates-and-media-serving.md): recorded gate verdicts derive eligibility; the Visual Witness gate is required and structurally unavailable; stand-in media can only be eligible inside a disposable test database.

- [ADR-0025 — A gated Reel becomes inventory](0025-eligible-reels-in-inventory.md): publication mints an `asset` of kind Reel from a gated generated Reel; the feed offers Reels only to clients that ask for them.

- [ADR-0026 — Real sign-in: one owner account, email magic link](0026-magic-link-single-user-identity.md): owner-chosen magic link and single-user v1; one account enforced by the database; tokens hashed, single-use, consumed by POST so a prefetched link cannot sign anyone in.

- [ADR-0027 — Magic links are delivered through AgentMail](0027-agentmail-magic-link-delivery.md): one send attempt, key only in the process environment, failures never become an address oracle, and the loop is proved by reading the inbox back.

## Process

Use Context, Decision, Alternatives and why, Consequences, Status, and Sources/verification. A new decision may supersede an earlier ADR; keep the earlier record and add a superseded link. Routine implementation details do not need an ADR.
