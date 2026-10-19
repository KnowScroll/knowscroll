# Handoff: fresh KnowScroll architecture

Read [02d-greenfield-blueprint.md](02d-greenfield-blueprint.md) first. It is the self-contained current proposal. Earlier files in this folder record the previous reuse-oriented design and conversation; they do not require reusing the old codebase.

## Owner request

Create an in-depth architecture for a fresh TypeScript implementation, with beginner-readable technical explanations, equations, diagrams, worked journeys, all UI changes, sharing/chat and shared what-if sequences, framework/database research, code organisation and coding patterns. Documentation only. No PIO. Preserve the existing repository and data.

## Current state

- Product direction was discussed and welcomed; the owner asked for this expanded document.
- On 19 October the owner selected Expo + React Native Web, pnpm, PostgreSQL, Socket.IO and the discussed open-source building blocks; onion organisation and VPS-first media are adopted.
- The Software Factory workflow is retired at the owner's request. Do not ask for its gates or reinstate it from older documents.
- Nest and the coding-review refinements are approved for the target documentation. Exact dependency versions and implementation slices still require verification and a separate implementation request.
- No new application repository, dependencies, schemas, services or deployments were created.
- Documentation lives on `codex/72-personal-universe-architecture` in `/Volumes/Mrigesh SSD/knowscroll-worktrees/72-personal-universe-architecture`.
- Existing #72 is historical tracking context only. No issue/PR changes are authorised by this research task.

## Selected direction and open details

NestJS selected as the application shell, with its Express adapter for HTTP and standalone application context for workers. Domain rules and application use cases stay plain TypeScript. Keep all planned packages and domain/application/adapters directories, with composition roots in each app. pnpm; PostgreSQL with one schema per module; Kysely raw-SQL migrations; pg-boss as the sole transactional work outbox; Zod + oRPC/@orpc/nest preferred subject to compatibility proof; Socket.IO revision hints via PostgreSQL LISTEN/NOTIFY and HTTP catch-up.

Expo + React Native Web remains the shared app. AccountScope owns caches, sockets and recorder by account/epoch. Use TanStack Query, platform gesture adapters, selective XState, dependency-cruiser/knip, Vitest for backend, jest-expo/RNTL for RN and Playwright/Maestro/device journeys. Exact dependency versions require verification. Local VPS media behind MediaStore first; S3 later.

The shared harness executes bounded calls; roles live in their owning modules. Queue delivery, business run and external attempt are distinct. Every paid execution consults the attempt ledger; no model-driven tool loops in v1. MiniMax is subject to plan/data approval; Pi/AI SDK are optional conforming adapters, no PIO.

Tier 0 observability is persistent bounded journald, durable decisions, restricted ops views, read-only private Grafana and a proposed journey CLI; OpenTelemetry instrumentation does not imply a deployed trace backend. Keep personally linked detail in erasable stores. Loki/Tempo/Alloy are deferred until named needs justify them. Renderer remains open; 3D is optional.

## Decisions that must survive context loss

1. Actual encounters supply personal evidence. Recommendations, generated supply and model proposals do not.
2. Current intent overrides a personal plan immediately. Long-lived geography changes cautiously.
3. Passive qualified encounters can form worlds. There are no compulsory questions, tests or learning claims.
4. Topic systems have organising stars; planets are subtopics; regions are finer areas. Inactivity changes activity, not existence.
5. Reel and Scroll variants share explanation identity. They can produce two encounters without double-counting conceptual variety.
6. Horizontal continuation distinguishes a declared sequel from a related move; format variants and scenario branches are separate links.
7. Planner/Cartographer/Scenario Planner share harness machinery but have separate scopes, prepared inputs, memory and outputs; no autonomous tool loops initially.
8. Fine-tuning is not required initially and is different from prompts, personal memory and numeric policy weights.
9. Shared exploration uses one integrated content thread for friends and idea-room discussions: episode navigator, player, messages, anchored snippets and inline What-if/Another perspective branches. Backend conversation/thread/scenario/position records stay separate. Only actual personal encounters grow personal evidence.
10. Friend selection supports visibility-controlled availability; peer playback/seen/current-branch state is private. Episode markers describe the caller only. Upcoming ready, preparing and suggested are distinct states.
11. Snippets reference exact Reel ranges or Scroll passages/blocks, optionally with validated block settings. Only explicit selected requests commission continuations. Room threads share the same engine with their own access scope.
12. The UI has complete loading/error/offline/revoked/corrected states; it does not expose internal model reasoning or fabricate social activity.
13. One database authority with clear ownership and bounded reads is the initial aim. No giant user document or full-history recompute on each swipe.
14. Every durable effect needs idempotency, current authority and an explicit correction/erasure path.
15. Nest hosts HTTP, Socket.IO, worker lifecycle and dependency wiring; domain/application code has no Nest imports. Workers recheck authority because HTTP guards do not run for direct provider calls.
16. Interaction recording is shared client infrastructure with scoped batching; commands, observations and diagnostics remain distinct.
17. Debugging joins durable decision records with logs/traces; general logs omit private bodies and secrets, and erasure includes diagnostics.
18. Design preserves the existing content-poster and dark-spatial registers; older reference behaviours do not override new product semantics.

## Read by task

- Algorithms: blueprint sections 8–15.
- Stores/contracts/API: sections 5–7 and 19.
- Asha's connected journey: section 16.
- Sharing/scenarios/rooms and UI: sections 17–18.
- Framework/database decisions: section 4.
- Code structure and style: sections 22–23.
- Later delivery planning and remaining decisions: sections 24–25.
- Debugging/observability: section 26.
- Design handoff: section 27, [design brief](03-design-brief.md), [Claude prompt](04-claude-design-prompt.md) and [references](design-references/README.md).

## Accepted coding-review refinements

- Acquire the personal scope lock before checking/inserting receipts; store receipt, effects and job in one transaction. Short atomic commands do not get an extra lease subsystem. Shared receipts bind actor and scope; async receipts store accepted/pending, while status comes from the resource read.
- pg-boss is durable work; NOTIFY/Socket.IO are recoverable hints. No generic duplicate outbox. Non-transactional consumers open short domain transactions explicitly.
- Attempt ledgers are mandatory even when queue retries are disabled. Unknown dispatch is reconciled, never blindly resent; protected request bytes never enter ordinary logs.
- Ports include named storage capabilities; use cases do not import their own SQL adapter. Role output/job schemas are backend-local; shared contracts are wire-only.
- One typed diagnostic catalogue with relevant, real IDs; sink projections honour journal erasure limits. One stable outcome/problem-code mapping.
- One full shared-branch integration spike proves the framework/contract/job/socket/build combination before broad implementation. Section 24 retains unresolved choices.

## Next action

Review the updated Nest blueprint and its journey/organisation diagrams. No application implementation is authorised. Revise the existing design export using the updated design handoff, especially the integrated social thread and room reuse. The export at `/Users/comreton/Downloads/KnowScroll-design-v1` was reviewed as static HTML; live gestures and native behaviour were not verified. The documentation update does not edit or implement that export. Keep numerical policies, privacy detail, renderer and exact dependency versions visibly open. Do not infer permission to implement the application from this documentation request. No gate question is required.

Documentation verification will be recorded in `00-status.md`; it is not evidence that the proposed system runs.
