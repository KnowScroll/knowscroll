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
| KnowScroll HEAD this run's evidence was captured against | `dc6c49506e936bd98e6983221e820db5634984f8` (the commit implementing this slice; this evidence-refresh commit necessarily carries a later hash than the one it records — see the PR that carries this evidence for the actual delivered revision) |
| Node | `v22.23.0` |
| ffmpeg | `ffmpeg version 8.1.2 Copyright (c) 2000-2026 the FFmpeg developers` |
| Disposable database | `knowscroll_test_pub_journey_43224662088d4e76` (dropped at the end of the run) |
| Generated Reel id | `8f37fbbd-62a2-47c6-9872-dce5ad47b78b` |
| Media sha256 / size | `e7c41bb6ea9c14163025fa78eccceb53bde991b25dd48376385a74305a54d121` / 61319 bytes |
| Full receipt | `$KS_DEV_ROOT/publication/logs/publication-journey-2026-09-20T02-43-48-336Z.json` |
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

## Coordinator verification and review fixes (2026-09-20)

Independent review returned accept-with-fixes. All three findings are addressed here:

1. **(major) The ADR diverged from the gate that matters.** ADR-0024 said the repetition gate compares
   against "the eligible corpus", while the implementation compares against every other Reel that
   already carries fingerprints. The implementation is right — an eligible-only corpus is permanently
   empty while the witness gate blocks eligibility, so the gate would be inert exactly when it is
   needed. The ADR now says what the gate does, including that a match on *either* fingerprint fails,
   and records that the text followed the implementation rather than the reverse.
2. **(minor)** The component-map status now names what exists (gates and serving implemented and
   J006-verified, witness unavailable so no real eligibility) instead of reading as "nothing built".
3. **(nit)** The media profile is no longer duplicated: `import.ts` exports `MEDIA_PROFILE` and the
   `media_conformance` gate re-checks against that single definition, so the import-time profile and
   the gate cannot drift apart.

Coordinator runs on this lane:

- `pnpm typecheck` clean.
- `tests/publication-{guards,gates,http}.test.ts` together on one disposable database — **38/38**.
- `pnpm exec tsx scripts/run-publication-journey.ts` (J006) — **16/16**, including the database
  refusing a direct SQL attempt to hand-set `eligible` ("A Reel is eligible only when every required
  gate passed"), the worker's automatic decision stopping at `imported`, `test_eligible` reached only
  inside the disposable database, whole-body and Range reads byte-identical to the stored file, and
  the simulated-media marker present.
- Full backend `pnpm test` — **577 + 12 passing**.

Unchanged limits: no witness, so no generated Reel can be eligible in a real universe; no feed,
binding, selection, correction propagation, media retention or playback; stand-in media only, in a
disposable database.
