# Bootstrap HTTP contract v1

Status: local development only. [ADR-0009](../decisions/0009-device-sessions-and-privacy-epochs.md) defines operator-provisioned device sessions and privacy epoch fences; [ADR-0026](../decisions/0026-magic-link-single-user-identity.md) adds real single-owner email magic-link sign-in on top of the same session shape. Production deployment and sign-in UI on either surface remain future work.

Base URL: http://127.0.0.1:4310. Android emulator uses http://10.0.2.2:4310. All /v1 endpoints require `Authorization: Bearer <session token>`. **`KS_DEV_TOKEN` (deprecated):** enrolls once as an ordinary expiring, revocable owner session; kept working for existing local tooling and journeys, and — like every path in this file — refused outright because `apps/api/src/main.ts` refuses to start any `NODE_ENV=production` process at all. Real sign-in (below) is the production-track identity path. Tokens are local configuration, never committed. JSON uses camelCase, UUID identifiers and ISO timestamps. Backend resolves universe identity from the session; clients cannot pick another universe.

- GET /health → {status:"ok", database:true}
- GET /v1/session → {sessionId,deviceId,universeId,privacyEpoch:number,expiresAt}
- POST /v1/session/revoke body {} → 204. Revokes only the authenticated session. Restart does not restore it.
- POST /v1/history/clear body {requestId:UUID,expectedPrivacyEpoch:number,confirmation:"clear-scroll-history"} → 200 {receiptId,privacyEpoch,clearedAt}. The same request body replays its receipt without erasing again. Conflicting reuse or a new request against a changed epoch returns 409. The calling session advances with the epoch; other sessions become stale. See [ADR-0010](../decisions/0010-clear-scroll-history.md) for transaction, retention and mobile recovery requirements.
- GET /v1/universe → {universeId, privacyEpoch:number, revision:number, traces:[{eventId,assetId,title,createdAt}], capabilities:{reasoning:false,reels:false,worldEvolution:false}}
- GET /v1/feed?kinds=Scroll,Reel → {decisionId, universeId, privacyEpoch:number, accountRevision:number, items:[...]}. Bounded 3 candidates. Selection is not exposure. `kinds` is optional and defaults to `Scroll` alone, so a client that never sends it sees exactly what it sees today: `items:[{assetId,revision:1,kind:"Scroll",title,summary,body,sourceTitle,sourceUrl,truthState:"documented",reason}]`. A client that can play a Reel asks for `kinds=Scroll,Reel` (any order); an eligible/`test_eligible`, non-withdrawn Reel asset is then included, interleaved with the Scroll list (Scroll, Reel, Scroll, Reel, …) before the existing bounded/kept-exclusion policy runs, so it is not permanently crowded out by a full editorial library — no new inference, no engagement signal. `kinds` naming anything other than a comma-separated, duplicate-free list drawn from `Scroll`/`Reel` (an unknown token, an empty segment, a repeated kind) is a 400 refusal, never silently dropped. A Reel item is `{assetId,revision,kind:"Reel",title,summary,truthState:"synthesis",reason,generatedLabel:true,simulated:boolean,mediaUrl:"/v1/media/:sha256",durationSeconds,aspect:"<width>:<height>",sourceTitle,sourceUrl}` — `title`/`summary` come from the generation brief's own editorial text, never the engine's record; `mediaUrl` is always the KnowScroll-owned content-addressed media route, never an engine or filesystem path; `durationSeconds`/`aspect` come from the stored ffprobe probe recorded at import; `sourceTitle`/`sourceUrl` are the single library Scroll the Reel's brief drew its claims from (ADR-0025). See [ADR-0025](../decisions/0025-eligible-reels-in-inventory.md) for how a Reel becomes an inventory asset in the first place.
- POST /v1/exposures body {decisionId,assetId,clientExposureId:UUID} → {exposureId,eventId}. Only after visible display; retry same clientExposureId. First exposure event is retained. Works identically for a Reel candidate: no new event kind, no change to privacy epochs.
- POST /v1/interactions body {clientEventId:UUID,exposureId,assetId,kind:"keep"} → {eventId,jobId,status:"accepted"}. Same clientEventId is idempotent; conflicting payload returns 409. UI says Kept only after accepted; async projection may lag. Works identically for a Reel: the same `keep` Ledger kind and the same `trace` row, projected by the same deterministic worker — a kept Reel is excluded from future feed candidates exactly like a kept Scroll.
- POST /v1/asks body {clientAskId:UUID,exposureId:UUID,expectedPrivacyEpoch:number,question:string} → 201 {askId,eventId,status:"recorded_only"}. Literal question is nonblank, valid Unicode with no NUL, at most 4096 UTF-8 bytes; route JSON envelope limit 32768 bytes. UUID spelling is canonicalized, question text is preserved exactly. Idempotency is per original session/clientAskId: exact replay returns the same receipt; changed text/exposure conflicts with 409. Expected privacy epoch is checked before replay. A current, same-universe exposed **Scroll** with unchanged selected asset is required; no same-session exposure provenance is claimed. A changed source requires a new encounter. This stores a private source fact until Clear History; it creates no answer, queue, Job, Trace or provider work. No mobile Ask control is enabled. See [ADR-0016](../decisions/0016-explicit-ask-facts.md). **A Reel exposure is refused (422):** migration 0009's own Ask lineage guard requires the exposed candidate to name `kind:"Scroll"`, and the application check ahead of it (`selectedCurrentScroll`) already refuses a non-Scroll asset before that guard is even reached. ADR-0025 records this as a limitation rather than working around it; Ask on a Reel belongs to whichever slice gives Ask an answer.
- GET /v1/events/:eventId → {eventId,causationId:string|null,exposureId:string|null,kind,jobId:string|null,jobStatus:string|null,projected:boolean}

