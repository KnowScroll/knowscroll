# ADR-0021 — Cutroom successor pin and local SSD host composition

Date: 2026-09-20. Status: accepted by the coordinator for [#89](https://github.com/KnowScroll/knowscroll/issues/89)
under #9/#8/#72; implementation evidence pending in that issue. Extends [ADR-0020](0020-cutroom-http-client.md)
and preserves [ADR-0007](0007-cutroom-separate-http-service.md)'s separate-service and publication ownership.

## Context

The owner chose local Cutroom on this Mac with source, SQLite, media, caches and logs on the external
SSD. KnowScroll's strict client was pinned to Cutroom `238df854`. Upstream main at the 2026-09-20
observation is `86d6e2c8b74228db4a5a953e53c53a7b77cef46e`; reel-takes Slice 2 (`7d5f264`) is
implemented and a Slice 3 prompt is next. Between the two pins the only wire change is
`packages/reel-contract/src/record.ts`: `RunRecord` requires `takes` (take/shot IDs, positive
number, `used`, optional observation/reconciliation IDs, strict gate checks) still under wire
version1. The other six copied modules and `apps/api/src/server.ts` are byte-identical.

Upstream exports `startApi({dbPath, port?})` (loopback only, `port` 0 = OS choice) and
`startWorker(options)`. The worker must be *handed* model, image, sensor, video, narration, media
and assembler ports; it never constructs an adapter (upstream S-021/S-038). Upstream supplies only
scripted stand-ins plus real local ffmpeg; no serve command, no real H3/T2A/model adapter. Cutroom
has its own gates-before-code, S-decision, journal and boundary rules, and another harness is
actively committing there.

## Decision

1. **Successor wire pin.** KnowScroll's seven copied modules pin `86d6e2c8…` with per-file SHA-256
   (six unchanged, `record.ts` → `057d30f0…`). A record lacking `takes`, or with a non-strict take
   entry, is a protocol error. `takes` describes takes made; it is not a certified all-paid-attempt
   meter. No validation is loosened.

2. **KnowScroll-owned operator host, outside both products' runtime.** A provisional local host at
   `ops/cutroom-host/` is the composition root that starts upstream's *own* exported API and worker
   from a clean, detached, pinned Cutroom runtime checkout. It copies or reimplements no Cutroom
   code, is never imported by KnowScroll API/worker/mobile, and in this ADR composes only Cutroom's
   own stand-ins plus its ffmpeg adapters (**provider mode `standin`**). Any other provider mode is
   refused. Upstream is run as released and never modified (owner decision below); if upstream
   later ships its own host or real adapters, re-evaluate and supersede this host.

3. **Host process contract.** `node ops/cutroom-host/host.ts <api|worker> --cutroom <runtime dir>
   --expect-revision <40-hex> --instance <dir> [--port <n>] [--standin-script <json>]
   [--render-profile default|small] [--lease-ms <n>] [--poll-ms <n>]` (plain Node type stripping,
   erasable syntax). API and worker are **separate processes** sharing one instance SQLite, so a
   future worker can hold provider credentials that the API never receives (upstream D-005).
   Before opening the database the host refuses (exit 2, one JSON line on stderr) if: the runtime
   checkout's HEAD differs from the expected revision or has tracked changes; the instance directory
   is not absolute, not under `KS_DEV_ROOT`, or lies inside the Cutroom checkout; the port is not an
   integer 0–65535; the provider mode is not `standin`; or provider/KnowScroll secrets
   (`MINIMAX_API_KEY`, `FAL_AI_KEY`, `FAL_KEY`, `DATABASE_URL`, `KS_DEV_TOKEN`) are present in its
   environment. Instance layout: `cutroom.sqlite`, `artifacts/`, `QUESTIONS.md`, `BUDGET.md`
   (explicit copy with its source and hash), `logs/`. Nothing is written inside the Cutroom checkout.
   On readiness it prints exactly one JSON line and writes `<role>.ready.json`: role, pid, observed
   `baseUrl`/port (API), Cutroom revision, host file SHA-256, db path, artifact root, provider mode,
   render profile and stand-in script hash. SIGTERM/SIGINT stop gracefully (API closes; worker
   finishes the job in hand) and exit0. Stand-in scripts are data files; the host never imports test code.

4. **Proof boundary.** A separate KnowScroll runner drives the *repinned* client against the real
   upstream API/worker/SQLite with labelled stand-ins: accepted/replayed/conflict/invalid submits;
   a genuinely lost submit response reconciled only by the original requestId; current-404 lookup;
   strict event cursor paging to a finished video run; result paths absolute, inside the instance
   artifact root, existing and ffprobe-readable with hashes; record parsing with non-empty `takes`;
   graceful restart and crash recovery on the same SQLite and port with a reconstructed caller that
   verifies its persisted request bytes/digest; cancellation; and process/port cleanup. Its evidence
   level is **real local service with upstream stand-in providers**, never real generation.

5. **Configuration.** `CUTROOM_BASE_URL` in the ignored owner `.env` is set only to an observed
   running host listener with an explicit port. It is not an H3/provider endpoint. Provider keys
   are never passed to the host in `standin` mode or to worker lanes.

6. **Owner decisions, 2026-09-20.** KnowScroll does not develop or modify Cutroom: it integrates
   against the published [reel-contract](https://github.com/KnowScroll/Cutroom/blob/main/docs/features/reel-contract.md)
   and, while upstream lacks real providers, proceeds against that contract (stand-ins/fixtures)
   without building them. A bounded live test may spend **at most $2 in total**, and only after
   upstream Cutroom itself ships real providers; none is authorized before then. H3 is fal's
   [MiniMax H3 Max](https://fal.ai/minimax-h3-max); its key is in the ignored owner `.env` and is used
   only by Cutroom's own providers, never by KnowScroll processes.

## Alternatives and why

- *Upstream `apps/host` now:* correct long-term owner, but KnowScroll does not develop Cutroom
  (owner decision 2026-09-20); upstream's own gates and lane own any launcher.
- *Import Cutroom into KnowScroll's worker:* duplicates ownership and puts engine code in the
  product runtime (ADR-0007). Rejected.
- *Keep only the synthetic fixture:* cannot reveal real storage, restart or record behavior. Kept
  for CI fault coverage, not as integration proof.
- *KnowScroll-written provider adapters injected into the Cutroom worker:* violates upstream's
  providers-only model-client rule and splits spend accounting. Not adopted; real adapters are an
  upstream Cutroom responsibility that KnowScroll neither builds nor injects.

## Consequences

The joined proof needs a local Cutroom runtime checkout with installed dependencies and ffmpeg; it
is not in GitHub CI (private upstream + steering submodule + media tools). CI keeps the synthetic
fixture journey. When upstream adds a host or real adapters, re-evaluate and supersede this host.
Real generation, provider adapters, paid-attempt accounting, verified host-file import,
truth/continuity/publication gates, playback and owner acceptance remain open under #9/#12/#72.

## Sources and verification

[Record delta](https://github.com/KnowScroll/Cutroom/compare/238df85411108a94377311363dd296d785688f70...86d6e2c8b74228db4a5a953e53c53a7b77cef46e),
[server](https://github.com/KnowScroll/Cutroom/blob/86d6e2c8b74228db4a5a953e53c53a7b77cef46e/apps/api/src/server.ts),
[worker](https://github.com/KnowScroll/Cutroom/blob/86d6e2c8b74228db4a5a953e53c53a7b77cef46e/apps/worker/src/worker.ts),
[providers](https://github.com/KnowScroll/Cutroom/blob/86d6e2c8b74228db4a5a953e53c53a7b77cef46e/packages/providers/src/index.ts).
Client tests: 30 local HTTP checks pass on the successor pin; the same tests fail against the old
record schema (negative control). Host and joined-proof receipts are linked from #89 when accepted.
