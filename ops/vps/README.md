# VPS release tool

The root-operated `ks` tool lives in `tool/`; pure release/schema policy and mutation ordering are
in `plan.ts`, host effects in `system.ts`. Operational authority and procedures are in
[environments](../../docs/v2/operations/environments.md) and [backups](../../docs/v2/operations/backups.md).

V2 activation requires exact ordered migration names and checksums matching the verified target SQL.
This applies to normal deployment, explicit rollback and automatic recovery. Unknown compatibility
refuses. Incompatible old v2 is stopped before old links return; recovery remains explicitly incomplete.
V1 uses its separate legacy database. No schema mutation, automatic data restore or cleanup bypass
is part of this guard.

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