Errors: {error:string}; non-2xx is failure. No server/provider stack traces. No synthetic fallback when unreachable. A retained action becomes a Trace/Relic reference, never an inferred planet or learning claim. API polling universe can observe projection revision after a worker commits. Feed returns a new decision each request and uses Accounts to avoid already-kept content; this is a real deterministic first policy, not the full target Composer.

Unknown, expired, revoked and old-epoch sessions return generic 401. Foreign decisions/exposures fail 422; foreign events return 404. Retained older-epoch references fail 409 before idempotency replay. History clear removes old records, so erased references use the existing missing-reference 422/404 behavior. Epoch-invalidated jobs still present report `jobStatus:"discarded"`, `projected:false`; history clear removes its universe's jobs with the rest of its bootstrap encounter data. Full account deletion, semantic reset and pause personalization remain separate scope.

Mobile reads title/summary/body/sources; Source opens the actual URL. Home begins as an honest empty universe and offers Enter Scroll. After keep, return restores origin and refreshes traces. Show visible connection error/retry. Do not add unavailable Ask/Friends/Reel buttons as fake working features.

## Saved Trace source revisit

`GET /v1/traces/:eventId` follows the strict [source revisit contract](trace-revisit.md). It authorizes the current owner scope, validates the original Keep/exposure/decision lineage and unchanged shared source, and returns a no-store read receipt. It creates no new events. Universe Trace titles now derive from validated selection history; unavailable entries retain a neutral label.

**ADR-0025 limitation (ownership boundary, not a defect):** the Keep→Trace *write* path (the `keep` Ledger event, its `trace` row, the deterministic projection worker) is identical for a Reel and a Scroll — no new event kind, no new code path. The dedicated *read* endpoint above, and `GET /v1/universe`'s trace list, live in `packages/db/src/trace-revisit.ts`, which this slice does not own and does not modify; its selection schema is Scroll-shaped only (`kind:"Scroll"`, `truthState:"documented"`, a `body` field). Revisiting a kept Reel through `GET /v1/traces/:eventId` therefore returns the same generic `422 {"error":"Saved Scroll lineage is unavailable"}` this endpoint already returns for any candidate its schema cannot parse — not a crash, and not a new error shape — and `GET /v1/universe`'s trace list shows that Reel's entry with the existing neutral fallback title "Saved Scroll unavailable", exactly as it already does for any other unparseable selection history. [ADR-0025](../decisions/0025-eligible-reels-in-inventory.md) records this rather than widening that endpoint's contract unilaterally; a Reel-shaped revisit response is follow-up work for whichever lane owns it, and is consistent with ADR-0025 explicitly deferring all Reel playback/revisit UI to a later slice.

## Media serving

`GET|HEAD /v1/media/:sha256` serves KnowScroll-owned, content-addressed media bytes under [ADR-0024](../decisions/0024-publication-gates-and-media-serving.md). `:sha256` must match `^[0-9a-f]{64}$`, checked before anything else touches it; any other shape is `400`. Authorization (device session, epoch, and a `generated_reel` naming this exact media whose `availability` is `eligible` or `test_eligible`) happens in one short transaction, exactly like every other route above; the bytes themselves are streamed entirely outside that transaction, from the stored `storage_key`, never from any caller-supplied or engine-reported path. An unknown sha256, a Reel that exists but is not eligible, and an eligible Reel whose file is missing on the local disk are all the same `404` — this never tells a caller which of those was true.

