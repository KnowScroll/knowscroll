# KnowScroll

KnowScroll is effortless discovery through Reel and Scroll encounters, with an evolving personal universe. This repository is the **fresh v2 codebase** built from the greenfield blueprint. The previous implementation, its ADRs and its docs were removed from this line of history; they are recoverable from the tag `legacy/v1-final` and must not be used as current authority.

## Read first, in this order

1. `docs/STATUS.md`: what works, what is missing, and what is next. Verify Git, CI and the deployed revision before acting on it.
2. Tracker #462 (the v3 revamp; #222 is the v2 history) and the sub-issue you are working on.
3. `docs/v2/architecture/02d-greenfield-blueprint.md` (authoritative architecture and behaviour) and `docs/v2/architecture/02e-future-session-handoff.md` (decisions that must survive context loss).
4. `docs/v2/decisions.md`, the decisions made during implementation (D-030 sets the current working flow and budgets; D-060 onward record the v3 rulings and amend rules), and `docs/v2/carried-forward-facts.md`, the still-binding owner rulings from v1.
5. For Universe, Scroll, room or Talk work: `docs/v2/design/v3/README.md` (the final v3 designs) and `docs/v2/v3-revamp/CHANGE-MAP.md` (a starting map, not proof).
6. The README of every package or backend module you change.

The blueprint governs architecture and product behaviour, as amended by `docs/v2/decisions.md`. The v3 designs (`docs/v2/design/v3/`) govern the Universe, Scrolls, rooms and Talk (D-060). The v2.1 design export (`docs/v2/design/KnowScroll-design-v2.1/`) governs visuals everywhere else. Their people, messages, content and worlds are authored examples, never product data.

## Product rules that code must preserve

- Adapt quickly to current intent and cautiously to lasting personal meaning. Behaviour is evidence, not proof of learning, belief or identity.
- Only actual personal Reel/Scroll encounters create consumption evidence. Suggestions, generated supply, shared messages, invitations and another person's activity never do.
- Reel and Scroll have equal status. Format preference is learned per topic/context. Series step, format variant, related perspective and What-if branch are four distinct relationships.
- Planet formation needs qualified evidence and conceptual variety. Inactivity changes activity, never existence.
- Peer playback positions, seen markers and current branches are private. Two exceptions: a coarse part-level place a member shares with a thread they joined (members only, per-person hide switch, D-065) and mutual SEEN receipts in DMs (D-066). AI participants are always identifiable. Never fabricate social activity.
- Consumer UI never shows internal prompts, model reasoning, internal ranking, model or evidence scores, sources panels or operational machinery. Game points (sparks, landmarks, stars, a podium per Launch) are play features and may be shown; never a leaderboard, karma total or level (D-064).
- Play results (picks, correctness, sparks, tiers) never feed ranking, planning, evidence, formation or the Universe. A landmark is a read-only overlay (D-063).
- Models propose; deterministic code validates authority, structure and allowed effects before applying anything.

## Reliability boundaries (enforced in code review)

- `withPersonalScope` locks the personal root before protected personal mutations and rechecks authority and epoch after waiting.
- Receipt, domain effects and required pg-boss work commit in one transaction. pg-boss is the only work outbox. NOTIFY/Socket.IO hints are disposable; durable reads recover state.
- Queue delivery, business run and external attempt are separate records. Every paid attempt consults the attempt ledger even with queue retries off. Unknown outcomes are reconciled, never blindly resent.
- No model call or external network wait inside a database transaction, and none on the HTTP navigation path.
- Workers recheck authority themselves; HTTP guards do not run for them.
- Account switch, logout and privacy reset fence and purge scoped client resources (AccountScope keyed by account + epoch).
- No Kafka, second queue, autonomous model tool loops, graph database or microservices.

## How we work

The goal is working product that follows the blueprint, in code a senior engineer would be glad to maintain. Process exists to serve that goal and is kept small.

