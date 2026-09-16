# KnowScroll

Build an emergent personal universe through Reel | Scroll encounters. Start with README.md and docs/PROJECT-STATE.md. Read the scoped AGENTS.md for every component you change; root discovery does not imply nested instructions were loaded.

This is the new private product repository. Previous research lives separately; its code and old operational gates are not current implementation authority. Product laws and accepted ADRs govern changes. Never present a target architecture as implemented runtime.

## Working rules
- Work on a named issue and one branch/worktree on the external SSD. No hidden chat decisions.
- Preserve others' work. Do not reset, force-push, or change shared contracts without coordinating their owner.
- Models propose; deterministic code validates/applies. Behavior is evidence, not proof of belief or learning. Only Reel and Scroll are consumption objects.
- Events retain exposure/causation lineage. Never fabricate model responses, world evolution, sources, success, or runtime evidence. Fakes belong only in tests.
- No provider credentials in mobile, Git, logs, or evidence. External providers run in workers. Cutroom stays a separate HTTP service.
- Before editing, read the component map and relevant ADR/contract. Change contracts before consumers when an issue spans boundaries.
- Authentication, privacy controls, admission and deterministic projection acquire the universe lock before session/domain/job rows. Recheck authority and epoch after waiting; a previously read session is not durable authorization.
- Privacy erasure follows ADR-0010's explicit scope and retry contract. Run destructive verification only on disposable universes and the separate Android test app; never clear owner history to obtain a passing receipt. Preserve source documents and historical evidence when updating current guidance.
- Run implementation checks, then the assigned journey verification. Say exactly what remains unproved.
- End substantial work in the issue/PR: outcome, decisions, paths changed, commands/results, runtime evidence, divergence, next action. Update PROJECT-STATE only when durable project truth changes.

## Commands
See docs/operations/development.md for SSD environment and setup. `pnpm typecheck`, `pnpm test`, `pnpm verify:journey`; Android uses `apps/mobile/gradlew`. A passing build does not prove a user journey.
