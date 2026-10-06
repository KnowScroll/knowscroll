# Slices: dev, stage and live on one VPS

Gate 4. Status: **APPROVED 2026-10-07.** Before going offline, the owner told the agent to
"continue and finish the VPS and github setup and … deploy the dev and stage, UI and backend and
share running links". Cutroom integration (#199) follows in the next session.

**Overnight limits** (the owner is unreachable):

- No paid provider call. No Cutroom service runs; Cutroom is #199's next session.
- No live deploy and no move of the owner's universe.
- Secrets are never printed. Local work happens only on the SSD.
- Nothing new is created in AgentMail. Stage and dev reuse the existing AgentMail inbox from the
  owner's `.env` (Gate 2's "one shared inbox" option), so sign-in works without a new account.
  This is recorded here, and the owner may switch to an inbox per world later.

Each slice ends in a working, checked state and is ticked in `00-status.md`.

| # | Slice | Proves |
|---|---|---|
| 0 | (done 2026-10-06) Key-only SSH, DNS, GitHub branches + ruleset + default `dev` | Access and naming |
| 1 | **Server baseline via Ansible** (`ops/vps/ansible/`): swap, Docker off, ufw, unattended-upgrade cleanup, journald caps, PostgreSQL 16 (PGDG) + roles/databases for dev and stage, Node 22 (NodeSource), Caddy (official repo) with placeholder pages on all 8 names, world users, folders, slices and sandboxed templated units | `--check --diff` then apply; TLS on all 8 names; ports closed from outside |
| 2 | **Server mode + build once.** API runtime config (no dev token in production, trust one proxy, `/health` world+commit); web production build with the world read from the hostname and the Stage/Dev label; `scripts/build-release.mjs` (full esbuild bundle) | Unit tests first; CI green; the release runs with no `node_modules` |
| 3 | **Deploy tool + pipeline.** `ks` (TypeScript, bundled): `deploy`, `rollback`, `status`, `cleanup`, `disk-guard`; the `ks-gate` forced command; `deploy.yml` (guarded `workflow_run`); GitHub Environments `dev`/`stage`/`production` with the deploy key | A push to `dev` deploys dev by itself; `/health` shows the commit; a no-errors restart |
| 4 | **Stage + promotion.** `scripts/promote.sh` (fast-forward, reuses the release); stage seeded; the `promoters` team + ruleset; the Claude hook refusing `main` updates | Stage runs the same bytes as dev |
| 5 | **Cleanup and crash safety, proven.** Nightly cleanup timer, disk guard timer, the filler-file test at 91 % on dev | Deploys refused at 91 %, emergency cleanup, recovery below 85 % |
| 6 | **Docs.** ADR-0049, `docs/operations/environments.md`, CONTRIBUTING / AGENTS / README / deployment.md on the new flow; handoff with links | A fresh session can operate the server from the docs alone |
| — | *Next session:* Cutroom services (`cutroom-pool`, `cutroom-live`) and #199 | — |
| — | *Later:* live world, with backups (pre-deploy, nightly, weekly restore test, Mac pull), the universe move and uptime alerts; Android flavours and local builds; the `agent` user replacing the root key | — |
