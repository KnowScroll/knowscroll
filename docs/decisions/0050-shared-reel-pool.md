# ADR-0050 — One shared Reel pool for dev and stage: claimed once, received everywhere, $5 in total

Date: 2026-10-08. Status: accepted for [#199](https://github.com/KnowScroll/knowscroll/issues/199) on
the owner's Gate 2 approval (`docs/plans/cutroom-integration/02-architecture.md`, approved
2026-10-08; Gates 3–4 skipped by the owner). Builds on
[ADR-0023](0023-generated-reel-supply.md), whose single-world rules all still hold, and
[ADR-0049](0049-environments-on-one-vps.md).

- **Supersedes, for dev and stage only:** ADR-0021 §6 / ADR-0023's "$2 total" and "no live dispatch".
- **Live is unchanged:** its own Cutroom and its own $2 rule.

## Context

The owner wants dev and stage to share one Cutroom and one pool of Reels: either world may order a
real Reel, and every Reel appears in both, paid for once. Total spend for this feature is $5. Cutroom
itself is not changed: KnowScroll hands it the script and takes the finished Reel back.

Upstream Cutroom at `94ee04a` shapes the design (research:
`docs/plans/cutroom-integration/research/2026-10-07-cutroom-upstream-and-knowscroll.md`):

- **Replay is free.** The same request id with key-sorted-equal content is a replay of the newest
  run and spends nothing. The same id with different content is a conflict.
- **No safeguards of its own.** Cutroom has no tenants, no auth and no total budget.
- **Automatic re-run.** A provider-failed run is re-run once, automatically, under the same request
  id. Each run reports only its own cost.
- **Wire changes.** The wire gained `resumes`, `resumedBy` and `keptFrom`. KnowScroll's vendored
  strict schemas rejected them until re-pinned.

## Decision

1. **Re-pin to `94ee04a`.** The nine wire modules are copied byte-for-byte (`ready.ts` and
   `resume.ts` are new), and `CUTROOM_CONTRACT_REVISION` moves.

2. **A script's identity is its wire content.** `scriptDigest(brief, until)` hashes what crosses the
   wire to Cutroom and nothing world-local: no database id, no request id, no ceiling. A pool
   request id is `ks-reel-<first 32 hex>-<take>`. Ordering the same script again after a failed run
   is a new take, never a replay of the failure (`packages/core/src/cutroom/pool-identity.ts`).

3. **The shared record is its own database, `knowscroll_pool`** (`packages/db/pool-migrations/`),
   outside every world, so a world reset never forgets money spent.
   - It holds one `pool_order` row per paid order, recording the world that ordered it, its ceiling,
     its outcome, its cost and the approval behind it.
   - **No claim may take settled cost plus open ceilings past `pool_budget.cap_cents`.** That is 500
     (the owner's $5), and the column's CHECK keeps it at 500 or below.
   - **One open (or successful) order per script.** A second world's claim answers
     `already_ordered`, and that world only receives.
   - **The ordering world alone settles or releases its claim**, once.
   - Worlds reach it only through SECURITY DEFINER functions, granted to `ks_pool_client`.

4. **Orders and receives** (migration 0042):
   - **Order.** `order` claims in the pool first, then creates the world's job, reserving the same
     ceiling on the world's own live grant. A live engine refuses a job with no pool claim
     (`live_dispatch_not_authorized`, as before).
   - **Receive.** A receive job has no grant and no budget, and never sends a request. It looks the
     run up by request id, follows it, imports the file and releases its attempt at 0¢.
   - **The sync pass.** The generation worker settles finished orders into the pool, then creates a
     receive job for each completed pool Reel. It does this only when the world holds the approved
     script but has never seen the request, and only after checking that its compiled request bytes
     equal the pool's `body_sha256`. A reset world therefore gets its Reels back for free.

5. **Cutroom's re-run is followed.**
   - When an order's first run fails and its status names `resumedBy`, the failed run is recorded and
     the re-run becomes the job's second attempt (`role = 'resume'`, `ordinal = 2`).
   - The job keeps following it, keeping its lease alive.
   - The job settles the **sum** of both runs, in the world's grant and in the pool.

6. **Each world's own live cap is a recorded setting** (`generation_live_cap`): 200¢ until an
   operator raises it, and at most 500¢ by CHECK. It is a second lock behind the pool.

7. **Approval is per script, not per order** (owner, 2026-10-07).
   - The owner approves each script in its PR, and the claim records that reference.
   - Claude does not merge reel-script PRs.
   - GitHub cannot tell the owner and the agent apart, so this is a recorded rule, not a lock.

## Alternatives and why

- **A per-world split of the $5** (for example $2.50 each, enforced by each world's own cap). This
  would need no new database, but one world could run dry while the other still had money. The owner
  chose one shared $5.
- **Only stage orders; dev receives behind three locks** (the first Gate 2 draft). Rejected by the
  owner: dev may order too.
- **Disabling Cutroom's re-run** (a very long `CUTROOM_RESUME_DELAY_MS`). That changes how Cutroom
  works, and loses its cheap completion of a failed Reel. Following the chain keeps both the Reel and
  the true spend.
- **Content-derived ids for every job.** Stand-in tests create many jobs for one brief, so ordinary
  orders keep `ks-gen-<uuid>`. Only shared-pool orders use the script's identity.

## Consequences

- KnowScroll counts Cutroom's reported cost, which is set above the providers' real prices, so it
  overcounts real money rather than undercounting it.
- If an order's import keeps failing, its claim stays open with its whole ceiling counted.
- Receives wait at most 30 days for their run.
- The server needs the `knowscroll_pool` database, the `ks_pool_client` role,
  `KS_POOL_DATABASE_URL` and `KS_WORLD` for `ks-generation@`. Those come in the server slice of #199.

## Sources and verification

- **Code:** `packages/db/pool-migrations/0001_shared_pool.sql`,
  `packages/db/migrations/0042_shared_reel_pool.sql`, `packages/db/src/pool/ledger.ts`,
  `packages/db/src/generation/storage.ts`, `apps/worker/src/generation/{worker,operator,main}.ts`.
- **Tests:** `tests/shared-reel-pool.test.ts`, which runs two real world databases plus the pool
  database against a local fixture of the Cutroom wire. It covers:
  - the ledger's rules;
  - stage ordering once while dev receives the same file at 0¢;
  - dev being refused a second order;
  - a re-run being followed and summed;
  - schema refusals;
  - a mismatched-bytes receive being refused.
