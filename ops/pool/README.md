# Shared Reel pool database (`knowscroll_pool`)

The pool is the sole spend authority shared by worlds, separate from every world database. `pool_order` stores each reservation and final actual cost. A world reset never deletes its liability (CF-30/CF-62). Applied migrations0001/0002 remain immutable. They describe the historical700¢ cap and legacy client functions;0003 is the forward **source proposal** for D-018's900¢ total and one shared, at-most200¢ v2 grant. Source/CI acceptance does not apply this migration. The retained actual observation remains700¢ total/617¢ committed/83¢ left until separately verified operations change it.

## Forward v2 protocol (0003)

`knowscroll-v2-d018` is the only grant identity. Its cap200, authorityD-018 and creation identity cannot change; it starts **disabled**, can be disabled or permanently retired, and cannot be deleted/reset/replaced. An empty `pool_v2_principal` map initially admits nobody. The migration creates no principals, credentials, client EXECUTE grants, active transport, executor or release capability. Applying it would change the global cap to900 but would not enable v2.

Each v2 order inserts the authoritative `pool_order` and one immutable `pool_v2_order` binding atomically. The binding UUID/time persist across lost acknowledgements, terminal states, disablement and world reset. There is no grant cents counter or second balance. Admission computes both global and grant committed totals from authoritative orders: claimed→full ceiling, settled→actual cost, released→zero. V2 is initially video-only, ceiling1–75¢. Historical unbound orders remain unbound.

The identity is a concrete SQL composite `pool_v2_identity`: `(request_id, script_digest, take, until, body_sha256, ordered_by, ceiling_cents, approval_ref)`. V2 calls compare the whole tuple, fixed grant, actual caller world and immutable binding. An exact claim replay returns the original row/binding and current state; terminal replay never reopens dispatch. Another full digest sharing the truncated request prefix, body/approval/ceiling/world mismatch, ungranted legacy row, or competing same-script request cannot be adopted. `pool_next_take` is only an observation, never authority. Callers retain and compare the returned claimed_at/binding UUID/bound_at receipt after an uncertain acknowledgement.

- `pool_v2_claim(grant, identity)` returns one status/authoritative row/binding UUID. Unknown/disabled/exhausted grant, global exhaustion, script/identity conflict and accounting hold refuse without a receipt. Existing exact receipts remain readable after disable/retire; claimed replay then refuses grant_disabled, while terminal replay reports its terminal state. An accounting hold blocks claim/replay use. Read/status functions do not authorize a send.
- `pool_v2_read_order(grant, identity)` returns exact own row, immutable binding UUID/time and up to32 pending evidence IDs. `pool_v2_grant_status(grant)` returns global/grant base and conservative effective totals, gate state, accounting_hold, full pending count and up to32 IDs. Monetary totals are PostgreSQL bigint values: adapters must preserve their integer representation and check before converting to JavaScript number.
- `pool_v2_settle(grant, identity, outcome, bigint_actual, final_run, evidence_sha256, evidence_ref)` settles the same order or confirms an exact replay. Real actual cost is never clipped to the ceiling/grant/global cap. Evidence is bounded metadata: a SHA-256 and at most200 ASCII identity characters, no body, URL, credential or arbitrary operator command. Outcomes/final-run requirements match the old order. Actuals admit nonnegative JavaScript-safe integers, including values beyond the old integer setter.
- `pool_v2_release_not_sent(grant, identity)` is deliberately **not** granted to ordinary clients. It is only the database endpoint for a later closed Reasoning capability that proves conclusive not_sent/no durable dispatch intent. SQL cannot prove that fact from a string, caller world,404/ready, timeout or expired request bytes. No such active capability exists in this PR, and no dispatch/unknown release claim is made. Future capability integration needs its own tests/review before provisioning this EXECUTE right. Release requires exact own binding, an open order and no unresolved evidence; exact release replay frees capacity once. Final accounting remains possible after disable/retire.

## Contradictory and late actuals

Settlement writes exact evidence **outside** the inner setter exception block. Ordinary accepted settlement marks that evidence satisfied. A different settled tuple, late cost after release, or actual beyond the old integer setter returns `held_needs_operator` normally, preserving pending evidence when the outer transaction commits. Identical reports have deterministic evidence IDs; lower retries or exact replay of the old cost cannot clear another report. Fatal outer/commit failure is uncertainty: retain the exact local pending tuple and reconcile/retry it; never release/resend from a failed acknowledgement.

