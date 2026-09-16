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

## Process

Use Context, Decision, Alternatives and why, Consequences, Status, and Sources/verification. A new decision may supersede an earlier ADR; keep the earlier record and add a superseded link. Routine implementation details do not need an ADR.