A successful response carries `Content-Type: video/mp4`, `Accept-Ranges: bytes`, `Content-Length` and `Cache-Control: private, max-age=31536000, immutable` (content-addressed bytes for a given sha256 never change). `Range: bytes=<start>-<end>` (open-ended and suffix forms both supported; exactly one range per request) returns `206` with `Content-Range: bytes <start>-<end>/<size>`; an unsatisfiable or malformed range returns `416` with `Content-Range: bytes */<size>`. `HEAD` returns the same headers with no body.

A response for a `test_eligible` (stand-in) asset always carries `X-KnowScroll-Media-Simulated: true`; this header is never present on a genuine `eligible` response, so no client can mistake stand-in media for real. When the same content-addressed bytes are reachable through more than one `generated_reel` row, an `eligible` reference always wins over a `test_eligible` one for this marker: real content is never mislabelled simulated.

## Sign-in (magic link)

[ADR-0026](../decisions/0026-magic-link-single-user-identity.md): v1 has exactly one account, the
owner's, enforced by a single-row database index. None of these three routes require an existing
session — they are how one is obtained.

- `POST /v1/auth/magic-link` body `{email: string}` (a strict, single-field body — any other shape
  is `400`) → **always `202` `{status:"requested"}`, for every syntactically accepted address,
  known or unknown.** Only the address configured as `KS_OWNER_EMAIL` (normalised: trimmed,
  lowercased) ever produces a token, creating the single account on first use; every other address
  performs one comparable, side-effect-free lookup and nothing more. Nothing in the response, the
  status code or (deliberately) the database work distinguishes the two cases. Rate-limited per
  account and per a coarse, salted requester fingerprint (never the raw address or IP), enforced in
  the same transaction that would insert the token: at most 20 tokens per account and 40 per
  fingerprint in a rolling 15-minute window (matching the token's own lifetime) — generous enough
  for a real owner's legitimate retries, since `sign_in_token` rows are never deleted or backdated
  and so this is a genuine running total for the window's whole real duration, while still bounding
  an attacker who has the address but not the mailbox — serialized with a database advisory lock so
  two concurrent requests cannot both squeeze past the last slot.
  Exceeding either limit is silently absorbed into the same `202` — a rate-limited request never
  gets a link, but never learns that either. A send failure (including a misconfigured local sink)
  is likewise swallowed behind the same `202`, exactly like a real mail provider's best-effort
  delivery. **The address and the issued token are never logged or written anywhere except the
  one-time hash stored in `sign_in_token.token_hash`.**
- `GET /v1/auth/confirm?token=<opaque>` → `200 {valid: boolean}`. **Never consumes the token** and
  is safe to call any number of times — an email client or scanner that prefetches the link cannot
  burn it or sign anyone in. `valid:true` means an unexpired, unconsumed `sign_in` token exists for
  that exact secret; this backend response is the entire "confirmation surface" this slice ships —
  actual sign-in UI on either client surface is later work. A missing/empty `token` query parameter
  is `400`; any other string (right or wrong) is looked up and answered `valid:false` if it does not
  match, with no further distinction.
- `POST /v1/auth/session` body `{token: string}` → consumes the token **exactly once**, under a row
  lock, and mints a normal device session exactly like `KS_DEV_TOKEN` enrollment does — same
  `device_session` table, same expiry (30 days, matching `provisionIdentity`'s default), same
  revocation and privacy-epoch fencing — except `origin:"magic_link"` and a non-null `account_id`.
  `200 {sessionToken, sessionId, deviceId, universeId, privacyEpoch, expiresAt, accountId,
  origin:"magic_link"}`; use `sessionToken` as the bearer for every other route in this file exactly
  like a `KS_DEV_TOKEN`-enrolled token. **Expired, already-consumed, unknown, tampered/malformed and
  any missing-or-wrong-shaped body all produce the identical `401 {"error":"Unauthorized"}` this
  file's other routes already use for a bad session** — there is no separate 400 path for this
  route, so a malformed request is never distinguishable from an expired or replayed token. The
  *first* successful consumption for the one account adopts KnowScroll's existing bootstrap
  universe (so the owner's pre-sign-in history becomes theirs, not an orphan); every later
  consumption reuses that same universe — the database refuses to ever re-bind it to a different
  account.

Delivery is a port (`apps/api/src/magic-link-sender.ts`): this slice ships exactly one
implementation, a development sink that writes the confirmation link (never the address) to a
single fixed, mode-0600 file at `$KS_DEV_ROOT/sign-in/magic-link.txt`, overwritten atomically and
holding only the most recent link. A `NODE_ENV=production` process refuses this sender outright —
no real provider is implemented, and no provider credential belongs in this repository — which is
redundant with, but independent of, `apps/api/src/main.ts` already refusing to start any
production-mode process at all.
