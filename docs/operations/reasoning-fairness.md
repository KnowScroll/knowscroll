# Reasoning fairness model

[#54](https://github.com/KnowScroll/knowscroll/issues/54) defines [ADR-0013](../decisions/0013-bounded-reasoning-fairness.md) and a deterministic model under `scripts/fairness/`. This is design validation. The released `claimJob` implementation still uses queue order and skips locked universes; product reasoning remains disabled.

## What the model represents

- Five weighted class turns and equal universe turns, measured in conservative normalized service units.
- Several small requests per turn, bounded maximum requests, bounded positive credit and persistent negative debt.
- Idle opportunity borrowing and return on a bounded traversal, without remote-call preemption.
- Bounded candidate scans, explicit impossible/capacity-blocked outcomes, saturation and missed deadlines.
- Reservation, uncertain consumed calls, cumulative usage corrections, original rate windows and replayable snapshots.

The model uses synthetic jobs and resource capacities. It opens no database, provider connection or transport. A simulated reserve/consume event is not an executable Permit or proof of SQL atomicity. Existing J004 remains the process/SQL fault evidence for the released primitives.

## Reproduce

From the repository:

```sh
. ./scripts/env.sh
pnpm typecheck
pnpm exec tsx --test tests/reasoning-fairness.test.ts
pnpm exec tsx scripts/fairness/run.ts
```

The focused test file also runs in `pnpm test` through the existing test discovery. The runner produces deterministic scenario traces; the checked-in evidence records the source revision, source hashes and exact fixture policy separately from later documentation changes. Do not label an older trace as evidence for a changed model.

## Interpretation

The weights `5:6:4:3:2` are initial policy parameters, not production service percentages. Service is measured by normalized estimated cost, not equal request counts. Actual hard resources remain a vector gate. A returner's turn is restored by the next complete traversal; it cannot revoke a slot occupied by an unknown remote call.

Fixture fairness checks assume fitting requests, available physical capacity and no unresolved settlement debt. Rate saturation, pauses and unknown calls can invalidate those assumptions. The model must report that condition and missed deadlines, rather than report service success. Its JSON snapshot/replay checks are in-memory deterministic evidence; concurrent SQL clients, durable commit acknowledgement loss, privacy erasure and host failure need runtime tests.

## Runtime handoff

After design acceptance, one named follow-up implements durable fair selection and atomic claim/reservation under ADR-0012's universe-first locking. It must preserve class/universe cursor generations, open visits, credit/debt and original accounting identities. No separately committed fairness wrapper around `claimJob`/`reserveAttempt` is sufficient. The follow-up must include restart/concurrent-worker, blocked-candidate, overage, unknown-hold, rate-window and privacy-clear tests before claiming the SQL scheduler is fair.

Context compilation, proposal application, lifecycle disclosure/cleanup and a separately bounded provider experiment remain later gates. Only Reel and Scroll remain consumption objects.
