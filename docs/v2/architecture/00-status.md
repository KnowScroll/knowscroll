# Status: personal universe architecture

Updated: 2026-10-19. Documentation and design handoff only. No application implementation authorised.

## Current entry points

- [Greenfield blueprint](02d-greenfield-blueprint.md): selected stack and organisation, algorithms, contracts, UI, journeys and observability.
- [Future-session handoff](02e-future-session-handoff.md): decisions and continuation boundaries.
- [Design brief](03-design-brief.md): complete frame inventory, interactions and existing-theme direction.
- [Claude design prompt](04-claude-design-prompt.md): copyable task prompt.
- [Reference guide](design-references/README.md): eight inspected images with positive/current/negative roles and provenance manifest.

## Current authority

The owner has now selected NestJS and authorised incorporating the coding review plus the discussed refinements into the final target architecture. Nest hosts the API, Socket.IO, dependency wiring and standalone worker context. Domain/application code remains plain TypeScript, with app-owned composition roots and the larger directory layout preserved. This decision changes target documentation only; it does not change an accepted runtime ADR or authorise implementation.

On 19 October the owner selected one Expo application using React Native on Android/iOS and React Native Web in the browser, pnpm, PostgreSQL, Socket.IO and the discussed open-source libraries. Adopt the modular onion organisation, a shared interaction recorder and VPS-first media behind a replaceable adapter. Comprehensive logs/debugging are an explicit requirement. Universe rendering remains open until the design exercise; 3D is optional. Exact numerical policies, detailed privacy choices, dependency versions and observability capacity/retention remain reviewable details.

The owner explicitly retired the Software Factory skill. Its former gates are not current workflow and must not be reinstated from older files. Historical skill reference, retained only as provenance: https://gist.github.com/Maciejdziuba/88890d7e0eeefa5a8738bbe9fd5e20b8#file-skill-md (previously inspected revision `112d6ba3d533bd07895774e37d169ce585f6317d`). No gate approval question is required. PIO remains excluded.

Earlier `01-product.md`, `02-architecture.md`, `02a-contracts.md`, `02b-user-journey.md` and `02c-harness.md` preserve preceding discussion. Their reuse assumptions, older stack choices and workflow language do not override the current blueprint and owner selections. No accepted runtime ADR or existing schema has been changed.

## Workspace and preservation

Existing issue #72 is historical context only: https://github.com/KnowScroll/knowscroll/issues/72. The original research scope forbids issue changes, so no issue/PR was created or updated. This local handoff records the documentation work.

- Branch: `codex/72-personal-universe-architecture`.
- Worktree: `/Volumes/Mrigesh SSD/knowscroll-worktrees/72-personal-universe-architecture`.
- Source inspection: `e5fdc319ffac0292fb19020ccadca9ee2b254e2f`.
- Original checkout has pre-existing edits in `packages/db/src/composer/semantic.ts` and `packages/db/src/semantic/branches.ts`; both preserved.
- Changes remain under this documentation directory. No application code, databases, dependencies, credentials, accepted ADRs, checkpoint or PROJECT-STATE changed. Source references and prior evidence were preserved.

## Delivery

The current blueprint contains 27 numbered sections. This revision replaces the separate web/native strategy with one Expo app; adopts Socket.IO and local media; specifies domain-oriented onion structure and the selected open-source tools; expands shared interaction instrumentation; and adds operational logs, traces, domain receipts, private viewing, correlation, retention, sampling, privacy and failure verification.

The design handoff covers every consumer surface and a small separate operator appendix. It preserves the approved poster content and spacious dark spatial registers, distinguishes current captures from target references, and labels rejected examples. Eight images were copied without alteration and hashed. The optional older HTML reference files were located but not replayed; no new UI prototype has been built in this task.

## 19 October follow-up: integrated social exploration

Owner approved the discussed content-thread direction for inclusion in the architecture. Blueprint sections 5–7, 14 and 16–18 now cover friend selection with optional availability, caller-only episode markers, anchored Reel/Scroll snippets, inline What-if versus perspective branches, shared-room reuse, record ownership, commands and the complete Asha/Ravi/Meera journey. Section 22 adds implementation boundaries. The design brief and Claude prompt replace the fragmented social flow while preserving frame IDs and adding H03/R04 variants. The future-session handoff and portable design pack are synchronised.

