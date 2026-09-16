# v1 release contract

Status: accepted owner scope, 2026-09-16; implementation and release acceptance remain incomplete. Release tracker: [#72](https://github.com/KnowScroll/knowscroll/issues/72).

## Owner decision

**v1 is the entire documented user experience with the full polished UI, integrated with the real video harness and tested as one working product.** Owner Alpha is an intermediate delivery checkpoint. Completing a backend foundation, an isolated feature, a prototype or Owner Alpha does not complete v1.

This decision supersedes the narrower suggestion that v1 could mean only Owner Alpha with video generation and social experience deferred. The existing [product definition](definition.md), including journeys A–I and the three delivery phases, supplies the functional scope. Bootstrap, Owner Alpha, Living Worlds and Worlds Collide remain useful sequencing milestones; none is an automatic exemption from the full-experience v1 gate. The earlier rough completion estimate for Owner Alpha is not a completion estimate for this larger v1.

Product laws, accepted ADRs and [visual/interaction direction](design-direction.md) remain authoritative. Reel and Scroll are the only consumption objects. KnowScroll owns evidence, meaning and publication; [Cutroom stays a separate HTTP service](../decisions/0007-cutroom-separate-http-service.md). Contract/schema names containing `v1` do not imply that the product release is complete.

## Required product coverage

| Release area | Required integrated result | Existing ownership |
|---|---|---|
| Identity and privacy | Real ownership and authentication; private defaults; correction, pause, export, clear/reset/delete and recovery with honest consequences and cross-device isolation | #2, #4 |
| Complete UI and navigation | Coherent universe/world entry and exact return, cosmic navigation, vertical discovery and horizontal continuation, Reel/Scroll transitions, interactive blocks, Ask, Relics/Traces, sources, explanations and Chronicle; no dead-end or placeholder required screens | #3 |
| Discovery and reasoning | Useful sourced inventory, retrieval/ranking/diversity, continuous branches, authorized questions and results, bounded execution and recovery; behavior is evidence rather than proof of belief | #5, #7, #8, #66 |
| Personal and living worlds | Evidence-backed semantic bridges, revisable hypotheses, explained geography, world changes while away, rooms, bounded inhabitants and typed Relics, with source lineage and safe execution | #6, #10 |
| Video and generated encounters | Real Cutroom generation integrated through validated import, truth/continuity checks, eligible inventory, mobile playback and continuing branches | #8, #9 |
| Social experience | Selected shared projections, visits, co-voyage/shared rooms and revocable Blend, with independent private universes and permission boundaries | #11 |
| Acceptance and operations | Joined runtime proof, owner experience review, release build/deployment/recovery evidence and explicit defect/limitation disposition | #12 |

The product definition remains the detailed checklist; this table does not narrow it. Native Android remains the chosen first implementation. Full v1 must demonstrate both the mobile and desktop release UI against the product definition's §9.5 interaction contracts, with one coherent experience across them. Implementation order does not waive either surface; excluding one requires a later explicit owner scope reduction recorded here and in #72.

## Full UI means a finished experience

Every required journey must be usable through the actual release UI and connected backend, following the selected Cosmos visual direction and Living Observatory interaction behavior. Source-linked explanations and truth labels must appear where the person needs them. Mockups, scripted controls and standalone backend endpoints are supporting work, not completed UI.

Verify loading, empty, error, unavailable-network, retry/cancellation and restoration states alongside the happy path. Check compact and large layouts, touch/gesture conflicts, back/rotation/process death, accessibility and reduced motion, playback lifecycle, frame timing and media memory. Owner visual and interaction acceptance is separate from automated checks. Do not hide required unfinished capabilities behind a disabled button and call the UI complete.

## Real video-harness integration gate

The [Cutroom integration issue #9](https://github.com/KnowScroll/knowscroll/issues/9) must prove the actual joined path:

`user intent → authorized bounded job → real Cutroom HTTP run → result reconciliation → verified asset import → evidence/truth/continuity gates → eligible inventory → playable Reel → branch/Scroll/world continuation`

Pin and verify the deployed contract and host/transport. Prove idempotency and conflict handling, ambiguous submission lookup, polling/resumption, cancellation, restart, failures, budget/cost reconciliation and asset lifetime. Import actual media into KnowScroll-controlled storage; an engine-host filesystem path is not a playable mobile URL. Apply the specified Visual Witness and Encounter Reconciler gates, provenance and generated/simulation labels before publication. Generation remains queued and replaceable outside the swipe path.

Fixtures are valid for fault coverage but cannot establish live Cutroom integration, real media delivery or acceptable viewing quality. This scope decision does not change provider budgets or authorize unlimited paid calls; bounded live verification needs the applicable explicit experiment authorization.

## End-to-end acceptance

All nine [core product journeys](definition.md#10-core-user-journeys) must have revision-bound receipts using the real joined components and release UI:

- A: replace a doomscroll reflex with effortless discovery and a useful trace.
- B: follow a continuous branch, interact, disagree, enter its world and retain a Relic.
- C: ask for a continuing generated series, inspect assumptions and watch truth-labelled results and alternatives.
- D: discover an emerging world and inspect why it appeared.
- E: return to a source-backed world change produced by bounded work while away.
- F: visit a friend's selected projection and use a temporary Blend without leaking or merging private state.
- G: inspect and correct a wrong connection through evidence-safe controls.
- H: revisit a prediction and its evidence without the system declaring a psychological truth.
- I: pause, export, clear/reset or leave with correct personal/shared ownership consequences.

For each journey, #12 records the intended outcome, UI entry/return, exact build/revisions, environment, real versus simulated components, expected and observed runtime path, sources/causal lineage, failure/recovery checks, owner observations and remaining defects. Combine contract/unit, real PostgreSQL/API/worker integration, device/emulator UI, live provider/video integration and owner-experience evidence. Verify authorization, privacy, retries, process restarts, cancellation, deadlines, stale/late results and deletion across component boundaries. Destructive checks use disposable identities; never erase owner history to obtain a passing receipt.

“All tested” means evidence covering every required journey and material failure boundary, not a claim that all possible behavior has been exhaustively tested. Green CI and a test count alone do not establish full UX, live-provider quality, performance or usefulness. There must be no untested required journey or unresolved release-blocking defect. Record and justify any non-blocking limitations, including the supported release environment and operational scale; release/deployment authority remains governed by the existing workflow.

## Completion and tracking rule

Keep #72 open until every release area above and journeys A–I have implementation, joined-runtime evidence and owner acceptance linked. Component issues retain their detailed acceptance; a completed child prerequisite does not close a broad epic. Track capability coverage, remaining dependencies and blockers rather than calculating v1 completion from closed issue counts. Any future scope reduction must be an explicit owner decision recorded here and in #72.

Current foundation evidence remains in [PROJECT-STATE](../PROJECT-STATE.md). #66 is the next bounded reasoning dependency, not the last v1 task. Writing this contract changes release scope and coordination only; it implements no UI, video integration or product capability.
