# ADR-0006 — AI SDK inside a bounded KnowScroll reasoning runtime

Date: 2026-09-15. Status: accepted under the owner’s delegated bootstrap authority.

## Context

The accepted architecture supports focused LLM jobs and long-horizon work, including optional bounded children, to understand questions and discover useful conceptual bridges. A generic coding-agent runtime is not the product state authority.

## Decision

Use AI SDK as a TypeScript model/tool-call library behind the worker-owned ReasoningProvider port. KnowScroll owns scheduling, budgets, context isolation, proposals, evaluation and deterministic application. MiniMax is the chosen candidate requiring live certification. Current runtime only declares the port and reports adapter_not_implemented; it does not install a fake provider or dispatch a model call.

## Alternatives and why

Embedding a full coding harness brings terminal/filesystem/conversation semantics the product does not require. Scattered direct vendor calls break attempt accounting and substitution. A separate AI service is possible later, but the module boundary is enough now. Direct native MiniMax transport remains an option behind the port if the chosen SDK adapter loses required capabilities.

## Consequences

Pin AI SDK and adapter versions when the first real adapter is implemented, then certify structured outputs, tool calls, vision, continuation blocks, retry visibility and usage/error accounting. Native provider thinking/tool blocks must survive internal continuation without being published as explanations. MINIMAX_API_KEY and an explicit test budget are needed for that task. SDK usage still sends authorized context to the configured provider; running the library locally does not keep inference data entirely inside our database.

## Sources and verification

[AI SDK documentation](https://ai-sdk.dev/docs/introduction), [reasoning runtime target](../architecture/target/21-REASONING-RUNTIME.md), [provider port](../../apps/worker/src/providers/port.ts).

## 2026-09-16 implementation update

[ADR-0011](0011-minimax-certification.md) pins AI SDK 7.0.102 and the official MiniMax provider 0.0.2 and adds a separate bounded development adapter and certification journal. The earlier port-only statement describes the bootstrap state. Ordinary ReasoningProvider dispatch is still unavailable: the candidate adapter does not implement production admission, privacy-bound context, leases or proposal application. The [certification operations guide](../operations/minimax-certification.md) defines explicit live execution and evidence limits.
