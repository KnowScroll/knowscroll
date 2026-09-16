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
pnpm exec tsx --test tests/reasoning-fairness-adversarial.test.ts
pnpm exec tsx scripts/capture-fairness-evidence.ts artifacts/fairness.json
```

Both focused test files also run in `pnpm test` through the existing test discovery. The runner produces deterministic scenario traces. The evidence command executes it twice and requires byte-identical output; the checked-in evidence records the source revision, source hashes and exact fixture policy separately from later documentation changes. Do not label an older trace as evidence for a changed model.

## Interpretation

The weights `5:6:4:3:2` are initial policy parameters, not production service percentages. Service is measured by normalized estimated cost, not equal request counts. Actual hard resources remain a vector gate. A returner's turn is restored by the next complete traversal; it cannot revoke a slot occupied by an unknown remote call.

Fixture fairness checks assume fitting requests, available physical capacity and no unresolved settlement debt. Rate saturation, pauses and unknown calls can invalidate those assumptions. The model must report that condition and missed deadlines, rather than report service success. Its JSON snapshot/replay checks are in-memory deterministic evidence; concurrent SQL clients, durable commit acknowledgement loss, privacy erasure and host failure need runtime tests.

## Fixture bounds and limits

The default policy permits 64 ready candidates, 32 candidate/empty probes and 16 admissions per tick. Sustained traces use a larger explicit finite cohort (up to 1,024 ready candidates, 128 probes); each event records any override. Head bypass examines one candidate per universe probe and persists the cursor. This bounds modeled selection work, not SQL query latency or the simulation's retained-accounting scans.

Snapshots include outer and per-class inner visits, globally increasing inner generations, credits/debt, the monotonic virtual clock and immutable policy hash. They are trusted model-generated JSON. The rate abstraction has one fixture-wide window ID advanced by a trusted rollover event; each reservation retains its original ID. This proves separation of renewed rate capacity from uncertain remote/budget holds, not a provider's actual window rules.

[Recorded evidence](../journeys/evidence/reasoning-fairness/README.md) includes genuine dynamic arrival, settlement, rollover and restart events, with assertions and per-class/per-universe normalized service totals.

## Runtime handoff

After design acceptance, one named follow-up implements durable fair selection and atomic claim/reservation under ADR-0012's universe-first locking. It must preserve class/universe cursor generations, open visits, credit/debt and original accounting identities. No separately committed fairness wrapper around `claimJob`/`reserveAttempt` is sufficient. The follow-up must include restart/concurrent-worker, blocked-candidate, overage, unknown-hold, rate-window and privacy-clear tests before claiming the SQL scheduler is fair.

Context compilation, proposal application, lifecycle disclosure/cleanup and a separately bounded provider experiment remain later gates. Only Reel and Scroll remain consumption objects.
