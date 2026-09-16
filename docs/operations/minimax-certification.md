# MiniMax M3 development certification

This runner records a bounded compatibility experiment for ADR-0011. It does not enable ordinary reasoning jobs, prove production suitability, or authorize model output to change KnowScroll state.

## Safety boundary

The live command uses only `MiniMax-M3` through the fixed official Anthropic-compatible route `https://api.minimax.io/anthropic/v1`. It accepts only an `sk-cp-` subscription key from the current process environment. It does not load `.env`, follow redirects, retry, resume a run, switch to PAYG, or accept an endpoint override.

Before every provider request it reads `https://www.minimax.io/v1/token_plan/remains`. The response must contain one `general` entry, provider status zero, and finite current interval and weekly remaining percentages from 25 through 100. The zero-valued total counters seen during preparation are deliberately ignored.

The run permits three fixed cases and no automatic repair request:

1. a small response that is parsed locally as one exact JSON object;
2. one exact typed tool call with adaptive thinking;
3. the provider's exact native assistant blocks followed by a deterministic local tool result carrying the same tool-call ID.

The continuation case does not run if the tool call is missing or invalid. A `max_tokens` stop is a case failure even if partial text parses as JSON.

Hard limits are four serial requests, 100,000 outer reserved units, 16,384 serialized request bytes, 4,096 output tokens per request, 60 seconds per request and five minutes per run. The three fixtures reserve 512, 2,048 and 2,048 output tokens. Each reservation charges the final request's UTF-8 bytes plus its output ceiling. Reservations are never refunded after an uncertain result.

## Running

Load only the repository's runtime environment first:

```sh
. ./scripts/env.sh
```

The default command is a refusal with usage help and performs no credential read or network call:

```sh
pnpm exec tsx scripts/certify-minimax.ts
```

The coordinator owns live execution. Put the subscription key in the invoking process without writing it to command history, then explicitly select live mode:

```sh
MINIMAX_API_KEY="$MINIMAX_API_KEY" pnpm exec tsx scripts/certify-minimax.ts --live
```

The example assumes `MINIMAX_API_KEY` is already present in the shell. The runner never prints it. Do not paste the key into an issue, PR, receipt, log or committed file.

## Journal and inspection

Every run creates a new UUID directory beneath ignored `artifacts/minimax-certification/`. The run directory is mode `0700`; policy and attempt files are mode `0600`. Before a transport fetch, the adapter supplies the hash and bounds of its final serialized body. The runner exclusively creates and fsyncs a numbered `prepared` attempt file, then fsyncs its directory. Only after that callback returns may the adapter dispatch.

Resolution is an appended, fsynced sanitized record. A crash or torn resolution leaves the prepared attempt with `remoteOutcome: "unknown"`. Inspection never resumes or replays it:

```sh
pnpm exec tsx scripts/certify-minimax.ts --inspect artifacts/minimax-certification/<run-uuid>
```

Inspection accepts only a UUID run directly under the checkout's ignored artifact root and refuses symlinks. Public output is derived from a fixed whitelist: run and attempt IDs, request and response hashes, limits and counts, finite nullable usage, HTTP status, known booleans, and bounded status enums. Provider request IDs are hashed. Prompts, outputs, native content blocks, thinking, credentials, headers and raw provider errors are never persisted.

`remoteOutcome: "unknown"` is intentional for unresolved prepared attempts and dispatched aborts, timeouts, transport failures or invalid responses. A local abort is not evidence that the provider cancelled work. `remoteOutcome: "no_dispatch"` means the current fetch was conclusively not started. Quota preflight is a read-only observation and cannot reserve shared provider capacity.

## Verification and limits

Run the offline tests without a credential:

```sh
. ./scripts/env.sh
pnpm exec tsx --test tests/certification-journal.test.ts tests/certify-minimax.test.ts
pnpm typecheck
```

The tests use isolated ignored directories and local/fake HTTP boundaries. They verify exclusivity, permissions, pre-dispatch persistence, non-replay, budget accounting, quota rejection, dependency stopping, continuation fidelity and receipt redaction. Passing offline tests does not establish live MiniMax compatibility. A successful bounded live receipt still does not certify streaming, vision, remote cancellation, idempotency lookup, pricing, long-horizon behavior, production structured generation or semantic proposal application.
