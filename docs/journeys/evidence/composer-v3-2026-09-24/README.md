# Composer v3, attention accounts and hypotheses — evidence, 2026-09-24

Issues [#133](https://github.com/KnowScroll/knowscroll/issues/133) (Composer) and
[#131](https://github.com/KnowScroll/knowscroll/issues/131) (hypotheses, uncertainty, decay), parent #72.
Decision: [ADR-0032](../../../decisions/0032-attention-hypotheses-and-semantic-composer.md); migration 0027.

## Outcome

The feed is chosen by `composer-semantic-v3`, a deterministic policy over the reader's own
recorded acts and the admitted substrate. It can continue a thread, go deeper, cross a sourced
bridge, meet a challenge, revisit, step outside, or fall back honestly. Every candidate it
considered is recorded with its family, gate, terms and evidence path. On Android the reader opens
**Why this appeared** and sees **What led here**: the act that led to the encounter and the
connection crossed. They can say **Less like this** (or **Wrong connection** on a connection),
which suppresses that route for them for 14 days and changes nothing shared. Attention accounts
and rule hypotheses are recomputed in the same transaction as the evidence, erased by Clear/Reset,
and exported. `composer-signals-v2` stays registered, immutable and selectable.

## Evidence levels

| Level | What ran | Result |
|---|---|---|
| Pure policy | `tests/composer-semantic.test.ts`, `tests/attention-hypotheses.test.ts` | 15 + 9 pass: cold start, continuity citing the act, challenge, deepen, rolling exploration floor, no adjacent repeat, "less like this", named gates, seen in strict tiers (never gated; revisits included), whole library before any repeat, no false end on a second pass, exhaustion only when everything is kept, fatigue/redundancy, saturation, replay; watching never anchors, separate-day/family anchoring, decay, correction contests a hypothesis, validator refuses character claims |
| Real PostgreSQL / HTTP | `tests/composer-semantic-http.test.ts` | 11 pass: the policy row equals the code's policy; recorded candidates and context; "why" equals the served reason, 404 for gated/foreign; a keep updates the model in the same request and the next encounter crosses the bridge citing that keep; an Ask opens a question hypothesis that cites it; "less like this" suppresses the route for that reader only (replay, 409, 422); the database refuses a self-contradicting v3 decision (missing context, undense ranks, gated rank, head not best without its own quota, later edits, deleted context); pause leaves the model untouched; Clear succeeds with a personal bridge; Clear and Reset erase everything after export carried it |
| Mutation checks | each applied alone, then reverted | dropping the keep-time refresh, the route suppression, the served-only "why" filter, the Clear erasure, the export, or the Ask-time refresh each turns a test red |
| Android units | `./gradlew :app:assembleDebug :app:lintDebug :app:testDebugUnitTest` | 107/107; new `WhyTest` 3 (strict parsing, wire shapes) and `ExplainWhyTest` 2 (path, corrections, sending guard); removing the corrected filter or the sending guard turns the sheet test red |
| Real emulator journey | `KS_SEMANTIC_JOURNEY=why scripts/android-semantic-journey.py` → `SemanticWhyJourneyTest`, emulator-5554 (API36), `.journey` app, disposable API/worker/PostgreSQL on 4333 | `OK (1 test)`; lineage below |
| Offline comparison | `./scripts/test.sh scripts/composer-compare.ts` | [comparison.md](comparison.md), below |
| Live provider | none | No model or provider call; MiniMax budget 0/40 |

## Real journey

[why-journey.json](why-journey.json), [receipt.json](receipt.json), [instrumentation.txt](instrumentation.txt).
The reader keeps a Scroll, asks for the next one, and opens **Why this appeared**:
"A sourced connection from “A rhythm the ocean keeps”: Tides is explained by Gravity", with
**What led here**: "You kept “A rhythm the ocean keeps”" and "Tides is explained by Gravity"
([why-path.png](why-path.png)). **Less like this** records the correction and says what it did;
the control is not offered again ([why-corrected.png](why-corrected.png)).

Checked in SQL after the run: the encounter was ranked by a `composer-semantic-v3` decision; the
evidence path cites a `keep` Ledger event that exists; exactly one `less_like_this` row for that
decision and Scroll; 4 attention accounts; all 6 shared bridges still admitted.

Failures on the way (kept): three runs failed on test defects before the pass. The journey
accepted only the immediately preceding keep, but a deepen cites the keep it grew from. One rerun
repeated that failure because the edit had not been applied. Then the matcher expected an exact
line, while the sheet prefixes each step with "· ". A diagnostic list added to the assertion showed
the path was rendered every time.

## Offline comparison (behaviour, not usefulness)

Three scripted readers walk the real 23-Scroll library for 20 deliberate steps under each policy,
each three times with fresh universes (v3's tie-break is salted by the universe), keeping only
Scrolls that match a fixed interest. Like both clients, the walker sends what it opened this trip
(`exclude`) and picks the first served Scroll it has not opened ([comparison.md](comparison.md) has
every sequence):

| Reader | Policy | Keeps in first 10 | All interest kept by step | Grounded in own acts | Ran out early |
|---|---|---|---|---|---|
| sky reader | v2 | 4 | — | 0 | no |
| sky reader | v3 | 8 | — | 0.92 (0.9–0.95) | no |
| living-systems reader | v2 | 3 | 17 | 0 | no |
| living-systems reader | v3 | 2.67 (2–3) | 14 | 0.28 (0.25–0.3) | no |
| watcher | v2 / v3 | 0 / 0 | — | 0 / 0 | no |

Both policies touched all four domains. For the sky reader, v3 finds their interest sooner and
explains most encounters by the reader's own acts. For the living-systems reader (6 Scrolls of
interest out of 23), v3 keeps slightly fewer in the first 10 steps (2.67 against 3) but still reaches
all of them sooner (step 14 against 17). Earlier runs, before the trip sent what it opened, scored
v3 higher on early keeps; this run is the one that matches the clients. None of this says whether
the encounters were *useful*; that needs owner review.

**What the comparison and the web journey changed.** The first v3 gated every seen Scroll, so a
reader who had seen everything reached "end of library" without keeping anything. That broke the
established contract (exhausted only when everything is kept) and failed 7 of 48 web-journey specs. A soft
seen penalty fixed the web journey, but the comparison then showed the living-systems reader
running out at step 13 in all three runs, with unseen Scrolls left: relevant *seen* Scrolls filled
the slate. The independent review then showed the remaining gap: a penalty that grows by 0.5 per
showing still let a twice-seen relevant Scroll beat a once-seen one, so a reader on a *second*
pass could still hit a false end. The shipped rule puts every showing (revisits included) in a
strict tier of 10, larger than any relevance difference, so the least-seen Scrolls always come
first (ADR-0032 §3). A second-pass walker test with several sourced connections fails on the old
penalty and passes on this one.

## Independent review and fix pass

A fresh-context review of `a71ec16` found one blocking and four important defects. Each was fixed
with a test that failed first:

- **B1, false end of library on a second pass.** Fixed with the strict seen tiers above; a second
  verification review then showed the remaining case (inside one tier, relevance could refill the
  slate with Scrolls this trip already opened, which the client skips). Both clients now send what the
  trip opened (`exclude`, at most 256 ids) and v3 gates those; a trip test over uniform, uneven and
  partial histories fails without the gate.
- **I1, Clear/Reset returned 500** once a v3 candidate named the reader's own bridge. v3 decision
  records are now erased before the semantic erase.
- **I2, v3 invariants checked only on insert.** They now also run on decision update and context
  delete, and a quota must name the head's own family.
- **I3, replay overclaimed; term sizes were code constants.** Every term size now lives in the
  immutable policy row, guarded by a drift test. The context records its composing clock, the
  hypothesis order is deterministic, and ADR-0032 §4 now states what the rows do and do not allow.
- **I4, the personal model moved while paused.** It no longer recomputes while paused; a correction
  made meanwhile counts after resume.

Also fixed from the review's minors: a correction repeated under a new key returns the same
receipt, and "why" reports corrections already made, so Android never offers them twice. Also:
transitions and feedback details are exported, sorting is locale-free, the core AGENTS doc is
current, and only the 50 most recent acts shape families, so composition stays bounded.

## Performance

v3 feed latency through the real app on a disposable database, 5 feeds per library size. Before:
one INSERT and one deferred invariant check per considered candidate, ~47 / ~80 / ~225 ms at 50 /
200 / 500 Scrolls. After: one `jsonb_to_recordset` INSERT and constraint triggers that fire only
for ranked rows (the only rows any invariant reads), ~10 / ~13 / ~20 ms.

## Limits

- Bench thresholds (half-life, anchoring, exploration every 3, 14-day suppression) are recorded with
  their policy versions, not tuned on real use.
- Direction hypotheses need voluntary acts on separate days from separate source families, so a
  one-session journey produces question hypotheses, not directions (covered by pure tests).
- The Scroll reader has the why sheet; the Reel reader and the web client show the served reason
  only.
- Emulator only (API36 debug); not a physical device.