This changes the target documentation only. The first design export was reviewed, not edited; application code, runtime ADRs, owner data and historical planning files remain untouched. No external issue/PR message or implementation was authorised by this follow-up.

## 19 October follow-up: Nest and maintainable implementation design

Updated blueprint sections 3–7, 9, 15–16, 18–19 and 22–26 in place, rather than leaving a contradictory addendum. The document still has 27 numbered sections. The recommendation/formation equations in sections 8–14 are unchanged.

- Nest is selected, with explicit API/worker wiring and plain domain/application code. oRPC is the preferred contract integration, subject to a compatibility spike; report version suggestions are not represented as tested pins.
- Wire-only contracts, module-owned LLM roles and named database ports replace central role/output coupling. The directory tree, dependency diagram and Nest factory sketch show the intended coding pattern.
- Universe-first receipts, transactional pg-boss work, disposable NOTIFY/Socket.IO hints and separate queue/run/attempt lifecycles are explicit. Unknown provider outcomes never authorise blind retries.
- Asha's journey includes a loop/store/output table and a complete shared What-if sequence with failure branches. HTTP navigation has no model wait; workers prepare offers.
- Schema ownership, migration/erasure conventions, account-scoped client resources, platform parity and testing boundaries are specified.
- Tier 0 observability uses durable decisions, restricted ops views, private Grafana, a planned journey inspector and bounded journald. Personal correlation stays in erasable stores; retained distributed tracing and larger collectors are deferred.
- The current handoff, design brief's backend wording and portable pack are synchronised. Historical planning documents and original review reports are preserved.

No application code, package manifest, dependency, schema, database, provider, design export, accepted ADR, CHECKPOINT or PROJECT-STATE was changed. No external issue/PR message was sent. Diagram verification used temporary rendering tools outside the repository and is not product implementation.

## Validation and limits

Nest revision: five current Markdown documents checked for local links, anchors, JSON examples, balanced fences and trailing whitespace. All 13 blueprint Mermaid diagrams rendered successfully with Mermaid 11.12.0 in a local headless browser; the shared-branch sequence and dependency diagram were visually inspected. The new sequence diagrams initially failed on semicolons in labels; these were corrected before the successful full render. Sections 8–14 retain their exact mathematical expressions. The portable pack/ZIP contents were compared byte-for-byte after synchronisation. Application tests, provider calls and production integration were not run; TypeScript examples remain documentation sketches.

Integrated-thread revision verification: all 10 top-level planning Markdown files checked; 37 local file links and 13 heading links resolve; five fenced JSON examples parse; fences balance across 13 Mermaid blocks. The blueprint retains 27 numbered sections. All five edited documents pass whitespace/diff checks against a pre-edit backup. The portable pack is synchronised and its ZIP entries verified byte-for-byte. Diagrams were not rendered; application tests were not run because this changes documentation only.

Earlier 19 October verification (before the integrated-thread revision): 11 Markdown files checked; 57 local links and 13 heading anchors resolve; five fenced JSON examples parse; fences balance around 12 Mermaid blocks. Numerical examples and whitespace in all six revised/new Markdown files pass. All eight copied-image hashes match their source files. The main blueprint contains 27 numbered sections and nine Mermaid diagrams. Diagrams were not rendered and TypeScript sketches were not executed. Application/runtime tests are not applicable to these documentation-only changes. Mermaid diagrams and TypeScript sketches are specification material, not executed implementation. No provider, device-performance, socket, storage, log-viewer or erasure integration is claimed.

Earlier 18 October validation: eight documents, 37 local links, 11 heading anchors, four JSON examples and 11 Mermaid blocks; numeric examples checked. An existing trailing-space heading in `02-architecture.md` is intentionally preserved.

## Next action

Review the Nest revision in the final blueprint and use the refreshed future-session handoff for further architecture work. Implementation remains unauthorised. When requested separately, first verify the exact library matrix through the connected branch-command/job/socket/build spike in section 24. The design pack remains available for a separate design iteration; this update does not review or edit a design export.
