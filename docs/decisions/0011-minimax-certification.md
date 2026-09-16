# ADR-0011 — Bounded MiniMax certification before reasoning integration

Date: 2026-09-16. Status: accepted for implementation in #37 (children #38/#39); live compatibility is unproved until receipts exist. Extends ADR-0006 without enabling ordinary model jobs.

## Decision and scope

Certify `MiniMax-M3` through AI SDK `7.0.102` and MiniMax's documented `vercel-minimax-ai-provider` `0.0.2`, default Anthropic-compatible route `https://api.minimax.io/anthropic/v1`. The provider pins its internal Anthropic adapter to 3.0.6. AI SDK's version-3 compatibility path must pass actual transport tests. These are development certification tools, not the complete Job→Step→Attempt runtime or authority to apply proposals.

The existing ReasoningProvider port remains unready for product dispatch. New `certification-contract.ts` is the shared test/candidate adapter contract. `createMiniMaxCertificationAdapter(options)` in `minimax-certification.ts` executes one invocation and returns the typed observation. No API/keep/projector call imports or executes it.

### Wire fidelity and one request

Use AI SDK `generateText` with `maxRetries:0`, one step and no automatic tool execution. The official provider accepts a custom fetch. Its transport boundary preserves the supplied native ordered messages and full opaque content blocks rather than reconstructing thinking from display text; this explicitly compensates for normalizing SDK message conversions. Patch native `messages`, explicit M3 `thinking`, and `max_tokens` in the generated body, then validate/hash/bound the actual serialized body. Tool definitions use the supplied schemas. Unsupported SDK auto-generated headers/fields must be documented if removed, never silently change the model or route.

A caller-supplied `beforeDispatch` callback must finish its durable reservation before the single network fetch. Reject a second transport invocation. Recheck abort/deadline before network dispatch. Disable redirects and never switch credentials/endpoint/protocol or retry automatically. Use synthetic fixed certification prompts only; no owner database, private history or hidden system context. Native response content stays protected in-process for continuation and is never copied to public receipts.

Do not synthesize usage fields or successful provider responses to satisfy an SDK parser. A response rejected by the pinned SDK is an explicit compatibility failure, with any independently valid raw usage retained. Tokens from provider usage remain nullable if absent/invalid; cache fields are separate, no invented zero or dollar cost. Non-2xx, parse/SDK failures, deadline, abort and transport failure have distinct observations. A dispatched request with no conclusive response has unknown remote outcome/usage; local abort does not prove remote cancellation. Output validation failure never becomes an accepted proposal.

### Bounded live experiment and quota

The owner already reports 300 million tokens per five hours. The read-only official quota endpoint accepted the local subscription credential on September 16 and reported 100% interval / 95% weekly remaining; its numeric total counters are zero, so those counters are not evidence of a 300M live allowance.

Set the much smaller certification ceiling to **four serial invocations, 100,000 reserved input-plus-output token units, 16,384 serialized request bytes and 4,096 output tokens per request**, 60 seconds/request and five minutes/run. The four per-request caps yield a tighter maximum of 81,920 reserved units; 100,000 is an additional outer ceiling, not the amount this suite will spend. Reserve actual request UTF-8 bytes conservatively as input token units plus the requested output ceiling; fixed text/tool fixtures only, no image/video token estimation in this slice. Do not refund uncertain reservations or retry failed cases. This does not equate the provider's shared resource quota to raw tokens or invent a monetary cap.

Live mode requires an `sk-cp-` subscription key and the fixed official endpoint. Before each request GET `https://www.minimax.io/v1/token_plan/remains`, without redirects. Require successful provider status and finite 25–100% remaining in both current `general` quota windows. Missing/ambiguous/exhausted quota fails closed. Purchased Credits can cover overflow according to MiniMax; the tool never buys Credits or falls back to PAYG. Other tools share quota, so preflight is an observation, not an atomic vendor-side reservation. Stop on rate/quota errors.

### Durable certification journal

Runner: `scripts/certify-minimax.ts`; helper `apps/worker/src/providers/certification-journal.ts`. Use a new UUID-named directory only under the checkout's ignored artifacts tree, mode 0700, exclusive creation. Persist/fsync run policy and each numbered attempt reservation in a mode-0600 file **before** transport. Single writer/serial execution; limits checked against all prior reservations. Never resume/replay an existing run. A process crash leaves a prepared attempt as possibly dispatched with unknown remote outcome; a separate in-memory `dispatched` flag means only that local fetch was entered, never provider acknowledgement. An inspection/report path must preserve that uncertainty, not dispatch it again. Journal and public report contain only IDs, request/content hashes, limits, status, validated case booleans and nullable usage—no credentials, prompts, outputs, provider raw errors, headers or thinking blocks. Hash provider IDs rather than persisting untrusted IDs. This is a non-secret correlation pseudonym, not a claim of anonymization. Internal raw continuation remains trusted worker memory: snapshot it before asynchronous work, replay the complete assistant envelope, and whitelist exported receipt fields.

Case sequence: short locally validated JSON; tool-call request with thinking adaptive; exact native assistant content + deterministic tool result continuation. A missing/invalid tool call is a failed capability case, not a fabricated result; stop dependent cases. At most one optional fourth invocation is reserved for a narrowly documented additional check, never an automatic repair. Production structured-schema guarantees, streaming, vision, remote cancellation, idempotency lookup, pricing and long-horizon runtime remain uncertified.

## Alternatives and consequences

Using the official provider keeps the candidate aligned with MiniMax's documented AI SDK route. A direct native transport remains a fallback if certification exposes incompatible normalization; this wave does not silently switch to it. Using only SDK-normalized continuation cannot establish preservation of unknown native fields, so the tested transport boundary retains the original blocks. Enabling production jobs now would outrun durable admission, privacy-bound context compilation and deterministic proposal validation. Those dependencies stay explicit.

## Acceptance

Local HTTP fixture tests exercise the real SDK/wire path: no hidden retries on 429/500; exact opaque continuation preservation; actual output/input bounds; timeout/abort; missing usage; malformed response; no credential/error leakage. Journal tests cover exclusive creation, budget/attempt cap, fsynced pre-dispatch state, no replay, uncertain outcome, safe path and sanitized reports. The runner can refuse live mode safely without credentials. Coordinator owns actual live calls and redacted evidence. Child issues close for their bounded implementation proof; #7 remains open while its full acceptance is unmet.

## Sources

- [MiniMax AI SDK guide](https://platform.minimax.io/docs/api-reference/text-ai-sdk): official provider and compatibility routes.
- [Anthropic-compatible API](https://platform.minimax.io/docs/api-reference/text-anthropic-api): M3, native thinking/tool blocks and ordered continuation.
- [Token Plan FAQ](https://platform.minimax.io/docs/token-plan/faq): read-only quota endpoint, shared rolling/weekly limits and credit overflow.
- [AI SDK settings](https://ai-sdk.dev/docs/ai-sdk-core/settings): retry and abort controls; installed pinned source is reviewed alongside documentation.

The full reasoning runtime target remains in chapter 21. This certification journal is deliberately separate from production admission, lease fencing, user context, semantic read sets and deterministic proposal application.
