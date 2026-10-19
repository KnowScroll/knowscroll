# Providers and secrets

Status: **reference** (facts verified in v1 runs or by the owner; v2 adapters must be re-verified when built — S2.2, S2.4, S4.2). Sources: `../carried-forward-facts.md` CF-09, CF-10, CF-40, CF-50–CF-55 and the 2026-10-19 coding-approach research.

## Secret handling (binding)

- Never print, echo, cat, grep or interpolate a secret into a command, log, receipt, issue, PR or chat. That includes `.env` values, files under `/etc/knowscroll/` and anything derived from them (a `DATABASE_URL` with a password). Read secrets only inside a child process's environment; refer to variables by name.
- Provider keys live only in worker environments on the server (root-owned files under `/etc/knowscroll/secrets/`, copied once by hand from the owner's Mac without printing). Never in the client bundle, Git, logs, CI or evidence. The fal key never goes to a world, only to Cutroom.
- A provider response can carry a **third party's live credential** (MiniMax T2A returns a presigned Alibaba OSS URL). Redact at the recording boundary: drop any URL query whose parameter names look like key/token/secret/signature/sig/credential/password/auth — and if one matches, drop the whole query string; mask key-shaped values (`sk-…`, JWT-shaped). Scanning only for our own keys proves nothing.
- Before pushing to this public repository, check our key values, credential-shaped strings **and** anything a provider returned that we chose to persist. GitHub push protection is a backstop, not the check.

## MiniMax (text models; the initial `ModelPort` candidate)

| Fact | Consequence for the adapter |
|---|---|
| The owner's key is a token-plan key (`sk-cp-…`); no pay-as-you-go; the plan's FAQ describes "individual, interactive developer use" and its terms allow MiniMax to use inputs to improve services | Personal-context roles run only for disposable test accounts until the owner decides otherwise (tracker #222, owner decision 4) |
| Route used in v1: Anthropic-compatible `https://api.minimax.io/anthropic/v1/messages` with `MiniMax-M3` (the only vision model, 1M context); `MiniMax-M2.7` / `-highspeed` are text-only | Model and route are configuration, pinned per role and recorded on every attempt |
| **No `response_format` / JSON-schema mode**; `tool_choice` is auto only; no idempotency key | Ask for exactly one JSON object in the prompt, parse strictly, validate with the role's schema; at most one repair attempt; never assume the provider deduplicates |
| **Every model emits `<think>…</think>` reasoning blocks**; a small `max_tokens` can be consumed entirely by reasoning | Disable thinking where supported or strip framing in the adapter (never from user text); budget `max_tokens` for reasoning + answer; "returns nothing that parses" usually means this |
| Quota: `GET https://www.minimax.io/v1/token_plan/remains`; v1 required provider status 0, one `general` entry and 25–100 % remaining in both the interval and weekly windows, failing closed when ambiguous. Other tools share the quota | Preflight before each attempt is an observation, not a reservation; record it on the attempt |
| `MiniMax-M3.1-Flash-Preview` is not available on the token-plan key | Do not configure it |
| T2A (speech) is covered by the plan and returns word-level subtitles via a presigned URL | Redaction rule above |

SDK/HTTP retries must be off: one admitted attempt equals one transport invocation (blueprint §15). A timeout after dispatch is `unknown` and is reconciled, never resent.

## fal (video; used only by Cutroom)

The owner's `.env` names the key `FAL_AI_KEY`; Cutroom reads `FAL_KEY`. Never rename or overwrite the owner's key; the Cutroom env file maps the value. KnowScroll code never calls fal directly. Balance is read on the fal dashboard (or `rest.alpha.fal.ai/billing/user_balance` with the Cutroom key, server-side only).

## AgentMail (sign-in mail)

Inbox `knowscroll@agentmail.to`; env `AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX_ID` (server: `/etc/knowscroll/secrets/shared/agentmail.env`). One `POST /v0/inboxes/{inbox}/messages/send`, bounded response read, no retry, no redirects; a 2xx counts only with a `message_id`; delivery failure never changes the response to the requester (no address oracle); failures log one sanitised event without address, token, link or key. In production the mail sender must be AgentMail and fully configured — no fallback to a file sink. Workers never receive this key.

## Cutroom

See `cutroom-and-spend.md` (written with S2.4/S4.2) and `../carried-forward-facts.md` CF-60–CF-66. Cutroom is a separate HTTP service we do not modify.
