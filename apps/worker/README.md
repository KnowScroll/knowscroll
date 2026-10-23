# @knowscroll/worker

## Clear exploration maintenance (#345)

The explicit consumer registry includes `identity.clear-exploration`. Its IDs-only payload
locates an existing account-lifetime operation; durable core_done determines whether the
worker may obtain core-removal authority or only exact-set accounting authority. Selective
removal uses the complete verified owner registry and preserves every Saved/place/Social
row. Accounting retries cannot run a broad eraser or dispatch paid work. On a final handler
failure the consumer tries to record a coarse completion_unverified failure. The separate
`identity.recover-clear-operations` scheduled consumer reconciles durable due operations if that
write also fails, or if a final delivery expires or is lost before the handler can run its catch.
Identity bounds each recovery wave, rechecks exact operation authority and live delivery state,
and commits the recovery marker with its fixed-queue wake. Completed operations can recover
only their due exact-set accounting cleanup; they never reacquire core-removal authority.

The Clear core callback is the closed `eraseCurrentExploration` runner from the actual backend
erasure root. It verifies the frozen current owner registry, runs those actual owner removals and
marks that exact Clear transaction only after successful verification. The worker accepts no
caller-provided registry, digest or lookalike callback as lifecycle proof. Exact-set accounting and
recovery retain their separate existing authority; they cannot reacquire core removal.

This composition requires the durable core from PR348 and the reviewed current lifecycle/schema
prerequisites; older installed schemas or an incomplete lifecycle cannot be certified by wiring.
Actions installed-release fixtures exercise the normal API and worker with disposable data
and no provider. Actual dev/stage privacy journeys require separate deployment evidence.

Background worker: a Nest application context with no network listener. pg-boss claims jobs for
the queues in the explicit consumer registry (`src/jobs.ts`); nothing is discovered by
decorators. HTTP guards never run here, so every consumer's use case rechecks authority itself
under `withPersonalScope`.

| File | Role |
|---|---|
| `src/main.ts` | Validate config → database → Nest context → pg-boss (`consumer` role) → register consumers; on SIGTERM drain (bounded) → close context → close pool, exit 0 |
| `src/worker.module.ts` | Composition root: database, `withPersonalScope`, consumer wiring |
| `src/jobs.ts` | Explicit consumer registry: `evidence.apply-action` → `applyActionEvidence`; `evidence.project-scroll-reading` → `projectScrollReading` (qualifies a reading, commits an evidence revision, hints the account); `identity.sweep-sign-in-records` |

Variables: `docs/v2/engineering/runtime-configuration.md`.

`node dist/operator.js content import-cutroom-reel --run <approved uuid> --script <greenhouse|seasons-v5|tides-v4>`
imports approved existing output at no spend. Required worker-only settings: `KS_WORLD`, `DATABASE_URL`,
`KS_MEDIA_ROOT`, `KS_CUTROOM_ORIGIN` (HTTP loopback only), `KS_CUTROOM_ARTIFACT_ROOT`; optional
`KS_FFPROBE_PATH` defaults `/usr/bin/ffprobe`. Only dev/stage/ci/local operator worlds are accepted.
The worker unit alone receives `SupplementaryGroups=ks-pool`; the API receives no Cutroom origin or
artifact access group. No Cutroom/provider POST exists. `--fixture` additionally requires ci/local and
a disposable `ks_it_*`/`knowscroll_fixture_*` DB, and marks content visibly. Operator output is one
sanitised result line; external errors never log URLs/paths/response text. Failed copy/probe/admission
can leave an unreferenced object; never delete referenced bytes during rollback.

The composition root binds `PRODUCTION_REASONING_HARNESS` and `WITH_PRODUCTION_SCOPE` separately
from the personal harness. Nonpersonal Scroll supply requires explicit worker configuration and
the database root enabled/generation gate; both default disabled. Shared sweep/purge/operator
maintenance still records and resolves production liabilities while production is disabled.