Per order, effective liability is `max(authoritative base, each unresolved reported actual)`; totals sum each order once. A settled60 plus report80 remains immutable60 with evidence80/effective80, not140. **Any unresolved evidence blocks ALL new claims, legacy and v2.** Accounting may exceed all caps; no aggregate CHECK prevents truth. There is no client reconciliation/write-off/clear-hold API. `pool_budget_status()` keeps its legacy integer shape/base-only meaning and can overflow rather than truncate; it is not operational clearance. V2 must use the new bigint status and separately inspect the hold.

## Locks, security and future provisioning boundary

Every legacy/v2/admin mutator first acquires `LOCK TABLE public.pool_order IN SHARE ROW EXCLUSIVE MODE`, then the fixed grant row, then the target order and binding/evidence. Private cores never call wrappers. No outside call/world transaction is held under these locks. Legacy unbound claim/settle/release signatures and ordinary return shapes remain; wrappers refuse bound orders and all legacy claims honor exception holds. Mapped v2 session identities cannot use legacy wrappers even after an accidental legacy membership/SET ROLE grant. Legacy read definitions are requalified with safe resolution; no private helper is created by renaming an ACL-bearing legacy function.

All SECURITY DEFINER paths use fixed `pg_catalog, pg_temp` resolution and explicitly qualified application objects. New tables/types/functions and private cores revoke PUBLIC access; no sequences are created. Only the trusted owner can call the gate API initially; it also requires session identity equal to function owner. Owner/admin compromise is outside the client threat model.

A separate reviewed operation must provision dedicated LOGIN NOINHERIT, non-superuser/non-CREATEROLE/non-CREATEDB/non-replication/non-BYPASSRLS roles, with **no role memberships at all** (NOINHERIT alone still permits SET ROLE). Insert their exact catalog OID/name/world (`dev` or `stage`) into the empty immutable principal map under global→grant locking. Session identity is PostgreSQL `session_user`, never caller text or SECURITY DEFINER `current_user`; renaming/recreating a role does not match both name and OID. Do not reuse `ks_pool_client`, give clients table/schema-create/private-core/admin rights, make client-owned SECURITY DEFINER functions, or grant legacy memberships. The routine client profile may receive only USAGE on `pool_v2_identity` and EXECUTE on claim/read_order/grant_status/settle. The not_sent release endpoint requires a later separately reviewed capability. No provisioning SQL or login is installed here.

Apply a reviewed migration in one pool transaction; do not provision roles or enable the grant as part of that application. Before activation root independently verifies the actual immutable0001/0002 prefix, installed0003 definitions/ownership/ACLs,900¢ total, disabled one-name grant, all historical order bytes, dedicated principal mapping/connection isolation, sole-writer/restart/unknown reconciliation, server-side fal balance, and human approval for the exact Reel script. Enabling the grant is a separate explicit operation; there is no active executor/admin caller in source. This source proposal grants no provider, pool, host or deploy permission.

## Actions evidence and limits

`tests/integration/pool-v2-grant.test.ts` creates **separate disposable pool databases** on the Actions PostgreSQL service and unique fixture roles, applies the unchanged prefix plus0003, and uses genuine PostgreSQL session identity/ACL/locking behavior. Authored617¢ historical liability is labelled fixture data. It covers shared200/global900 caps; concurrent remaining headroom; immutable replay/full-tuple conflicts; unbound/foreign and legacy refusal; rollback between order/binding;75→80,60→evidence80, late-after-release and huge exact reports; inner/outer rollback; disabled/retired completion; mixed legacy/v2 lock waits; PUBLIC/private/admin/table ACLs; inheritance/SET ROLE and world spoofing; and writable/temp namespace resistance. Ordinary fixture clients have no release right; an explicit test-only grant simulates the future closed capability's database endpoint without claiming to implement Reasoning dispatch proof.

Automated suites run only in Actions. Fixtures and packaged source prove neither actual money movement nor live grants, provider billing, transport, exactly-once purchasing, publication or operational readiness. Later executor phases must retain liabilities across unknown outcomes and bind this protocol to the closed Reasoning capability before any paid use.

