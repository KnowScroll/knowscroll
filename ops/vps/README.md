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

## Finite one-use deployment admission (#250)

Dev/stage SSH still uses `deploy|promote <world> <40hex>`, but the forced command now submits a
root-generated request to an installed `ks-deploy@UUID.service`. The caller streams only into that
request's root0600 FIFO, then reads fixed status. The root unit owns the waiting flock and actual
operation independently of SSH/Actions. `Restart=no`; no runtime deadline kills admitted DDL.
Installation starts no requests. Main/live are refused by this new admission protocol.

Root must separately inspect the exact unit-owned waiting flock, real kernel lock/device/inode,
boot ID/PID/start ticks/cgroup, installed tool and unit hashes and elected exact push artifact before
preparing an intent. `prepare-deployment UUID` accepts at most8192 bytes of canonical single-object
JSON on stdin; strict schema is `parseDeploymentIntent` in plan.ts. There are no defaults or shell
commands in the intent. Its proof/review hashes refer to independently retained complete writer,
transaction, preservation and source/Actions acceptance evidence; parsing a digest does not certify
those facts. All pins and clocks must be elected later by Root. No ready intent is shipped here.

Root0700 persistent `/var/lib/knowscroll/deploy-admission` contains exact per-request records, one
active pointer per world and irreversible nonce tombstones. Runtime FIFOs live under root0700
`/run/knowscroll/deploy-admission`. The root unit verifies real parent flock ownership (not merely
SUDO_COMMAND), then exclusively consumes and fsyncs the exact intent before any incoming archive
write. Wrong waiters never consume the permit. Duplicate request, nonce, reboot, source mismatch,
expired UTC OR same-boot monotonic time, unknown state or malformed/symlinked/oversized files refuse.
Intents last at most30minutes and cannot be overwritten, renewed or automatically rearmed. Exact
lookup only; no history scan or deployment poller. Automatic terminal cleanup removes only the
exact own runtime FIFO and known terminal active pointer. Failed/unknown or interrupted submission
keeps its pointer blocked for explicit Root reconciliation; history, archive and consumed/DDL
markers are retained. No blind retry or blanket deletion command is supplied.

FIFO reception is deadline-bounded and verifies exact independently pinned archive bytes/hash
(ceiling16GiB), before extraction or quiescence. A reused release must retain original tar byte
length in `.ks/release.env` as well as its artifact hash; old releases lacking this proof refuse,
never fabricate a size from extracted files. Normal complete release/tree/schema verification stays.
The same window is checked before quiesce and again AFTER the verified dump immediately before DDL.
A durable `ddl-may-start.json` is conservative unknown evidence, never proof SQL actually ran. Expiry
before that seam refuses DDL; admission, migration-specific timeout, activation and necessary failure
containment then finish beyond expiry without granting a second start. Losing a transport can end
its own stream/status wait but cannot stop the unit. OOM/reboot/root kill or ambiguous journal/COMMIT
is unknown and requires conclusive reconciliation/forward recovery, not automatic restart/restore.

Normal quiesce covers only the target/API/worker. Root must separately close incompatible one-shot,
guardian/timer/queue writers and old transactions, including restart/reconnect sources, before the
schema44 operation. No current host or old-transaction proof is asserted by source tests. Preserve
owner/legacy/pool/media, original financial history and all unresolved consumer/Saved deltas.
D002 still requires integration→dev by PR, immediately plain-merge/push actual dev back to integration
BEFORE waiting for artifact/deploy/postflight. Then independently accept exact new push checks/tar,
prepare one intent and hand off inside its window. Stage uses only `scripts/promote.sh stage` after
accepted dev journeys, exact same artifact and a separate stage-bound request/intent/window. Never
main/production, expired artifact waiver, automatic retry, new budget/provider permission or reset.

The existing integrity job hosts real disposable Linux filesystem/FIFO/flock/process fixtures, plus
strict codec/expiry/order cases. The detached-process fixture proves the independent-lifetime
mechanism under actual kernel locks, not an installed systemd unit or DB/provider deployment.
Actual installation/unit/source hashes, relevant processes, all-writer/transaction fence, profiles,
refs/artifact and preservation must be independently reviewed before fresh clocks. No local suites.
