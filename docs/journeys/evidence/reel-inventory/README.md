# J007 evidence — Reel inventory: minting, feed opt-in, exposure/keep, media streaming

Status: 2026-09-20. Joined vertical-slice proof for
[ADR-0025](../../../decisions/0025-eligible-reels-in-inventory.md) and
[issue #102](https://github.com/KnowScroll/knowscroll/issues/102), under #8/#9/#3/#72. Follows
[#100/J006](../publication/README.md) (publication gates and media serving).

Evidence level throughout: **stand-in media in a disposable database — never real generation and
never the owner's universe.** Never a product journey, never owner acceptance. The `generated_reel`
row this journey gates and mints is seeded directly (the same evidence allowance J006 uses;
[#94/J005](../generation-supply/README.md) already proves real-Cutroom-backed import) with a real,
local-ffmpeg-made MP4 — the only genuinely real media-producing tool involved. No Cutroom process is
started; the owner-local stand-in engine on `127.0.0.1:4390` is never contacted.

## Exact revisions (last passing run)

| Field | Value |
|---|---|
| KnowScroll HEAD this run's evidence was captured against | `e5ab16c27940fe153ec8113fc05edb525d94b261` (the assigned contract commit for #102; the commit that actually carries this implementation is later — see the PR/issue for the exact delivered revision) |
| Node | `v22.23.0` |
| ffmpeg | `ffmpeg version 8.1.2 Copyright (c) 2000-2026 the FFmpeg developers` |
| Disposable database | `knowscroll_test_inv_journey_4504359eacfd4235` (dropped at the end of the run) |
| Generated Reel id | `4a38efb4-6709-48e5-8ec0-bb1b36f92afa` |
| Minted asset id | `53d53c94-c32f-4bff-9da5-98f26ccf1c8e` |
| Media sha256 / size | `e7c41bb6ea9c14163025fa78eccceb53bde991b25dd48376385a74305a54d121` / 61319 bytes |
| Full receipt | `$KS_DEV_ROOT/inventory/logs/inventory-journey-2026-09-20T03-58-39-158Z.json` |
| Sanitized snapshot (this repo) | `inventory-journey.json` (next to this file) |
| Overall | **PASS** (27/27 checks) |

## Per-check expected vs. observed

| # | Check | Expected | Observed |
|---|---|---|---|
| 1 | Seeded Reel starts `imported` | `imported` | `imported` |
| 2 | Gate-evaluation worker (`--decide test_eligible`) exits 0 | `0` | `0` |
| 3 | Worker's own reported decision | `test_eligible` | `test_eligible` |
| 4 | Mint worker exits 0 | `0` | `0` |
| 5 | First mint reports `created:true` | `true` | `true` |
| 6 | Second mint is idempotent: same `assetId`, `created:false` | `false,<assetId>` | `false,<assetId>` |
| 7 | Default `GET /v1/feed` status | `200` | `200` |
| 8 | Default feed never includes this Reel's `assetId` | `false` | `false` |
| 9 | Default feed carries no `kind:"Reel"` item at all | `false` | `false` |
| 10 | `GET /v1/feed?kinds=Scroll,Reel` status | `200` | `200` |
| 11 | Opted-in feed includes the eligible Reel | present | present |
| 12 | Reel item `mediaUrl` is the content-addressed route | `/v1/media/<sha256>` | `/v1/media/<sha256>` |
| 13 | Reel item `truthState` | `synthesis` | `synthesis` |
| 14 | Reel item `simulated` | `true` | `true` |
| 15 | Reel item `generatedLabel` | `true` | `true` |
| 16 | `kinds=Scroll,Video` (unknown kind) is refused | `400` | `400` |
| 17 | `POST /v1/exposures` for the Reel | `201` | `201` |
| 18 | `POST /v1/interactions` (keep) for the Reel | `202` | `202` |
| 19 | Real projection worker reaches the admitted Reel Keep | `true` | `true` |
| 20 | `GET /v1/events/:eventId` status | `200` | `200` |
| 21 | Events lookup reports `kind:"keep"`, `projected:true` | `keep,true` | `keep,true` |
| 22 | The same `trace` table records the kept Reel | `<assetId>` | `<assetId>` |
| 23 | A kept Reel is excluded from later `kinds=Scroll,Reel` candidates | `false` | `false` |
| 24 | `GET /v1/traces/:eventId` for the kept Reel (documented boundary, not a crash) | `422` | `422` |
| 25 | Whole-body `GET /v1/media/:sha256` status | `200` | `200` |
| 26 | Whole-body bytes vs. the stored file | byte-identical | byte-identical |
| 27 | `X-KnowScroll-Media-Simulated` header | `true` | `true` |

The full ledger, including the exact database name, Reel id, asset id and sha256, is in
`inventory-journey.json` next to this file.

## First failures and corrections

Found and fixed while building this slice, before the passing run recorded above (not
journey-runtime instability; the journey has passed every time since):

- **`GET /v1/feed?kinds=Reel` (Reel alone, Scroll excluded) still returned Scroll items.**
  `apps/api/src/app.ts`'s `feedCandidates` unconditionally queried the Scroll list before checking
  `kinds`, only skipping the Reel query when `Reel` was absent. **Correction:** the Scroll query
  itself is now also gated on `kinds.includes('Scroll')`, so `kinds=Reel` alone genuinely excludes
  every Scroll, matching what it is documented to do.
- **Withdrawing a Reel raised the wrong trigger.** `apps/worker/src/publication/mint.ts`'s
  `withdrawGeneratedReel` first moved `generated_reel.availability` to `withdrawn`, then tried to
  stamp the asset's `withdrawn_at` — but migration 0015's `asset_reel_provenance_guard` re-checks the
  source Reel's availability on **every** update to a Reel asset row, not only at insert, so that
  second update was refused ("needs a generated Reel its gates cleared, not one that is withdrawn").
  **Correction:** the asset's `withdrawn_at` is now stamped first, while the Reel is still
  eligible/test_eligible, and the Reel itself is moved to `withdrawn` afterward — both inside the
  same transaction. Covered by `tests/inventory-mint.test.ts`'s withdrawal tests.
- **Test isolation across a shared global `asset` table.** `tests/inventory-http.test.ts`'s own
  earlier fixture Reels (never kept) remained valid, unkept candidates forever, competing with each
  later test's freshly-minted Reel for the bootstrap policy's bound of 3 candidates and pushing it
  out. **Correction:** each HTTP test withdraws its own fixture Reel once it is done with it
  (`withFixtureReel`), the same isolation a real deployment gets for free from having many more than
  one Reel in circulation.

## Limits

This journey seeds its one `generated_reel` directly rather than producing it through a real (even
stand-in) Cutroom run; #94/J005 owns that proof, and #100/J006 owns the gate/serving proof this
journey reuses unchanged. `witness_alignment` is verified `unavailable` only because no Visual
Witness model exists anywhere in this codebase. **`GET /v1/traces/:eventId` and the Universe trace
list for a kept Reel are a documented, out-of-lane boundary, not a proven capability:** that
endpoint's selection schema (`packages/db/src/trace-revisit.ts`) is Scroll-only and lives outside
this lane's owned paths; revisiting a kept Reel today returns the same generic
`422 {"error":"Saved Scroll lineage is unavailable"}` that endpoint already returns for any
candidate its schema cannot parse, and the Universe trace list shows the existing neutral fallback
title. The WRITE path this ADR actually requires — the same `keep` Ledger event, the same `trace`
row, the same deterministic projection worker, no new event kind — is what checks 17–23 above prove.
No Reel playback UI, no per-person repetition policy, no correction propagation, no world/bridge
behaviour, and no owner deployment or owner acceptance are proved or claimed anywhere in this
journey.