PostgreSQL16 documents the [inner exception rollback boundary](https://www.postgresql.org/docs/16/plpgsql-control-structures.html#PLPGSQL-ERROR-TRAPPING) and [SET ROLE membership behavior](https://www.postgresql.org/docs/16/sql-set-role.html). Those mechanics inform this protocol; only the actual Actions fixtures establish its implementation behavior.

## Forward evidence-only hold (0004, #354)

`0004_v2_evidence_hold.sql` is an additive source protocol only. It adds
`pool_v2_record_evidence(grant, identity, outcome, bigint_actual, final_run, evidence_sha256, evidence_ref)`
without changing 0001–0003, any order/binding, grant gate, allowance, or claim/settle/release function.
It creates no principal, client EXECUTE grant or operational authority. Its SECURITY DEFINER
body uses the existing exact session OID/name/world check and global→grant→order→binding→evidence
lock order with a fixed `pg_catalog, pg_temp` search path and qualified private objects.

A new exact pending report returns `evidence_recorded` and its deterministic evidence ID. An
identical still-pending replay returns `evidence_replayed` with the same ID and unchanged original
report row. Both statuses mean only that this exact report is pending **after the transaction
commits**; neither means successful import, settlement, billing reconciliation or permission to
send. An already satisfied report raises `pool_v2_evidence_satisfied`, returns no pending-success
ID and is never reopened. Identity/authority and malformed reports use the unchanged 0003 checks;
a mismatched stored canonical row raises `pool_v2_evidence_identity_mismatch`. These failures are
not active-hold acknowledgements. A failed/lost commit acknowledgement remains unknown: retain the
same local report and reconcile using identical retry plus `pool_v2_read_order`, never release or
invent a zero cost/terminal outcome.

The report domain and canonical v1 evidence-ID formula exactly match0003 settlement. Supported
actuals remain nonnegative JavaScript-safe integers represented as PostgreSQL bigint, including
values beyond the legacy integer setter. Incomplete/unknown actuals or nonterminal outcomes do
not fit this protocol and must remain uncertain locally. A complete nonvideo or failed-import
chain may report its actual terminal billing tuple here while retaining the full claimed ceiling.
Conflicting/larger/lower reports append distinct pending IDs without replacing or clamping truth.
Existing conservative bigint totals and the global pending-evidence gate then block all legacy
and v2 claims across both worlds. Final accounting for an existing exact own binding remains
available after disable/retire and after settled/released states; it creates no new dispatch right.

The report must have one stable identity per actual attempt chain, independent of fresh collector
timestamps or publication UUIDs. Retain original/child run IDs, their distinct own costs and exact
request/dispatch/receipt/result digests in the owning world's durable report; this function stores
only the bounded evidence digest/reference. After independently verified durable import, the
unchanged `pool_v2_settle` with the **identical whole tuple** can satisfy only this same ID. Another
pending report remains a global hold. Merely collecting a complete result, seeing a ready/nonvideo
response or returning from this function never authorizes settlement or release.

The consumer must require the separately reviewed function-definition digest and actual EXECUTE
privilege for the mapped login before activation. An absent/unreviewed function or ACL is a refusal,
with no fallback to settlement. Source/CI acceptance does not apply 0004 or provision that privilege.
`tests/integration/pool-v2-evidence-hold.test.ts` exercises the exact prefix plus0004 on separate
Actions-only disposable databases and genuine fixture login sessions; it is accounting-protocol
fixture evidence, not actual pool, provider, import, billing or paid-activation evidence.
Installation also refuses `pool_v2_evidence_acl_refused` if inherited owner default privileges
would leave any non-owner EXECUTE right after PUBLIC revocation. It never rewrites those defaults
or another role's privileges to obtain activation.

The inherited order/status reads cap their pending-ID arrays at32; status also reports the full
pending count. An ID absent from that capped array is not proof of absence or satisfaction. A
consumer unable to confirm its exact hold must retain blocked/unknown state, not regenerate a
report, settle, release or authorize another send. Evidence-only reporting still retains every
truthful report and existing conservative totals consider them all.

Function-definition provenance uses `pg_get_functiondef` with the query search path explicitly
set to `pg_catalog, public, pg_temp`, so visible type-name deparsing is reproducible. This query
context does not change the function's own fixed `pg_catalog, pg_temp` security path.
