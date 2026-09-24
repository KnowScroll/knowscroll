# Ask answers — evidence, 2026-09-24 (#132, ADR-0033)

Committed files are content-free: statuses, reason codes, counts, token usage and SHA-256 hashes,
except the two fixture screenshots, which show the labelled fixture reply. Live answer text is not
in Git. It existed in the disposable databases (dropped), on the emulator screen, and in the
git-ignored local files the runners write for the operator (`artifacts/live-answers/*.local.json`
with question and answer; live screenshots under `artifacts/semantic-journey/ask/`).

Receipts come from clean commits after two fresh-context reviews of PR #143: the fixture emulator
run from `ffac2c6` (the final head), the live runs from `d719b2e`. The only change between those two
lets through a phrase the answer repeats verbatim from the Scroll (see below), so anything accepted
at `d719b2e` is accepted now. The two labelled v1 runs are history.

## What was proven

| Proof | How | Result |
| --- | --- | --- |
| Core rules | `tests/ask-answer-core.test.ts` (10) | exact request bytes; verbatim quotes; invented, all-space or near-empty quotes refused; empty limits and NUL refused; statements about the reader refused ("you are curious", "you're the kind who…", "your curiosity"), while hypothetical second person ("if you are a sailor") and the Scroll's own words to its reader pass; every sentence of the 23 editorial Scrolls passes; bad shapes with sub-codes |
| Answer lifecycle | `tests/ask-answers.test.ts` (12) | fresh authority from the original session; paused, other session and a stale epoch refused before anything is queued; one request per Ask; cancel (malformed id is 400); Clear/Reset erase; export |
| Nothing stuck after admission | `tests/ask-answers-recovery.test.ts` (3), one remote slot; `tests/ask-answers-signed-out.test.ts` (1) | a worker stopping before dispatch gives the attempt back (all reservations released, answer `failed`/`not_sent`); a worker dying after admission is closed by the recovery sweep once its lease expires (`worker_stopped`); a reply that lands after the lease expired is closed as `apply_failed`; a signed-out reader's abandoned Job waits for its deadline without stopping the sweep, then expires; the next Ask then proceeds |
| Crash mid-call | `tests/ask-answers-crash.test.ts` | worker killed after committing its dispatch; its replacement never sends again (1 attempt, 1 dispatch); the sweep closes it `failed`/`outcome_unknown`; accounting stays `unknown` and keeps its remote slot |
| MiniMax transport | `tests/minimax-answer-transport.test.ts` (7) | subscription key only, fixed URL, no redirects; quota preflight bounded to 10 s and asked at most every 30 s while work waits; cache usage recorded like the certified route; 502/504 unconfirmed |
| Android | 130 unit tests + lint | Ask sheet states; after an unclear failure "Get an answer" is offered again with the saved key; the question is sent literally; disclosure copy |
| Emulator, fixture | `KS_SEMANTIC_JOURNEY=ask` (`android-fixture-*`) | answered on screen; SQL lineage: 1 completed Job, 1 dispatch, 1 Ask event; preview restored and verified |
| Emulator, live | `… KS_ASK_TRANSPORT=minimax` (`android-live-*`) | answered with 3 verbatim quotes on screen; same lineage; 1 provider request; preview restored and verified |

## Live measurements (MiniMax-M3, subscription route, bounded)

Owner authorization: subscription `sk-cp-` key only, quota preflight ≥25% interval and weekly
before each request, ≤40 requests this session, ≤16 KB request, ≤4,096 output tokens (the route
uses 1,024), disposable databases and the separate `.journey` app only.

| Run | Code | Question | Outcome |
| --- | --- | --- | --- |
| `live-pair-v1.json` | validator v1, before review | "why two high tides" / "who first measured tides" | answered (2 quotes) / not_in_source |
| (Android, not kept) ×2 | v1 | "Does this Scroll say anything about tides?" | rejected `shape_invalid` (before sub-codes) |
| (Android, not kept) | v1 | same | answered |
| `live-sample-v1.json` | v1 | same, ×5 | 5 × rejected `shape_invalid` + `shape_basis_item` |
| (CLI ×5, Android ×1, not kept) | v2, uncommitted working tree | same | 6 × answered |
| (CLI ×5, Android ×1, not kept) | `5ad8db7` | same | 6 × answered |
| `live-sample-v2.json` | `d719b2e` | same, ×5 | 5 × answered, 3 verified quotes each |
| `android-live-*` | `d719b2e` | same, on the emulator | answered, 3 quotes |

Total provider requests: 28 of the 40 authorized (session ledger under `$KS_DEV_ROOT`).

**Finding and fix.** v1 demanded each basis item be exactly `{"quote": string}`. For a yes/no
question, MiniMax-M3 consistently wrapped quotes differently, so every reply was rejected even
though its quotes were checkable. The reader saw the honest "didn't hold up" message: correct, but
useless. v2 (ADR-0033 amendment) projects each item to its quote (a bare string or a `quote` field),
drops any other key unread, and still checks every quote word for word. On the same question and
model, 0/5 became 5/5.

## Limits

- One Scroll ("A rhythm the ocean keeps") and three questions; this is not a quality benchmark.
- MiniMax reports `input_tokens` as 1 on some repeats and 319 on others: prompt caching on the
  provider side. The cache counters are now recorded, and the product's 16 KB byte bound is the
  enforced input limit.
- Debug API36 emulator, not a physical device.
- Answers are Scroll-only; Reels have no Ask surface.
