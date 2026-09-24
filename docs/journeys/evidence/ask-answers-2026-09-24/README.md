# Ask answers — evidence, 2026-09-24 (#132, ADR-0033)

Every file here is content-free: statuses, reason codes, counts, token usage and SHA-256 hashes.
No question text beyond the fixed labels below, no answer, no quote, no key. The live answer text
existed only in disposable databases that were dropped, and on the emulator screen.

## What was proven

| Proof | How | Result |
| --- | --- | --- |
| Core rules | `tests/ask-answer-core.test.ts` | exact request bytes; validator accepts verbatim quotes, refuses invented quotes, oversize, reader characterisation, bad shape (with sub-codes) |
| Answer lifecycle | `tests/ask-answers.test.ts` (11) | fresh authority from the original session; paused/other session/stale epoch refused; one request per Ask; cancel; Clear/Reset erase; export |
| Crash and unknown outcome | `tests/ask-answers-crash.test.ts` | worker killed mid-dispatch → unknown outcome holds its remote slot, is never retried, answer fails honestly |
| MiniMax transport | `tests/minimax-answer-transport.test.ts` (4) | subscription key only, no redirects, quota preflight before scheduling, minimal receipt |
| Backend suite | `scripts/test.sh` | 802 pass, 0 fail (plus 13 baseline) |
| Android units | Gradle unit tests | 124 pass (Answers, AskPresentation, AskSheet) |
| Emulator, fixture | `KS_SEMANTIC_JOURNEY=ask` | answered on screen; DB lineage: 1 completed job, 1 dispatch, 1 Ask event; preview restored and verified |
| Emulator, live | `KS_SEMANTIC_JOURNEY=ask KS_ASK_TRANSPORT=minimax` | answered with 3 verbatim quotes on screen (`android-live-v2-*.json`); lineage verified; preview restored |

## Live measurements (MiniMax-M3, subscription route, bounded)

Owner authorization: subscription `sk-cp-` key only, quota preflight ≥25% interval and weekly
before each request, ≤40 requests this session, ≤16 KB request, ≤4,096 output tokens (the route
uses 1,024), disposable databases and the separate `.journey` app only.

| Run | Validator | Question | Outcome |
| --- | --- | --- | --- |
| `live-pair-v1.json` | v1 | "why two high tides" / "who first measured tides" | answered (2 quotes) / not_in_source |
| Android live #1, #2 | v1 | "Does this Scroll say anything about tides?" | rejected, `shape_invalid` (before sub-codes existed) |
| Android live #3 | v1 | same | answered |
| `live-sample-v1.json` | v1 | same, ×5 | 5 × rejected `shape_invalid` + `shape_basis_item` |
| `live-sample-v2.json` | v2 | same, ×5 | 5 × answered, 3–4 verified quotes each |
| `android-live-v2-*.json` | v2 | same, on the emulator | answered, 3 quotes |

Total provider requests: 16 of the 40 authorized (session ledger under `$KS_DEV_ROOT`).

**Finding and fix.** v1 demanded each basis item be exactly `{"quote": string}`; for a yes/no
question MiniMax-M3 consistently wrapped quotes differently, so every reply was rejected even
though the quotes were checkable. The reader saw the honest "didn't hold up" message — correct,
but useless. v2 (ADR-0033 amendment) projects each item to its quote (bare string or `quote`
field), drops any other key unread, and still checks every quote word for word. Same question,
same model: 0/5 → 5/5.

## Limits

- One Scroll ("A rhythm the ocean keeps") and three questions; not a quality benchmark.
- MiniMax reports `input_tokens: 1` on this route; input usage is not trustworthy from the
  provider and the product's own byte bound (16 KB) is the enforced limit.
- Debug API36 emulator, not a physical device.
- Answers are Scroll-only; Reels have no Ask surface.