1. **Issue first.** Every change belongs to a GitHub issue: a phase issue (#229–#250) or a child of one. Its brief names the goal, the blueprint sections, the design artboards, the modules touched and what a user can do when it is done.
2. **One vertical slice per branch.** Branch `claude/<issue>-<purpose>` from `codex/release-knowscroll-v2`, in its own worktree under `/Volumes/Mrigesh SSD/knowscroll-worktrees/`. A slice runs from contract to SQL, use case, HTTP or worker wiring, client-core and screen, so it ends in something a person can use. Contracts and their consumers may land in the same PR. Keep a PR reviewable (roughly under 2,500 changed lines of non-test code); split by slice, never by layer.
3. **Build and test locally.** Typecheck, lint, unit tests and integration tests against a disposable PostgreSQL on the SSD (`/Volumes/Mrigesh SSD/knowscroll-dev/v2/tmp/`). For UI work, run the app and use it at phone and desktop widths, comparing against the matching v2.1 artboard. Run real provider calls when the slice needs them (see Providers and money).
4. **One review.** A reviewer with fresh context reads the diff against the blueprint sections and this file, and reports blocking findings only: correctness, blueprint conformance, privacy, reliability boundaries, code quality bar. Fix them; re-review only what changed. No multi-round "closure" reviews.
5. **Merge on green.** Open the PR to the integration branch; the required `checks` workflow runs in about seven minutes. Squash-merge when it is green and the review has no open blocking finding. Never weaken an assertion, skip a check or hide a failing case to get green.
6. **Promote to dev often.** At least at the end of each phase, open a squash PR from the integration branch to `dev`, merge it on green (the push deploys dev), then immediately merge `dev` back into the integration branch with a plain merge (D-002). Then exercise the slice on `app.dev.knowscroll.space` with disposable accounts and real services.
7. **Report plainly.** At the end of each phase, update `docs/STATUS.md` and the status table in #462, and comment on #462 with what the owner can try on dev now. Evidence is a link: a PR, an Actions run, a screenshot path or a dev URL.

**Not part of the process:** hashing CI logs or artifacts, receipts or manifests as acceptance, reservation and launch packets for model calls, per-call ledgers outside the product's own attempt ledger, "stop at first failure" on generation, review rounds about earlier reviews, and checkpoint essays. Long dense prose in issues, PRs or docs is a defect: write short sentences a newcomer can follow.

## Code and documentation quality

Write maintainable code as a senior developer would:

- Clear names that describe intent. No single-letter names outside tiny lambdas.
- Cohesive functions and small, purposeful classes. A function that grows past ~60 lines is a signal to extract named steps.
- Explicit inputs, dependencies and typed outcomes.
- Pure rules separated from orchestration and adapters (`domain/`, `application/`, `adapters/` in each module; cross-module access only through `public.ts`).
- Appropriate patterns with visible control flow.
- No speculative abstraction framework or generic "manager" classes.
- No hidden database or network effects.
- No untracked durable background promises.
- Defend at trust boundaries (HTTP input, model output, provider responses); do not re-validate values the same process just built and checked.

TSDoc on public operations and important contracts covers purpose, inputs, outputs, authority, side effects, failure/retry behaviour and relevant invariants. Comments explain why something non-obvious exists; they do not narrate the code, the issue history, reviews or run IDs.

Every package and backend module has a README covering purpose and ownership, public entry points and dependency direction, how it takes part in a real journey, configuration and runtime responsibilities, CI verification, important failure and recovery behaviour, and links to related contracts and decisions. Backend module READMEs also name their tables, use cases, jobs, notices, lock order and erasure ownership. Organise READMEs by behaviour, not by issue number, and mark each capability as planned, implemented or runtime-verified.

## Providers and money

- **MiniMax:** use it as much as the work needs until the token plan's 5-hour window limit is reached; then continue with other work and resume after the window resets. Scroll writing uses `MiniMax-M3.1-Flash`; check the response's `model` field, because unknown model names are silently served by another model (D-031). Calls run only in workers or operator commands, never in the client, an HTTP handler or a database transaction.
- **Cutroom and fal:** up to $4 (400¢) of new spend for v2 Reels (D-030). Write, check and order Reel scripts within that budget, and log every script and settled cost in #240. Change the `knowscroll_pool` spend record only through its own functions and migrations. Cutroom is not ours to change: integrate through its HTTP contract only (CF-60).
- Never fabricate provider output, generated content, social participation, world formation or runtime evidence. Fixtures are labelled and live only in tests.

## Environments and safety

- Never update `main` and never deploy production; only the owner or XZNON promote to live. The agent acts as the owner's GitHub account (`Legend101Zz`), so this rests on discipline plus `.claude/hooks/refuse-main-update.mjs`, which loads only for sessions started inside a checkout. A main-targeted PR may be prepared, never merged.
- `dev` deploys on push; `stage` moves only by `scripts/promote.sh stage`. The v2 dev database may be dumped to the SSD and recreated (D-030). Never touch the owner's Mac database, the v1 databases, production media or `knowscroll_pool` rows directly.
- Never print, echo, cat or interpolate a secret into any command, log, issue or report: that includes `.env` values, `/etc/knowscroll/**` env files and anything derived from them, such as a `DATABASE_URL` with a password. Name variables, not values. A provider response can carry a third party's credential (a presigned URL): redact at the recording boundary (CF-10).
- No provider credentials in the client, Git, logs or evidence.
- Destructive tests only on disposable accounts and databases.
- Never switch the branch of the shared checkout `/Volumes/Mrigesh SSD/knowscroll-product`; read other branches with `git show origin/<branch>:<path>`. `ls` can hang on the SSD: use `find` or `git ls-files`.
- Keep worktrees, caches, temp files, media and screenshots on the SSD (`/Volumes/Mrigesh SSD/knowscroll-dev/v2/`). Remove a worktree once its PR merges.
- No `pkill -f`, `killall` or wrappers that kill process groups; stop processes by the PID you started. No resets, force-pushes or edits to another agent's files.
- The repository is public on purpose. Never use a self-hosted runner, and never run a deploy workflow on pull requests.

## Status and continuity

The coordinating session keeps `docs/STATUS.md` (one page) and the #462 status table current at the end of each phase and after any material decision or failure. Workers report in their issue or PR and do not edit `docs/STATUS.md`. A fresh or compacted session reads `docs/STATUS.md`, then verifies Git, CI and the deployed revision before acting.
