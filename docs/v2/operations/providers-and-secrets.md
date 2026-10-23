# Providers and secrets

Status: **reference** (facts verified in v1 runs or by the owner; v2 adapters must be re-verified when built — S2.2 re-verified the MiniMax text rows marked "verified" below on 2026-10-19 with bounded real requests through the v2 adapter, S2.4 and S4.2 still to do). Sources: `../carried-forward-facts.md` CF-09, CF-10, CF-40, CF-50–CF-55 and the 2026-10-19 coding-approach research.

## Secret handling (binding)

- Never print, echo, cat, grep or interpolate a secret into a command, log, receipt, issue, PR or chat. That includes `.env` values, files under `/etc/knowscroll/` and anything derived from them (a `DATABASE_URL` with a password). Read secrets only inside a child process's environment; refer to variables by name.
- Provider keys live only in worker environments on the server (root-owned files under `/etc/knowscroll/secrets/`, copied once by hand from the owner's Mac without printing). Never in the client bundle, Git, logs, CI or evidence. The fal key never goes to a world, only to Cutroom.
- A provider response can carry a **third party's live credential** (MiniMax T2A returns a presigned Alibaba OSS URL). Redact at the recording boundary: drop any URL query whose parameter names look like key/token/secret/signature/sig/credential/password/auth — and if one matches, drop the whole query string; mask key-shaped values (`sk-…`, JWT-shaped). Scanning only for our own keys proves nothing.
- Before pushing to this public repository, check our key values, credential-shaped strings **and** anything a provider returned that we chose to persist. GitHub push protection is a backstop, not the check.

## MiniMax (text models; the initial `ModelPort` candidate)

| Fact | Consequence for the adapter |
|---|---|
| The owner's key is a token-plan key (`sk-cp-…`); no pay-as-you-go; the plan's FAQ describes "individual, interactive developer use" and its terms allow MiniMax to use inputs to improve services | Superseded by D-021 (owner, 2026-10-19): planner, Cartographer, Scenario Planner and room AI roles may send bounded personal-context-derived inputs to MiniMax for real users, knowing the terms. The harness sends only the role's prepared, bounded context (refs + bounded items), never a raw observation stream or a secret; requests are not logged; the privacy screen states that a third-party model processes exploration context; MiniMax keeps copies we cannot erase |
| Route used in v1: Anthropic-compatible `https://api.minimax.io/anthropic/v1/messages` with `MiniMax-M3` (the only vision model, 1M context); `MiniMax-M2.7` / `-highspeed` are text-only | Model and route are configuration, pinned per role and recorded on every attempt |
| **No `response_format` / JSON-schema mode**; `tool_choice` is auto only; no idempotency key | Ask for exactly one JSON object in the prompt, parse strictly, validate with the role's schema; at most one repair attempt; never assume the provider deduplicates |
| **Every model emits `<think>…</think>` reasoning blocks** by default; a small `max_tokens` can be consumed entirely by reasoning. **Verified 2026-10-19 on `MiniMax-M3`:** `thinking: {"type": "disabled"}` in the request is accepted on the Anthropic-compatible route and the answer arrives as a plain text block with no reasoning (13 output tokens for a 28-character JSON answer; no reasoning-token count is reported) | The adapter sends `thinking: disabled` and still strips a leading `<think>…</think>` from the answer (never from user text); budget `max_tokens` for the answer; "returns nothing that parses" usually means reasoning ate the budget |
| Quota: `GET https://www.minimax.io/v1/token_plan/remains`; v1 required provider status 0, one `general` entry and 25–100 % remaining in both the interval and weekly windows, failing closed when ambiguous. Other tools share the quota. **Verified 2026-10-19:** the same rule works with the token-plan key (`current_interval_remaining_percent` and `current_weekly_remaining_percent`, both 99 at the time) | Preflight before each attempt is an observation, not a reservation; record it on the attempt. The harness's floor is `KS_MINIMAX_QUOTA_FLOOR_PERCENT` (default 25) |
| **Open question for the first real response on dev (review m12):** the 2026-10-19 answers reported `input_tokens` 214 and `cache_read_input_tokens` 128. If `input_tokens` already includes the cached reads (as Anthropic's API does not, but a compatible route might), the harness's charge (input + cached + output) counts them twice and over-charges by the cached amount. Left conservative on purpose (an over-count only makes the caps trip early); check one response whose `input_tokens` is known to be uncached, then fix `chargedTokens` and the ledger SQL together | Until checked, budgets may be up to the cached share too high |
| **Usage on a 200 answer (verified):** `usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_input_tokens` (a repeated preamble was served from cache: 128 of 214 input tokens) and optionally `cache_creation_input_tokens`; `id` is a `msg_…` string; `stop_reason` `end_turn` | Record input, output, reasoning and cached counts as reported; `null` when not reported, never estimated. Charge reported input + cached + output, and the full reservation while usage is unknown |
| HTTP error bodies are parsed defensively as Anthropic-style `{type: "error", error: {type, message}}` or MiniMax's `base_resp.status_code` (not observed live in S2.2; no real request failed) | Keep only a sanitised `error.type` / `status_code` as the outcome code; never the message, headers or URLs. 429, 5xx (except 502/504) and 4xx are conclusive failures; 502/504, timeouts, resets and interrupted reads after the request left are `unknown` |
| `MiniMax-M3.1-Flash-Preview` is not available on the token-plan key | Do not configure it |
| T2A (speech) is covered by the plan and returns word-level subtitles via a presigned URL | Redaction rule above |

SDK/HTTP retries must be off: one admitted attempt equals one transport invocation (blueprint §15). A timeout after dispatch is `unknown` and is reconciled, never resent.

## fal (video; used only by Cutroom)

The owner's `.env` names the key `FAL_AI_KEY`; Cutroom reads `FAL_KEY`. Never rename or overwrite the owner's key; the Cutroom env file maps the value. KnowScroll code never calls fal directly. Balance is read on the fal dashboard (or `rest.alpha.fal.ai/billing/user_balance` with the Cutroom key, server-side only).

## AgentMail (sign-in mail)

Inbox `knowscroll@agentmail.to`; env `AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX_ID` (server: `/etc/knowscroll/secrets/shared/agentmail.env`). One `POST /v0/inboxes/{inbox}/messages/send`, bounded response read, no retry, no redirects; a 2xx counts only with a `message_id`; delivery failure never changes the response to the requester (no address oracle); failures log one sanitised event without address, token, link or key. In production the mail sender must be AgentMail and fully configured — no fallback to a file sink. Workers never receive this key.

## Cutroom

See `cutroom-and-spend.md` (written with S2.4/S4.2) and `../carried-forward-facts.md` CF-60–CF-66. Cutroom is a separate HTTP service we do not modify.
