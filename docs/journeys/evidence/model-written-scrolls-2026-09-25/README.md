# #162 model-written Scrolls — live batch and emulator evidence, 2026-09-25

ADR-0041. A disposable stack (`scripts/android-hands-on.py up`, database
`knowscroll_test_hands_ff16f8644a16`, dropped afterwards), the test app
`com.knowscroll.mobile.journeytest` on the API36 emulator, and the owner's preview unchanged
(`preview-untouched.json`). **No model text is in this directory or anywhere in Git**: the Scrolls
lived only in the dropped database, and screenshots showing them stay in the ignored `artifacts/`.

## The live batch (coordinator)

1. **Plan.** 41 allowlisted NASA and NOAA pages, each mapped to existing concept codes.
2. **Dry run** (`--transport fixture`, no `--apply`: fetch and build only, nothing sent).
   - 37 were ready.
   - 2 were refused `source_changed`: pages the editorial substrate holds whose text has changed
     since it was snapshotted. That is a correction, not a silent replacement.
   - 2 were refused `http_status`: 403 from www.noaa.gov and www.weather.gov.
   - 2 more NOAA pages answered HTTP 200 with "Page Not Found: Error 404". They were removed by hand,
     and the fetcher now refuses such pages itself (`page_not_found`, `12c6786`).
3. **Live run**: `write-scrolls.ts --transport minimax --apply` on the 35 remaining pages.
   - Route: MiniMax-M3, subscription route, `sk-cp-` key from the environment only.
   - Before each request: a quota preflight, and a file-locked ledger check.
   - Result (`live-batch-receipt.json`):

| Count | |
| --- | --- |
| Requests sent | 35 (session ledger 35 → 70 of 190) |
| Admitted | 18 |
| Refused by `scroll-checks-v1` | 17 |
| Refusal reasons (a Scroll can have several) | `quote_not_in_material` 13, `copied_passage` 4, `shape_invalid` 3, `beat_count` 1 |
| Tokens (in / out) | 52,283 / 26,869 |
| Largest request | 15,825 bytes (bound 16,384) |

The admitted Scrolls' primary concepts were Tides (9), the Sun (3), the greenhouse effect (2),
Earth's surface temperature (2) and gravity (2).

The receipt holds statuses, reason codes, hashes, sizes and token usage, and never a prompt, an
output or a key.

## On the emulator (by hand)

1. "Show me something", then "keep going" through the Cable: model-written Scrolls were served among
   the editorial ones (4 of the first 8 exposures). Each rendered as "SCROLL · DOCUMENTED" with its
   title, summary and paragraphs.
2. No source name, publisher, URL or count appeared anywhere, including at the end of the Scroll. A
   text dump of each screen was checked for "source", NASA, NOAA, http, www and .gov: none.
3. Why this appeared: reason, truth state, origin, what led here; no source.
4. Kept one: the Trace row exists and the Keep tab lists it.
5. Force-stopped and relaunched: the same model-written Scroll was restored on screen.

## Limits

- The prose beyond the quoted claims is the model's and is not checked sentence by sentence (ADR-0041 §9).
- Stored as `documented` because the wire contract admits only that; a `synthesis` label needs a
  contract change.
- About half the requests were refused, mostly for a quote that is not an exact passage of the page.
  The refusals keep no text, so the cause cannot be read from them. Many of the pages mix curly and
  straight apostrophes, which a model tends to normalize. Follow-up: #181.
- Debug API36 emulator, not a physical device.
