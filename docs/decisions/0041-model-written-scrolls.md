# ADR-0041 — Model-written Scrolls: fetched material, the model's own words, deterministic checks

Date: 2026-09-24. Status: accepted by the coordinator for [#162](https://github.com/KnowScroll/knowscroll/issues/162)
(model-written Scrolls), parent #134. Builds on ADR-0011/0033 (the MiniMax subscription route and its
quota preflight), ADR-0031 (sources, snapshots, and claims with verbatim quotes) and ADR-0032 (the
Composer). Owner decisions of 2026-09-24: a model writes each Scroll in its own words from material
fetched for it; the material is stored privately as what the facts are checked against; readers never
see a source; OpenStax is excluded (its pages say CC BY-NC-SA); live requests are the coordinator's.

## Context

The library is 23 hand-written editorial Scrolls (`content/editorial-scrolls.json`). Growing it by
hand does not scale, and a model writing from memory would present unsourced text as knowledge.
The substrate already knows how to hold sourced facts: a claim is supported by an exact quote on a
source snapshot whose text was hashed (ADR-0031). What is missing is a way for a model to write a
Scroll from a real page, and a deterministic gate that decides whether what it wrote may be admitted.

## Decision

1. **Material comes only from a fixed allowlist** (`material-hosts-v1`, pure, in
   `packages/core/src/scrolls/material.ts`) of US federal public-domain hosts: `science.nasa.gov`,
   `spaceplace.nasa.gov`, `www.nasa.gov` (family `fam.nasa`); `oceanservice.noaa.gov`, `www.noaa.gov`,
   `www.weather.gov` (`fam.noaa`; the National Weather Service is part of NOAA, so its pages are not
   independent evidence from NOAA's); `www.usgs.gov` (`fam.usgs`, new). `openstax.org` and its
   subdomains are refused by name. Only `https`, the default port and no credentials in the URL. A host matches only an allowlist entry of its own (review: a host named like an `Object.prototype` key is refused).
   Redirects are followed by hand, at most three, and every hop is checked again, so a redirect can
   never leave the allowlist. No cookie or credential is ever sent; at most 2 MB is read; only HTML
   is accepted. The policy defines its families the way the substrate does (`key`, `kind`,
   `description`); one the substrate already loaded must match it exactly.
   A page with too little visible text, or whose `<title>` says it was not found (some hosts serve a
   missing page as HTTP 200: NOAA's "Page Not Found: Error 404", seen in the live batch), is refused
   (`too_little_text`, `page_not_found`) before any request.
2. **The material is the page's visible text, stored privately and bound to a snapshot.** The visible
   text follows `scripts/substrate/snapshot_source.py`'s rules (skip `script`, `style`, `noscript`,
   `svg`, `template`, `head`; block elements separate words) and the one shared normalization, which
   moves to `packages/core/src/semantic/source-text.ts` (NFC, every whitespace run including no-break
   spaces to one space); `verify-substrate.ts` imports it and `snapshot_source.py` still mirrors it.
   The text is stored in `source_material`, one row per `source_snapshot`, with its retrieval time.
   The database proves the material is exactly its snapshot's text: its SHA-256 must equal the
   snapshot's content hash. A URL the substrate already holds reuses its current snapshot only when
   the fetched text hashes the same. Otherwise the item is refused `source_changed` before any
   request, because a changed page is a correction (ADR-0031), not a silent replacement. No API
   route reads `source_material`. It is shared library, not anyone's history: export, Clear, Reset
   and account deletion neither carry nor erase it.
3. **One bounded request** (`scroll-writing-prompt-v1`, pure, `packages/core/src/scrolls/writing.ts`).
   It offers the plan's existing concept codes (one to eight, each with its name and description)
   and the material. When the page has a `<main>` element long enough to quote from (at least the
   minimum page text), its text is offered; otherwise the whole page is. Either is a passage of the
   stored text. The material is trimmed at a word so that the whole request is at
   most 16,384 bytes. `max_tokens` is 4,096 and thinking is disabled. The request never names a
   reader or a universe.
4. **The reply is exactly one JSON object** (`scroll-reply-v1`): `{title, summary, beats[],
   concepts[{code, role: primary|secondary}], claims[{statement, truthState: "documented",
   concepts[{code, role: subject|object|mechanism|context}], quote, supportKind: supports|qualifies}]}`,
   bare or as the only content of one fenced block, after `<think>` blocks are dropped (as the
   inquiry path does). Anything else is refused as `shape` with `not_one_json_object`, `reply_keys`
   or `shape_invalid`.
5. **Deterministic checks decide admission** (`scroll-checks-v2`, pure; every number is a bench
   value). Text is normalized before it is measured or compared. Reason codes:
   - `quote_not_in_material`: a claim's quote is not an exact passage of the stored material;
   - `copied_passage`: the title, the summary or a beat shares a run of more than 8 consecutive
     words (case-folded, punctuation ignored) with the material. The claims are exempt: their
     quotes are verbatim by design, and their statements are the facts checked beside them;
   - `mentions_web_address`: the title, summary, a beat or a claim statement contains a URL, `www.`
     or a bare domain on a public suffix such as `.gov` (readers never see a source; claim statements
     reach readers as evidence). This is `scroll-checks-v2` (review, same day); the first live batch
     ran under v1, which checked only URLs and `www.` in the prose;
   - `title_length` (8–90 characters), `summary_length` (20–240), `beat_count` (3–7),
     `beat_length` (40–700 each), `claim_count` (2–6), `statement_length` (12–400),
     `quote_length` (12–400);
   - `concept_unknown`: a code (the Scroll's or a claim's) is not in the substrate;
   - `concept_not_offered`: one of the Scroll's own concepts was not offered;
   - `primary_not_one`: the Scroll does not have exactly one primary concept;
   - `duplicate_concept`: the Scroll names a concept twice, or a claim names a concept twice in
     the same role;
   - `claim_concept_not_offered`: a claim names no offered concept;
   - `no_supporting_claim`: no claim's quote `supports` it (a `qualifies` quote alone does not
     make a claim supported, `claim_is_supported`).
   A rule change is a new checks version, recorded with every decision.

   A refused quote is diagnosed (`quote-diagnosis-v1`, #181): a refusal keeps no model text, so the
   first live batch's 13 `quote_not_in_material` refusals could not be read back. After the reason
   codes, the record lists one code per quote that is not a passage of the material, in claim order:
   `quote:typography` (a passage once curly quotes, apostrophes, dashes and the ellipsis are folded to
   ASCII on both sides), `quote:case` (once case is folded too), `quote:words` (its words are a run of
   the material's, punctuation and sentence breaks aside), `quote:partial` (at least half its words
   are) or `quote:absent`. A diagnosis is a code, never text, and never changes a verdict; its version
   is recorded with the others. Whether a later checks version should match after folding (storing
   the page's own passage) waits for a live batch's diagnoses.
6. **Admission is one transaction under the substrate lock** (`packages/db/src/semantic/model-scrolls.ts`):
   - the family (inserted if absent);
   - the source, inserted if absent under the key `<nasa|noaa|usgs>.page-<16 hex of the URL's
     SHA-256>`, with the page's title and the publisher, internal only;
   - its snapshot (revision 1, the retrieval day, the content hash) and the material;
   - the claims, keyed `clm.model.<16 hex>.<n>`, `created_by = 'model_proposal'`, `documented`, with
     their concept links and the normalized quote as support on the snapshot;
   - the Scroll asset: the body is the beats joined by blank lines (the readers already render
     paragraphs), `editorial_order` comes after the library's last, and the source title
     ("Publisher · page title") and URL are internal only;
   - its `asset_concept` and `asset_claim` rows, so the Composer serves it like any other Scroll;
   - a `scroll_writing` record: the material and request hashes, versions, transport, model, input
     bytes, usage and status.

   The pair of material and request hashes is the identity. A pair already decided is never sent
   again, and admitting it again returns the first decision. A refused reply records a
   `scroll_writing` row with its reason codes (and its quotes' diagnoses) only: no model text, no
   claim and no material. The
   new claims carry no substrate relation, so no admitted bridge needs revalidation.
7. **Transports.** `fixture` is deterministic and labelled, for tests and journeys only. `minimax` is
   the existing worker-only MiniMax transport, reused unchanged: MiniMax-M3 through the fixed
   subscription route, an `sk-cp-` key from the process environment only, the quota preflight as
   its readiness (at least 25% of the interval and weekly allowance), exactly the given bytes sent
   once with no redirect and no retry, and only text blocks read. The per-item steps (fetch, write,
   check, admit) are `apps/worker/src/scrolls/write-scroll.ts`. A caller supplies the transport and
   a `beforeSend` gate, so a worker loop with an operator-installed route (#164) calls the same
   functions.
8. **The operator CLI** (`scripts/scrolls/write-scrolls.ts`) reads a plan file: a JSON array of
   `{url, conceptCodes}`. Before any connection, it refuses a database whose name does not begin
   `knowscroll_test_` or `knowscroll_demo_`. It takes `--transport fixture|minimax`. Without
   `--apply` it only fetches and builds, and reports sizes, hashes and earlier decisions; nothing is
   sent or written. With `minimax` it:
   - refuses a key that does not begin `sk-cp-`;
   - before each request, runs the quota preflight;
   - then, under a file lock, checks the session ledger (`$KS_DEV_ROOT/minimax-answer-session-ledger.json`:
     `sessionCap`, `used`, `runs`; a missing ledger is refused) and counts the request before
     sending it;
   - stops at the first refusal of the route: the preflight, the cap, a provider error or a lost
     transport.
   A refused reply is not a refusal of the route; the batch continues. The receipt
   (`artifacts/scroll-writing/`, ignored) holds counts, statuses, reason codes, hashes, input bytes
   and token usage: never a prompt, an output or a key.
9. **Truth state.** The Scroll is stored `documented`, like the editorial library, because the wire
   contract (`ScrollAsset`, Trace revisit, Ask) admits only documented Scrolls. What is proven is
   narrower than for a hand-checked Scroll: every claim is quoted verbatim from the stored material,
   and the prose is not copied; the prose's other sentences are the model's and are not checked one
   by one. Presenting these Scrolls as `synthesis` with a generated label (product definition §12)
   needs a contract change and is left to a later slice.
10. **Not inquiry evidence** (#181, review of #178). A model-written Scroll's claims (`created_by =
    'model_proposal'`) are the model's statements, checked only in that each quote is on the page.
    Background inquiries (ADR-0038) neither offer them as evidence nor count a claim of theirs that
    names two places as a reason to ask about the pair (`readInquiryInputs` leaves them out), so a
    model-found connection never rests on another model's prose. Admitting them after a review is a
    later decision.

## Not in this version

The worker loop and its operator-installed route (#164). A `synthesis` presentation. Re-snapshotting
a page that changed (a correction). Checking every sentence of the prose against a claim. Model text
of any kind in Git: model-written Scrolls live only in the database.

## Consequences

Migration 0035 (`source_material` with its hash guard; `scroll_writing` with admitted/refused shape
checks and a guard that an admitted writing names stored material of the same hash; both immutable).
Pure: `packages/core/src/semantic/source-text.ts`, `packages/core/src/scrolls/material.ts`,
`packages/core/src/scrolls/writing.ts`, and `packages/core/src/reasoning/wire.ts` (the canonical
request bytes and the one-object reply rule, now shared by the Ask, inquiry and Scroll paths).
Database: `packages/db/src/semantic/model-scrolls.ts`. Worker: `apps/worker/src/scrolls/fetch-material.ts`,
`apps/worker/src/scrolls/write-scroll.ts`, `apps/worker/src/providers/scroll-fixture.ts`. Operator:
`scripts/scrolls/write-scrolls.ts`, `scripts/lib/session-ledger.ts`.

## Verification

Pure tests for every check, each with a refused case, and for the request bound and reply shape;
fetch tests with a mocked network (the allowlist, OpenStax, redirects, no cookies, size); DB/API
tests (fixture transport): admission and its lineage, idempotence, a refused reply storing no text,
the database's hash guard, `GET /v1/feed` serving the admitted Scroll, and no API response or export
carrying the material; CLI tests: the database guard, the key prefix, the ledger lock and cap, and
stopping at the first route refusal; a model-written Scroll's claims never offered to an inquiry
(§10). The live batch is the coordinator's.
