# GitHub and delivery

Status: **Current contributor flow (D-394).** Sources: `../decisions.md` D-002, D-004, D-011 and `../carried-forward-facts.md` CF-01–CF-04, CF-11, CF-23, CF-24, CF-26.

## Branches

| Branch | Role | Who updates it |
|---|---|---|
| `claude/<issue>-<purpose>` | One feature, one SSD worktree | Its agent |
| `dev` (default branch) | Deploys the dev world on push | Reviewed feature PRs based on `origin/dev` squash directly into `dev`; manual `workflow_dispatch` of `deploy.yml` may deploy any commit to dev |
| `stage` | Deploys the stage world on push | `scripts/promote.sh stage` only (fast-forward to the commit dev is running); the `promoters` team bypass admits it |
| `main` | Live | **Owner or XZNON only** (`scripts/promote.sh live` from their terminal, or merging the owner's PR). Agents never update it. |

Fetch the latest `dev` before starting an issue. Open the PR with `--base dev`. The old integration branch is historical (D-394).

## Settings that live in GitHub, not in Git

- Default branch `dev`. Rulesets `24594426` (main, stage, dev: no deletion, no force-push) and `24608344` (only the `promoters` team — `Legend101Zz`, `XZNON` — updates `main` and `stage`). The `dev` branch requires `integrity`, `static`, `backend`, `build`, `client` and `release` before merging. Inspect the active GitHub rules when troubleshooting a blocked PR.
- Environments `dev` and `stage` hold `KS_DEPLOY_SSH_KEY` (a world-pinned deploy key whose forced command is `ks-gate <world>`); repository variables `KS_DEPLOY_HOST`, `KS_DEPLOY_KNOWN_HOSTS`. `production` waits for a reviewer.
- The repository is public on purpose (free runners and rulesets). Going private later: GitHub Team first, re-confirm rulesets/environments/team, give the server a read-only way to `git ls-remote` (it checks branch tips over public HTTPS). Going private does not undo exposure.
- The agent acts as `Legend101Zz`; GitHub cannot tell the agent from the owner. "Only the owner promotes to live" is discipline backed by `.claude/hooks/refuse-main-update.mjs`, which loads only for Claude sessions started inside a checkout of this repository.

## CI contract

- `.github/workflows/checks.yml` (workflow name `checks`) runs on every push and pull request. `deploy.yml` and `scripts/promote.sh` require a **successful `checks` run on the exact commit**; never rename the file.
- Never a self-hosted runner (fork PRs could run code on the server); `deploy.yml` never runs on pull requests; deploys queue and never cancel (cancelling could cut an SSH session mid-migration). Actions are pinned by commit SHA.
- Merge rule (D-394): green checks on the feature head and an independent review with no blocking finding. After merge, verify the dev deployment and exercise the changed journey.

## Deploy and promotion (v2 path, S1.5)

A v2 release is built once by `checks` and uploaded as an artifact; the deploy downloads that exact artifact, verifies its SHA-256, ships it to the server through the world's gated key, and `ks` verifies every file hash, migrates, switches the world to the v2 unit set and waits for `/health` to report the commit and artifact hash. Stage reuses the release already on the server. See `environments.md` (written with #228) for the server side and rollback.