The content production operator is `node dist/operator.js content produce-scroll --topic
seasons|tides|greenhouse [--dry-run] [--resume]`. It refuses worlds outside dev/stage/ci/local,
prints a four-request maximum, uses the explicit nonpersonal harness grant, and emits bounded
IDs/outcome codes and reported usage only. `--resume` reuses frozen stages and attempt IDs;
unknown attempts never resend. No production job or source text is placed on the HTTP path.

The explicit `planner.run` consumer (#236) calls the personal Planner with the delivery abort
signal. `KS_PLANNER_ENABLED` defaults to 1 in world `local` and 0 elsewhere (dev sets 1); with 0,
deliveries persist `blocked_disabled` with no reservation. The role spends the shared MiniMax plan
within the harness caps. Backend
`RequestPlanner(authority,{commandId,resumeRunId})` requeues the same blocked business ID after
review; unknown attempts remain ledger-bound and never resend. There is no direct paid Planner
operator command or consumer UI in this slice. Protected `planner.*` rows expose revisions/status
for operator inspection; ordinary logs contain no Planner context or proposal text.

The `composer.prepare-buffer` consumer (#234) prepares the next vertical Explore move for an offer the
person just activated and stores it for the next navigation (`modules/composer/README.md`). It reads the
session, candidates and Hide in one short transaction, may ask Jev (`KS_JEV_ENABLED=1`) outside any
transaction, then persists the ranking and replaces the person's buffer in a second one. A job for a
superseded intent, an unactivated offer or an old epoch is skipped. A redelivery does nothing. It logs
`composer.buffer_prepared` with the outcome code and counts only.

Connected Cutroom source (#240) registers explicit normal pool/follow/accounting/settle consumers
and a bounded scheduled recovery consumer; all work stays disabled unless the complete separate
Cutroom worker configuration and trusted root packet exist. Each delivery re-reads bounded
externally refreshed attestations without renewing any timestamp. Network/file/probe waits happen
outside world transactions. Normal queued work and Root-driven immediate work invoke the same
exact-operation use case; a receipt or safe hold alone never authorizes POST.

The installed operator accepts `cutroom import-corpus`, `cutroom commission`, `cutroom process-pool`,
`cutroom follow` and `cutroom settle`. They read only the configured root packet, never accept an
arbitrary queue or approval JSON argument. The first pool delivery can safely claim then hold while
Root obtains the actual bound-receipt preflight. Root may refresh actual attestations and use the
exact existing `poolWork`/`followWork`/`settleWork` from that packet for immediate processing. This
is not Cutroom resume or POST retry: any retained C1 intent can only be followed/reconciled.
Immediate output identifies `root_immediate_existing_operation` and distinguishes a held/unknown
operation from progress. `accounting_pending` is a local durable report/job; `accounting_confirmed`
can represent an active evidence hold and must not be read as settlement. Inspect the exact
immutable settlement receipt to establish claim closure.

Source ships no corpus, human approval, principal, allowance, actual preflight, credential, root
seed or runtime activation. Pool0004 installation/provenance/ACL and actual funds/sole-writer
preflight remain separately reviewed Root operations. Old0014 imports and retained scripts are
unchanged. CF62 cross-world0c receiving uses the separate default-disabled target root described
below; it cannot order or settle the original claim. Actions synthetic worker/media journeys establish fixture behavior only, never paid
provider or real installed-profile acceptance.

Bootstrap metadata is separate from human approval: trusted setup permits empty approval
registries for `cutroom import-corpus` and the read-only `cutroom prepare-review` command. The
latter returns the exact prepared public packet for subsequent individual HUMAN approval; it
never adds that approval to a registry or reserves/claims work. A missing current profile may
still permit exact old financial accounting, while fresh GET verification requires its own
actual read profile. Pinned upstream source guards original-plus-child against the unchanged original ceiling. The
actual installed revision/profile/rates, sole-writer/lease and complete send/receipt assumptions
remain an activation gate; unexpected-overage accounting alone never proves that gate.

`cutroom purge` invokes the existing bounded B expiry purge (maximum50) under the current world
root. It does not reconstruct bytes, forget liabilities or automatically release/refund a claim.
This source exposes explicit operator expiry cleanup; it does not claim an additional automatic
protected-byte GC scheduler.

U05 (#363) normally registers the fixed `scenes.expire-formation` consumer and five-minute UTC
`scenes.recover-formation` scheduled consumer. They finalize only the exact current due claim as
skipped, never create formation, grant animation, consume content or invoke a model/provider.
Expiry has120s/three10s-backoff retries; recovery180s/three15s-backoff retries; both concurrency1,
7d queued/2d settled plus declared dead letters. Recovery re-enters owner/epoch/root/Clear fences
with250ms locks/2s statements and at most30s between-op work per delivery. Generated bigint ordinal
pages read101/process100 against a captured ceiling; one required fixed advancing child commits
before any owner root acquisition. Live duplicate child cursors dedupe, final pages do not wake
again, and overlapping scheduled passes may revisit due rows. Exhausted final delivery/root lock
or crash leaves durable due state for the next finite pass. The ordinal-only global cursor has
no personal UUID or per-account effect authority; full/Clear erases the personal row and all exact
private expiry job states. Old late work cannot restore removed IDs or touch fresh-epoch data.

## CF62 zero-cost receiver (#373, default disabled)

`operator.js cutroom receive` stages only the exact envelope in the configured Root-owned
receiving packet; it accepts no arbitrary path, approval JSON, source URL or financial argument.
Stage/required pg-boss work commit together. Normal fixed `content.receive-cutroom` and
`content.recover-receive-cutroom` consumers use separate receiving configuration/root authority;
they never compose Cutroom HTTP/pool connections or require the paid commissioning flag. Every
delivery re-reads the bounded Root packet without renewing its timestamps. Local media/probe work
runs outside transactions; admission and exact receipt are atomic. Unknown commit outcomes retry
the original body, and a historical admitted receipt never restores later content eligibility.

Three finite cooled recovery wakes and bounded leases/deliveries preserve held unknown work.
Fixed-ceiling keyset continuation commits before individual operation waits, including busy first
pages; final pages terminate. Root may explicitly refresh current-policy provenance for the SAME
handoff within its original hard deadline. Source/Actions fixtures do not approve an actual export,
transfer, individual script, corpus, provider call, receiving root or process flag.


## Original-generation personal recording composition (#381)

The worker binds Identity's actual own-account adapter and `FENCE_PERSONAL_RECORDING`. The
own-account adapter supplies the branded current lifecycle reader through the same actual gate;
root-only or pair-only authority cannot stand in for it. Each personal recording use case owns
its existing fresh root → one account UPDATE → original-generation protocol. The composition root neither acquires
a second gate nor creates a recording capability.

Planner and Geography inject the required `RECORDING_REASONING_HARNESS` built by
`personalRecordingReasoningProviders`, with BOTH actual module-owned run checkers. Its role
header/purpose/account/original-generation/claim/full-context/model-context proof is required
before private execution and apply. The generic compatibility harness and nonpersonal production
harness remain separate; neither substitutes for a missing recording-role owner. Missing tokens
or required owner effects fail construction rather than return a successful empty result.

Evidence receives the actual Experience lineage/channel readers, lifecycle reader and PC's
four-method activity effect. The required material callback passes the SAME genuine original-
generation capability and source revision to actual Planner and Geography in the caller's
transaction. Source intake, qualification and derived work retain their own finite bounds and
original delivery identities. The explicit consumer registry, same-business attempt ledger,
strict normal/retirement UUIDs and claim-fenced recovery remain owning; no additional queue,
provider allowance, poller or automatic paid retry is introduced.

These bindings preserve all feature/provider/production flags and paid permits, including their
default-disabled behavior. The existing installed release boot fixture constructs the real Nest
worker registry and checks start plus bounded SIGTERM drain; it is meaningful DI/process evidence
only when run by hosted Actions on the final composed candidate. Full positive recording,
paused/stale/cross-generation, retained-accounting and populated Clear behavior still require the
actual complete API/client/worker graph and separate hosted/real-service acceptance. Local
static checks and source review alone establish neither activation nor deployment.
