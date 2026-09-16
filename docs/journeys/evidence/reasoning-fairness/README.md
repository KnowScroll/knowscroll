# Bounded fairness policy/model — issue #54

Date: September 16, 2026. [Issue #54](https://github.com/KnowScroll/knowscroll/issues/54), parent [#7](https://github.com/KnowScroll/knowscroll/issues/7), [ADR-0013](../../../decisions/0013-bounded-reasoning-fairness.md), [model guide](../../../operations/reasoning-fairness.md).

## Outcome

The accepted contract has an executable deterministic model with 12 dynamic scenarios and 23 focused counterexample tests. [The receipt](fairness.json) pins source revision/hashes, complete per-scenario policy parameters, actual event sequences, state observations and normalized service totals. Its capture command runs the model twice and requires byte-identical output. Source revisions remain the revisions observed at execution, not a later documentation commit.

| Scenario | Observation |
|---|---|
| Steady load | Eight separate arrival batches drain: 40 admissions across five classes |
| Saturated classes, unequal costs | First complete traversal spends 500/600/400/300/200 service units; request counts differ |
| Large active universe versus sparse work | A sparse maximum-size request is the third admission, before the 100-job cheap flood drains |
| Sustained unequal universe costs | Over 80 admissions, C40/C100 queues receive 2,280/2,300 units; largest prefix lead is 100 units, within the asserted 200-unit bound |
| Borrowing then renewed demand | A sole borrower uses all ten requested admission opportunities; later interactive demand runs in the next outer visit while borrower backlog remains |
| Idle return | 100 empty polls earn no positive credit; returning maximum-size work runs |
| Impossible and maximum requests | C101 is explicitly rejected without a reservation; C100 in the same universe runs |
| Unknown call, overload and deadline | Consumed/unknown state survives rate rollover and snapshot restart; held remote capacity prevents admission; blocked work expires; terminal evidence frees its slot while unknown budget stays held |
| Estimate error / overage | C20 → actual C150 posts the full correction, preserves negative debt while idle, pauses admission and makes an exact receipt retry a no-op |
| Refund versus rate window | C100 → actual C10 does not refill the original rate window; a later explicit rollover permits new work |
| Restart and receipt replay | Mid-visit JSON restoration yields the same continuation; a repeated cumulative receipt posts no second correction |
| Bounded blocked scan | Two-probe ticks eventually reach the ready universe beyond eight blocked universes; only that request receives a reservation |

These are observed finite fixtures, not universal scheduling bounds. The model has one fixture-wide rate clock and trusted synthetic Candidates/Receipts. It does not authenticate receipts, issue transport authority, emulate independent provider windows or prove database durability/concurrency. Retained accounting scans are simulation work, not a claim of constant-time scheduling.

## Checks and source

[Execution metadata](execution.json) records local regression source `b57fa5a`. The later source-stamped model receipt additionally pins the accepted ADR and capture script. CI repeats the complete checks at the integration PR head before merge.

| Check | Result |
|---|---|
| Typecheck | [Passed](typecheck.txt) |
| Backend tests | [172 passed: 12 baseline + 160 additional](backend-tests.txt), including 23 fairness tests |
| Existing journey verifier rejection cases | [2 passed](verifier-negative.txt) |
| J001 | [Passed](J001.txt) |
| J002 | [Passed](J002.txt) |
| J003 | [Passed](J003.txt) |
| J004 and source/state verifier | [13 scenarios / 4 local fixture requests passed](J004.txt) |
| Independent SIGTERM/SIGINT cleanup | [Passed](cleanup.txt) |
| Deterministic model | [12 traces, repeated byte-identical execution](fairness.json) |

Reproduce with the commands in the model guide. The focused tests also run through `pnpm test`; the source-stamped model command runs in backend CI. Historical J004 process receipts remain in the original J004 evidence; the logs here record this slice's fresh regression run.

## Independent review and corrections

Two workers used `gpt-5.6-terra`. The model worker supplied the initial model and focused tests. The reviewer wrote independent counterexamples and reviewed the final implementation/contract. Sol was unavailable due to its model usage limit. The coordinator owned ADR decisions, the real dynamic scenario runner, source-stamped evidence and final nested-turn/accounting hardening.

Review found and corrected a full-ring cursor reset that repeatedly selected one busy universe, exact not_sent receipt replay ordering, positive idle-credit accumulation, mutable policy-basis reuse, deadlines hidden by exhausted capacity and missing original rate-window identity. The coordinator preserved unfinished inner turns across outer spend limits, made the clock monotonic, froze closed-state contradictions and recorded discarded capped refunds. A corrected refund counterexample verifies a new inner turn after its own cap and persistence of an unfinished inner turn across a class boundary. Independent final review accepted model source `b57fa5a` with the stated fixture limits.

## Next gate

[#55](https://github.com/KnowScroll/knowscroll/issues/55) implements the durable SQL scheduler, atomic claim/reservation seam and concurrent/restart/privacy evidence. No production module, migration, normal owner database, Android surface or provider dispatch changed here. Product reasoning remains disabled. #7 remains open, with context/proposal validation and lifecycle work still required.
