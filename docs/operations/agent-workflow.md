# Fresh-session and handoff workflow

Root AGENTS.md contains shared instructions. Root CLAUDE.md imports it with `@AGENTS.md`; scoped CLAUDE files import their local AGENTS. A root session must explicitly read the scoped instructions for files it changes.

This follows the documented difference: [Codex instruction discovery](https://developers.openai.com/codex/guides/agents-md) walks root-to-working-directory, while [Claude memory/imports](https://code.claude.com/docs/en/memory) supports CLAUDE.md imports and scoped guidance. Neither machine-local auto-memory nor an old chat is project authority.

## Opening brief

“Read README.md and docs/PROJECT-STATE.md. Work on issue #N in this worktree. Read its ADR/contracts and scoped instructions. Preserve other lanes. Deliver a PR with implementation checks, observed journey evidence, divergence and next action. Do not implement dependencies owned by another active lane.”

## Coordinator review

1. Does the issue still represent the owner’s desired outcome?
2. Did the actual diff respect component and schema ownership?
3. Did the intended runtime path execute, with evidence tied to source/environment?
4. What is still unproved or blocked?
5. Which durable truth changed: ADR, contract, project state or just operational issue history?

Update those artifacts, merge the reviewed PR, then refresh dependent worktrees. No custom agent scheduler or mandatory chat transcript is required.
