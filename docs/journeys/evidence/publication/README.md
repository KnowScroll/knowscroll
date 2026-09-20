# J006 evidence — publication gates and media serving

Status: 2026-09-20. This is the joined vertical-slice proof for
[ADR-0024](../../../decisions/0024-publication-gates-and-media-serving.md) and
[issue #100](https://github.com/KnowScroll/knowscroll/issues/100), under #9/#12/#72.

Evidence level throughout: **stand-in media in a disposable database — never real generation and
never the owner's universe.** Never a product journey, never owner acceptance. The `generated_reel`
row this journey evaluates is seeded directly (ADR-0024's own evidence requirements allow this;
[#94/J005](../generation-supply/README.md) already proves real-Cutroom-backed import) with a real,
local-ffmpeg-made MP4 — the only genuinely real media-producing tool involved. No Cutroom process
is started; the owner-local stand-in engine on `127.0.0.1:4390` is never contacted.

## Exact revisions (last passing run)

| Field | Value |
|---|---|
| KnowScroll HEAD this run's evidence was captured against | `472c6b5c43736732b85cd0100de149f010db3dc6` (the ADR-0024/migration-0014 contract commit this slice was built from; see the PR/commit that carries this evidence for the actual delivered revision) |
| Node | `v22.23.0` |
| ffmpeg | `ffmpeg version 8.1.2 Copyright (c) 2000-2026 the FFmpeg developers` |
| Disposable database | `knowscroll_test_pub_journey_1aa8a4d665744905` (dropped at the end of the run) |
| Generated Reel id | `75e35bce-61fb-41af-b23b-06f3648b032d` |
| Media sha256 / size | `e7c41bb6ea9c14163025fa78eccceb53bde991b25dd48376385a74305a54d121` / 61319 bytes |
| Full receipt | `$KS_DEV_ROOT/publication/logs/publication-journey-2026-09-20T02-38-26-148Z.json` |
| Sanitized snapshot (this repo) | `publication-journey.json` (next to this file) |
| Overall | **PASS** (16/16 checks) |

## Per-check expected vs. observed

| # | Check | Expected | Observed |
|---|---|---|---|
| 1 | Seeded Reel starts `imported` | `imported` | `imported` |
| 2 | Gate-evaluation worker (auto) exits 0 | `0` | `0` |
| 3 | `witness_alignment` verdict | `unavailable` | `unavailable` |
| 4 | Every other required gate on this clean fixture | all `pass` | all `pass` |
| 5 | Auto decision reaches `eligible`? | impossible, stays `imported` | stayed `imported` |
| 6 | Database's own `availability` column after the auto call | `imported` | `imported` |
| 7 | Direct SQL `UPDATE ... availability='eligible'` | refused | refused: "A Reel is eligible only when every required gate passed" |
| 8 | Gate-evaluation worker (`--decide test_eligible`) exits 0 | `0` | `0` |
| 9 | Worker's own reported decision | `test_eligible` | `test_eligible` |
| 10 | Database's `availability` column after that call | `test_eligible` | `test_eligible` |
| 11 | Authenticated whole-body `GET /v1/media/:sha256` status | `200` | `200` |
| 12 | Whole-body bytes vs. the stored file | byte-identical | byte-identical |
| 13 | `X-KnowScroll-Media-Simulated` header | `true` | `true` |
| 14 | First `Range` slice status | `206` | `206` |
| 15 | Second `Range` slice status | `206` | `206` |
| 16 | The two Range slices, concatenated, vs. the stored file | byte-identical | byte-identical |

The full ledger, including the exact database name, Reel id and sha256, is in
`publication-journey.json` next to this file.

## First failures and corrections

Both were found and fixed while building this slice, before the passing run recorded above (they
are not journey-runtime instability; the journey has passed every time since):

- **`Content-Length: 0` on a real streamed response.** `apps/api/src/media.ts`'s route handler
  called `reply.send(stream)` as a bare statement inside an `async` handler and then implicitly
  returned `undefined`. Against this project's installed `fastify@5.12.4` / `light-my-request@6.6.0`,
  an async Fastify handler that calls `reply.send()` without returning its result races Fastify's
  own post-handler completion path, which treats the handler's `undefined` return value as "send an
  empty body" and overwrites `Content-Length` to `0` — reproduced directly with a minimal Fastify
  app before being understood, independent of any KnowScroll-specific code. **Correction:** every
  exit in `sendMedia` is now `return reply.send(...)`, confirmed against the same minimal
  reproduction and covered by `tests/publication-http.test.ts`'s full-body and Range assertions.
- **Real content mislabelled simulated when the same bytes are shared.** The authorization query
  picked whichever `generated_reel` row referencing a given sha256 was oldest, so a Reel that was
  genuinely `eligible` could be served with the `test_eligible` simulated marker if an unrelated
  `test_eligible` row happened to reference the identical content-addressed bytes and was inserted
  first. **Correction:** the query now prefers an `eligible` reference over a `test_eligible` one
  for the same media, so real content is never mislabelled stand-in; covered by
  `tests/publication-http.test.ts`'s dedicated shared-content test.

## Limits

This journey seeds its one `generated_reel` directly rather than producing it through a real (even
stand-in) Cutroom run; #94/J005 owns that proof. `witness_alignment` is verified `unavailable` only
because no Visual Witness model exists anywhere in this codebase — this journey proves the current
structural fact, not what a real witness implementation would eventually decide. The HTTP round
trip authenticates with the API's own bootstrap development identity
([bootstrap-http.md](../../contracts/bootstrap-http.md)), a local-development mechanism, not a
production authentication claim. No owner deployment or owner acceptance is proved or claimed here.
