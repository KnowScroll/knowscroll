# KnowScroll

KnowScroll is effortless discovery through Reel and Scroll encounters, with an evolving personal universe. This repository is the **fresh v2 codebase** built from the greenfield blueprint. The previous implementation, its ADRs and its docs were removed from this line of history; they are recoverable from the tag `legacy/v1-final` and must not be used as current authority.

## Read first, in this order

1. `docs/CHECKPOINT.md` — current state, active work, next action. Verify Git and runtime state before acting on it.
2. The main tracker issue linked from the checkpoint, and the sub-issue you are assigned.
3. `docs/v2/architecture/02d-greenfield-blueprint.md` (authoritative architecture and behaviour) and `docs/v2/architecture/02e-future-session-handoff.md` (decisions that must survive context loss).
4. `docs/v2/decisions.md` — decisions made during implementation, including blueprint/design conflict resolutions — and `docs/v2/carried-forward-facts.md`, the still-binding owner rulings and operational facts from v1.
5. The README of every package or backend module you change.

The blueprint governs architecture and product behaviour. The v2.1 design export (`docs/v2/design/KnowScroll-design-v2.1/`) governs visuals. Its people, messages, content and worlds are authored examples, never product data.

## Product rules that code must preserve

- Adapt quickly to current intent and cautiously to lasting personal meaning. Behaviour is evidence, not proof of learning, belief or identity.
- Only actual personal Reel/Scroll encounters create consumption evidence. Suggestions, generated supply, shared messages, invitations and another person's activity never do.
- Reel and Scroll have equal status. Format preference is learned per topic/context. Series step, format variant, related perspective and What-if branch are four distinct relationships.
- Planet formation needs qualified evidence and conceptual variety. Inactivity changes activity, never existence.
- Peer playback positions, seen markers and current branches are private. AI participants are always identifiable. Never fabricate social activity.
- Consumer UI never shows internal prompts, model reasoning, scores, sources panels or operational machinery.
- Models propose; deterministic code validates authority, structure and allowed effects before applying anything.

## Reliability boundaries (enforced in code review)

- `withPersonalScope` locks the personal root before protected personal mutations and rechecks authority and epoch after waiting.
- Receipt, domain effects and required pg-boss work commit in one transaction. pg-boss is the only work outbox. NOTIFY/Socket.IO hints are disposable; durable reads recover state.
- Queue delivery, business run and external attempt are separate records. Every paid attempt consults the attempt ledger even with queue retries off. Unknown outcomes are reconciled, never blindly resent.
- No model call or external network wait inside a database transaction, and none on the HTTP navigation path.
- Workers recheck authority themselves; HTTP guards do not run for them.
- Account switch, logout and privacy reset fence and purge scoped client resources (AccountScope keyed by account + epoch).
- No Kafka, second queue, autonomous model tool loops, graph database or microservices.

## Working rules

- Work on a named GitHub issue, in its own SSD worktree under `/Volumes/Mrigesh SSD/knowscroll-worktrees/`, on a branch named `codex/<issue>-<purpose>`. Keep caches, temp files, media, screenshots and evidence on the SSD (`/Volumes/Mrigesh SSD/knowscroll-dev/v2/`).
- Feature PRs target the integration branch `codex/release-knowscroll-v2`. Tested integration revisions reach `dev` by PR (then merge `dev` back into the integration branch, D-002); the agent may also deploy any commit to dev by manual dispatch of the deploy workflow. `dev` → `stage` only by `scripts/promote.sh stage`. **Never update `main` and never deploy production**: only the owner or XZNON promote to live. The agent acts as the owner's GitHub account (`Legend101Zz`), so GitHub cannot tell them apart; this rule rests on discipline plus `.claude/hooks/refuse-main-update.mjs`, which loads only for sessions started inside a checkout.
- Automated test suites and release checks run in GitHub Actions, not locally. Local runs are for hands-on product inspection (start the app and use it). Never weaken assertions, skip required checks or hide failing cases to get a green run.
- Never print, echo, cat or interpolate a secret into any command, log, receipt, issue or report: that includes `.env` values, `/etc/knowscroll/**` env files and anything derived from them, such as a `DATABASE_URL` with a password. Read them only inside a child process's environment and name variables, not values. A provider response can carry a third party's credential (a presigned URL): redact at the recording boundary (CF-10).
- Never fabricate provider output, generated content, social participation, world formation or runtime evidence. Fixtures are labelled and live only in tests and CI.
- No provider credentials in the client, Git, logs or evidence. Provider calls run only in workers. Cutroom remains a separate HTTP service.
- Destructive verification only on disposable test accounts and databases; never clear owner history to obtain a passing receipt. Never touch the owner's Mac database, the v1 databases `knowscroll_test_*`, the `knowscroll_pool` spend record (except through its claim/settle/release functions) or production media.
- Never switch the branch of the shared checkout `/Volumes/Mrigesh SSD/knowscroll-product`; read other branches with `git show origin/<branch>:<path>`. `ls` can hang on the SSD: use `find` or `git ls-files`.
- Preserve others' work: no resets, force-pushes or edits to another agent's owned files. Change shared contracts (`packages/contracts`, `scroll-model`, `scene-core`) before their consumers, in their own PR.
- The repository is public on purpose (free CI and rulesets; going private needs GitHub Team and does not undo exposure). Never use a self-hosted runner, and never run a deploy workflow on pull requests.
- Cutroom is not ours to change: integrate through its HTTP contract only (CF-60). Reel scripts and Reel spend need the owner's approval (CF-62).
- Label evidence: source inspection, CI fixture, real database, real provider, browser, emulator, physical device, dev deployment, stage deployment.

## Session continuity

The coordinating session maintains `docs/CHECKPOINT.md` and the tracker after every phase, material decision or failure. Workers report in their issue/PR and do not edit the checkpoint. A fresh or compacted session reads the checkpoint, then verifies Git, CI and the deployed revision before acting. A summary never authorises a provider call or turns an old observation into current fact.
