# MiniMax transport

The adapter sends one bounded Anthropic-compatible messages request per attempt and reads one reply.
It has no tools, no retries and no second request: the attempt ledger, not the transport, decides
whether anything is ever sent again.

- **Models:** `MiniMax-M3.1-Flash` (Scroll writing, D-031), `MiniMax-M3`, `MiniMax-M2.7`,
  `MiniMax-M2.7-highspeed`. A name outside the list is served by another model without an error, so
  every reply's `model` must equal the configured one; a mismatch is a conclusive `MODEL_MISMATCH`
  failure that still records the reported usage.
- **Thinking:** `MiniMax-M3.1-Flash` is sent `thinking: {type: "adaptive"}`; it refuses `disabled`
  (HTTP 400, code 2013). The other models are sent `disabled`. A role's `effort` becomes
  `output_config.effort` for the adaptive model, `low` when the role names none: left at the
  provider default, thinking can use the whole token budget (a reply that thinks for 15,000 tokens
  and never answers was observed), while `medium` uses a few thousand and `low` tens. Thinking tokens count against `max_tokens` and are recorded as
  reasoning tokens (`output_tokens_details.thinking_tokens`).
- **Answer:** the joined `text` blocks. `thinking` blocks and a leading `<think>…</think>` are
  dropped, and only there. A reply cut off while thinking is a truncated answer, not an unreadable one.
- **Unreadable replies** (not JSON, no text) carry the bounded raw body so production diagnostics can
  show what arrived; the ledger redacts and bounds it again before storing it.
- **Quota:** one observation before every attempt (`GET /v1/token_plan/remains`), judged against a
  floor (`KS_MINIMAX_QUOTA_FLOOR_PERCENT`).

The structured-output carriers that earlier recipes used (`submit_output`, a JSON string inside a
tool call) are gone. A model that writes a long nested JSON document inside an escaped string loses
track of quotes and brackets; plain text JSON from a flat, forgiving authoring shape worked
(`modules/content/production/README.md`).
