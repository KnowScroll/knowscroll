# ADR-0003 — TypeScript API and workers over PostgreSQL

Date: 2026-09-15. Status: accepted under the owner’s delegated bootstrap authority.

## Context

The fast path needs deterministic transactions and bounded response latency. The slow path needs durable work and typed provider integrations. Existing Node22.23.0, Java17 and PostgreSQL16.14 can be reused without disturbing other projects.

## Decision

Use strict TypeScript/ESM, Node22.23.0, Fastify5, PostgreSQL16. API and worker are separate processes against one database. Use a separate development cluster on SSD port55432; do not alter the existing Homebrew PostgreSQL service. No Docker requirement, Redis, Kafka, Kubernetes or Temporal in this baseline.

## Alternatives and why

Rust/Go would be credible for CPU-intensive services but offer less immediate alignment with AI SDK and existing TS contracts. Kotlin everywhere could share Android language skills but would require a separate AI SDK integration strategy. Bun/Deno introduce runtime validation work without a demonstrated need. Node24 active LTS is a valid upgrade; reuse the installed maintained Node22 line for bootstrap and schedule upgrade before its support ends.

## Consequences

Pin resolved dependencies with pnpm-lock.yaml; use PostgreSQL transactions for admission and short projections. One database does not mean one module owns all tables. Queue fairness, latency, cost and 10,000-user capacity remain unmeasured. Add infrastructure when measured contention, durability or operational requirements justify it.

## Sources and verification

[Node release support](https://nodejs.org/en/about/previous-releases), [Fastify server](https://fastify.dev/docs/latest/Reference/Server/), [PostgreSQL row locking](https://www.postgresql.org/docs/16/sql-select.html).
