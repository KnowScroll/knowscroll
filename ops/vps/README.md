# VPS release tool

The root-operated `ks` tool lives in `tool/`; pure release/schema policy and mutation ordering are
in `plan.ts`, host effects in `system.ts`. Operational authority and procedures are in
[environments](../../docs/v2/operations/environments.md) and [backups](../../docs/v2/operations/backups.md).

V2 activation requires exact ordered migration names and checksums matching the verified target SQL.
This applies to normal deployment, explicit rollback and automatic recovery. Unknown compatibility
refuses. Incompatible old v2 is stopped before old links return; recovery remains explicitly incomplete.
V1 uses its separate legacy database. No schema mutation, automatic data restore or cleanup bypass
is part of this guard.

If v2 preparation (quiesce, dump or migrate) fails or its outcome is unknown, automatic recovery
does not attempt to activate the prior v2 release, even if a schema snapshot still matches it.
An in-flight migration COMMIT may not yet be visible. Stop/disable v2 before restoring original
links and report recovery incomplete; a failed stop prevents restoring links. Conclusive outcome
review is required before separate manual recovery. After acknowledged successful preparation,
ordinary compatible activation/health recovery and explicit rollback retain their schema guards.
Legacy v1 recovery still uses its separate database.

Every v2 deployment first stops/disables its v2 target, API and worker before any dump/migration,
even with an unchanged schema. Stop failure prevents DDL. This intentional brief downtime prevents
old erasers and automatic restarts from running during new backfills. Legacy v1 stays untouched until
normal accepted activation. The root Knip workspace declares only `psql` and `journalctl` as external
host binaries; neither is an npm dependency, and no broad dependency/check exclusion is added.

`integrity` exercises pure policy, the actual activation/recovery ordering seams and their wiring to
host branches. Suites run only in Actions. Those fixtures do not prove host peer authentication,
systemd recovery or an actual rollback. No test suite runs on the VPS.

Application deployment does not update this tool. Before a schema-changing rollout, independently
review the exact source and all required checks, then prepare a separate root installation/recovery
plan for `/usr/local/lib/knowscroll-ops/{plan,system}.ts` (the Ansible ops-tools role owns installation).
Preserve existing tool bytes and evidence, inspect the targeted preview, and have a verified forward
recovery artifact matching the new schema. This documentation alone authorizes no host changes.

## Read and check the tool

Start with [tool/plan.ts](tool/plan.ts) for pure release/schema decisions, then
[tool/tree.ts](tool/tree.ts) for release-tree validation and [tool/system.ts](tool/system.ts) for
host effects. The host command is operational authority, not an application HTTP endpoint.

From the repository root, run
`node --test ops/vps/tool/plan.test.ts ops/vps/tool/tree.test.ts ops/vps/backup/scripts.test.ts`.
The fixtures check refused releases, mutation ordering and backup script behavior without a
host deployment. An incompatible schema should refuse activation; it must not trigger a data
restore or weaken a checksum check. Follow the linked runbooks for actual installation/recovery.
