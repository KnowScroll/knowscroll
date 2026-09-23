# Next session: complete the personal intelligence loop and connect it to Android

Owner direction, September 24, 2026. Parent [#72](https://github.com/KnowScroll/knowscroll/issues/72),
[Project 1](https://github.com/orgs/KnowScroll/projects/1). This is an implementation mandate for
all six phases below, with verification throughout, not a request for another audit or plan.
The owner likes PR130's Android result. Preserve that direction and implementation.

## Copyable next-session prompt

Continue KnowScroll from this complete handoff. Build all six personal delivery phases through
maintainable implementation, actual runtime verification, Android integration and reviewable PRs.
Do not stop after scaffolding, a design document, one attractive preview, or one phase. Work in
small dependency-aware vertical slices, proving the behavior as each slice is built. When an
external gate blocks one path, advance independent work and record exactly what is blocked.

The intended product loop is:

`sourced encounter → recorded evidence → revisable semantic connection → authorized reasoning
→ validated result → useful recommendation/branch → explained world change → Android encounter
and exact return → correction and re-evaluation`

Reel and Scroll remain the only consumption objects. The experience must stay effortless; do not
replace it with dashboards, questionnaires or asserted psychological truths. Behavior is evidence,
never proof of belief, identity, mastery or learning. Models propose; deterministic code validates
and applies. A keyword match, confidence number, scheduled counter increment or decorative planet
does not establish a meaningful conceptual bridge or world evolution.

### Start with verified state

- Main repository: `/Volumes/Mrigesh SSD/knowscroll-product`. Do not assume its current checkout is
  main; at this handoff it was still on the older `codex/72-ui-experience-audit` branch.
- Preserved Android worktree: `/Volumes/Mrigesh SSD/knowscroll-worktrees/72-android-living-universe`.
  PR130 is merged as `f89e6257c8120b3b2e6aad3397dbd7be9c52530b`; final implementation head was
  `136dbd8ba5a5ad72cfa2969e3e317fba5f23707d`, with all four exact-head CI checks passed. Recheck GitHub.
- This handoff is maintained in `/Volumes/Mrigesh SSD/knowscroll-worktrees/72-core-delivery-handoff`,
  branch `codex/72-core-delivery-handoff`. Check its PR status. Read this file even if that docs PR
  is not merged; start implementation from verified current main in a new named SSD worktree.
  Preserve all other work; do not reset, force-push, overwrite or remove an active lane.
- Read root/scoped AGENTS, CHECKPOINT, README, PROJECT-STATE, system-navigation, component map,
  product definition/current v1 scope, accepted ADRs and relevant target core-engine chapters.
  Then read #72, the six phase issues, their current comments and Project 1. Historical checkpoint
  subsections and component-map status strings can be stale; verify source and current issue truth.
- For Android visual work, inspect the six references beside
  `/Volumes/Mrigesh SSD/knowscroll-product/artifacts/android-living/next-session/START.md` and
  their `references.json`, plus `docs/design/2026-09-23-android-direct-atlas.md` and its evidence.
  Read actual styles/behavior of `/Volumes/Mrigesh SSD/Knowscroll-v2/docs/design/2026-09-08-cosmos.html`
  and the Living Atlas reference; retain the approved poster Scroll direction. Images5/6 are
  historical problems, not targets. Respect any browser restriction; source inspection is not
  observed reference motion. Preserve and refine the accepted Android composition.
- Source `scripts/env.sh`; keep new caches, logs, builds and media on the SSD. Verify selected
  database, migration ledger/checksums, API/worker listeners/heartbeats, app build/session and
  emulator before using any old runtime receipt. No secret values in output, Git or evidence.

The last preserved preview used API4322, `emulator-5554` / API36, the `.journey` test app and
`knowscroll_test_native_76cf2b52091ca64c`, with two kept Traces. Its receipt is under the preserved
Android worktree's ignored `artifacts/android-living/preview/runtime.json`. This is historical
location information, not a guarantee those processes are alive. Preserve the owner's preview
state; explain any test transition and restore the preview afterward. Use disposable databases
and the separate test app. Never migrate, reset or mutate owner database `knowscroll` to get a
green receipt; its last read-only ledger had only migrations0001–0009.

### Deliver all six phases

1. **[#131 — Semantic foundations](https://github.com/KnowScroll/knowscroll/issues/131).**
   Implement source/claim/concept support, competing revisable hypotheses, counterevidence, decay,
   conceptual bridge usefulness, correction propagation and typed semantic proposal/read-set
   contracts. Prove both a justified bridge and rejection of a plausible unsupported one.
   Retain the complete semantic/geography target checklist instead of declaring a tiny heuristic
   the engine. Coordinate #4/#6 ownership and privacy invariants before consumers.
2. **[#132 — Product reasoning](https://github.com/KnowScroll/knowscroll/issues/132).**
   Reuse existing durable scheduling, fairness, budget, context, lease, lifecycle and reconciliation
   primitives. Add fresh direct/background execution authority, native continuation, bounded
   children, a worker-only provider path, validated proposal application and real Ask/results.
   Do not silently execute old recorded-only Asks. Prove crash/unknown-outcome/cancellation/Clear
   behavior and an actual authorized Scroll Ask round trip. A fixture run is not live execution.
3. **[#133 — Complete Composer](https://github.com/KnowScroll/knowscroll/issues/133).**
   Preserve immutable `composer-signals-v2`; implement a versioned successor with eligible
   semantic/graph/multi-source retrieval, utility and cognitive intent, familiarity/frontier
   balance, diversity, counterevidence, exposure-aware reranking, rolling windows, continuity,
   honest fallback and reproducible explanations. Cover cold start, fatigue, starvation,
   correction, latency and deterministic replay. Evaluate usefulness separately from correctness.
4. **[#134 — Living worlds, inventory and Android](https://github.com/KnowScroll/knowscroll/issues/134).**
   Connect actual topic/region/world relationships, rich Scroll transport/registry, branches,
   source/world discovery and inventory demand/reuse/adapt/join/fund decisions to the polished
   native experience. Implement explained recursive geography, foundations, contradictions,
   Chronicle, revisitable predictions, bounded away-time work, personal rooms/inhabitants and
   typed Relics. Preserve source/provenance, private binding and correction/revocation rules.
   Follow the product's complete grammar with evidence gates, not arbitrary geometry changes.
   Keep authored demos explicitly authored; live consumers must use actual authorized relations.
   Preserve exact camera/topic/reading/playback/branch return and privacy-scoped restoration.
5. **[#135 — Owner access, privacy and release clients](https://github.com/KnowScroll/knowscroll/issues/135).**
   Reuse backend magic-link/AgentMail and privacy primitives. Finish real Android sign-in,
   session/recovery, pause/export/correction/clear/reset/delete controls and offline/retry semantics;
   finish remaining required desktop integration after Android. Preserve explicit retention,
   backup and account policy. Prove populated migration upgrades and recovery on disposable
   clones. Prepare operator deployment without treating it as permission to alter owner history.
6. **[#136 — Verification, performance and acceptance](https://github.com/KnowScroll/knowscroll/issues/136).**
   Start this alongside phase1 and run it throughout every slice. Resolve/verify #97 sheet
   restoration, #115 CI API/client journey coverage, #123 timing/concurrency and the historical
   #57 cleanup-acknowledgement investigation now consolidated there. Retain failure evidence;
   do not claim an unknown historical cause was explained because later runs pass.
   Fix and measure Android frame timing/startup/player behavior and ANR boundaries. Prove all
   applicable personal journeys, failure/recovery paths, release builds and owner experience.

Phase1 supplies semantic contracts for phases2/3; phase4 consumes their accepted outputs.
Phase5's independent identity work and phase6's verification infrastructure can proceed earlier.
Prefer end-to-end slices across these phases to six isolated piles of code. Define contract
ownership and migration numbers centrally; keep consumer implementations coordinated.

### Maintainability is part of acceptance

- Keep the deterministic core pure; no database, HTTP, provider or UI imports there. Keep source
  retrieval/persistence, worker orchestration/provider I/O, and Android state/rendering in their
  owned modules. Extend existing queues, clients and registries instead of parallel replacements.
- Define typed versioned boundaries before consumers. Use focused cohesive modules and explicit
  state machines; avoid growing giant API/UI controllers, cross-layer shortcuts or speculative
  general frameworks. Document non-obvious invariants, tradeoffs and recovery behavior.
- Preserve immutable released migrations and ranking policies. Test populated upgrades, not
  just empty databases. Respect universe-first locking and authority/epoch/read-set rechecks
  after waits. Source revision, privacy erasure and late-result handling are design inputs.
- Review actual diffs and failure paths. Fix underlying causes; do not weaken tests, increase
  timeouts blindly, retry until green, hide unavailable capabilities or fabricate product data.
  Add regression tests for meaningful failures, not tests that merely repeat implementation.
- Keep each PR reviewable, linked to its named issue, with user outcome, design decisions,
  checks/results, actual runtime evidence, divergence and next action. Verify exact-head CI.

### Verify while building, not only at the end

For every substantive slice, establish a measurable user outcome and expected path, implement the
smallest complete vertical behavior, then verify it before adding the next layer:

1. Relevant pure/contract tests and real disposable PostgreSQL invariants/concurrency/privacy.
2. Separate API/worker runtime with exact causal IDs, source/policy revisions and recovery traces.
3. Actual native UI entry → behavior → visible result → exact return, plus error/offline/retry,
   interruption, recreation, background/resume and stale-authority cases.
4. Visual/motion refinement against the approved references, compact/large text, accessibility,
   genuine two-pointer gestures, reduced motion, media memory, startup and matched frame profiles.
5. Independent review when appropriate, coordinator verification, implementation checks and
   exact-head CI; then durable issue/project/checkpoint updates.

Use real sourced Scrolls first; do not wait for Cutroom to prove the personal intelligence loop.
Distinguish source implementation, fixture integration, real local service, live provider output,
release UI and owner acceptance. Preserve failed receipts, compare matched configurations and
state evidence limits. Test and explain first-time, empty, exhausted and unavailable states.

PR130's matched API36/host-GPU/4096MiB/4-core profile regressed: baseline p95 **47.40ms**, after
**52.29–66.56ms**. Do not call smoothness accepted. The owner has an emulator now; do not block
implementation on a phone, and do not call emulator measurements physical-device proof. The
documented macOS pinch is Command + primary-button drag; actual Android two-pointer events passed,
but manual desktop modifier forwarding remained unverified at handoff. No new observed ANR is
not proof every historical ANR cause is fixed.

### Scope boundaries and authorizations

- **Cutroom #9 stays last and owner-led.** Preserve its integration seams, publication/import
  contracts and actual-video test support, but do not start upstream/provider integration in this
  six-phase session. Keep final generated-series/video acceptance explicitly open afterward.
- **Social/Blend #137 is deferred future work**, replacing #11's old planning entry. Do not widen
  the single-account model or build fake friends/shared rooms. Preserve the full future projection,
  visit, consent, revocation, independent-ownership and no-permanent-merge requirements there.
- Historical MiniMax certification and a Cutroom-specific allowance are not blanket permission
  for product-model spending. Inspect the current provider route/capability and applicable budget
  authorization. If a needed live experiment is not covered, prepare its exact bounded plan and
  request the missing decision while continuing independent implementation. Never infer approval
  from waiting, silently switch paid routes or claim a fixture is a live provider result.
- Required desktop parity remains part of the personal release contract; Android is first. Keep
  #72 open until applicable personal, both-client, owner and final real-video acceptance is met.
  Six implemented phases alone do not certify the later Cutroom journey.

### Keep the project current throughout this session

The owner explicitly asks you to do this too, not just build code:

- Refresh Project1, #72 and assigned phase/component issues at start and after material delivery,
  design decisions, failures, blockers and review outcomes. Use actual source/runtime receipts.
- Mark an issue In Progress when its implementation starts; Done/closed only when its stated
  scope and evidence are delivered. Parent epics stay open while acceptance remains.
- Close stale/duplicate tracking only with an explicit successor and transferred requirements;
  label supersession rather than completion, and archive its board item. Never close an unresolved
  defect merely because it is old. #57's successor is #123/#136; its cause remains unknown.
- Keep deferred #137 and #9 visible with updated dependencies; do not accidentally reintroduce
  them as active six-phase work. Record any new scope decision consistently in the release contract.
- Update CHECKPOINT and PROJECT-STATE when durable truth changes. Keep a coverage matrix for all
  six phases with completed, partial, blocked, unproved and next action, plus links to PRs/receipts.
  Do not derive product completion percentages from ticket counts.
- Before ending or compaction, leave a resumable handoff: exact branches/commits/PRs, changed paths,
  runtime/DB/app identities without secrets, tests and failures, unresolved decisions and next
  concrete action. Preserve a healthy owner-accessible preview and explain its test route.

Follow the applicable delegation rules. Check ORC_SESSION/ORC_WORKERS/ORC_PANE_ID first; reuse
an existing bench if present. Use bounded `pio` workers for heavy review/implementation when
required by project instructions, with isolated SSD lanes/databases/ports. Coordinator owns
contracts, migrations, privacy and integration; verify worker output and collect completion,
actual model/usage and exit receipts. Do not invent worker capabilities, flags or completion.

## September 24 tracking disposition

- New phase issues: #131–#136, all children of #72, initially Todo.
- New deferred future epic: #137 Social/Blend. Original #11 closes as superseded, not implemented.
- #57 closes as superseded by expanded reliability #123, under #136; original evidence retained.
- #97, #115 and #123 stay open and are children of #136. Source inspection still found no strict
  assertion that the source/explanation sheet survives recreation; CI still lacks the Web API/client
  journey; the historical concurrency/cleanup causes are not all established.
- Component epics #2–#8/#10/#12 remain open with updated coverage and links to execution phases.
  They retain product ownership/acceptance; phases are the current delivery sequence.
- This handoff and tracker cleanup deliver no new algorithm/runtime behavior. The current verified
  source foundation remains merged PR130, and all live observations must be refreshed next session.
