# Bootstrap HTTP contract v1

Status: local development only. [ADR-0009](../decisions/0009-device-sessions-and-privacy-epochs.md) defines operator-provisioned device sessions and privacy epoch fences; production login and public enrollment remain future work.

Base URL: http://127.0.0.1:4310. Android emulator uses http://10.0.2.2:4310. All /v1 endpoints require `Authorization: Bearer <session token>`. The existing `KS_DEV_TOKEN` enrolls once as an ordinary expiring, revocable owner session. Tokens are local configuration, never committed. JSON uses camelCase, UUID identifiers and ISO timestamps. Backend resolves universe identity from the session; clients cannot pick another universe.

- GET /health → {status:"ok", database:true}
- GET /v1/session → {sessionId,deviceId,universeId,privacyEpoch:number,expiresAt}
- POST /v1/session/revoke body {} → 204. Revokes only the authenticated session. Restart does not restore it.
- POST /v1/history/clear body {requestId:UUID,expectedPrivacyEpoch:number,confirmation:"clear-scroll-history"} → 200 {receiptId,privacyEpoch,clearedAt}. The same request body replays its receipt without erasing again. Conflicting reuse or a new request against a changed epoch returns 409. The calling session advances with the epoch; other sessions become stale. See [ADR-0010](../decisions/0010-clear-scroll-history.md) for transaction, retention and mobile recovery requirements.
- GET /v1/universe → {universeId, privacyEpoch:number, revision:number, traces:[{eventId,assetId,title,createdAt}], capabilities:{reasoning:false,reels:false,worldEvolution:false}}
- GET /v1/feed → {decisionId, universeId, privacyEpoch:number, accountRevision:number, items:[{assetId,revision:1,kind:"Scroll",title,summary,body,sourceTitle,sourceUrl,truthState:"documented",reason}]} . Bounded 3 candidates. Selection is not exposure.
- POST /v1/exposures body {decisionId,assetId,clientExposureId:UUID} → {exposureId,eventId}. Only after visible display; retry same clientExposureId. First exposure event is retained.
- POST /v1/interactions body {clientEventId:UUID,exposureId,assetId,kind:"keep"} → {eventId,jobId,status:"accepted"}. Same clientEventId is idempotent; conflicting payload returns 409. UI says Kept only after accepted; async projection may lag.
- POST /v1/asks body {clientAskId:UUID,exposureId:UUID,expectedPrivacyEpoch:number,question:string} → 201 {askId,eventId,status:"recorded_only"}. Literal question is nonblank, valid Unicode with no NUL, at most 4096 UTF-8 bytes; route JSON envelope limit 32768 bytes. UUID spelling is canonicalized, question text is preserved exactly. Idempotency is per original session/clientAskId: exact replay returns the same receipt; changed text/exposure conflicts with 409. Expected privacy epoch is checked before replay. A current, same-universe exposed Scroll with unchanged selected asset is required; no same-session exposure provenance is claimed. A changed source requires a new encounter. This stores a private source fact until Clear History; it creates no answer, queue, Job, Trace or provider work. No mobile Ask control is enabled. See [ADR-0016](../decisions/0016-explicit-ask-facts.md).
- GET /v1/events/:eventId → {eventId,causationId:string|null,exposureId:string|null,kind,jobId:string|null,jobStatus:string|null,projected:boolean}

Errors: {error:string}; non-2xx is failure. No server/provider stack traces. No synthetic fallback when unreachable. A retained action becomes a Trace/Relic reference, never an inferred planet or learning claim. API polling universe can observe projection revision after a worker commits. Feed returns a new decision each request and uses Accounts to avoid already-kept content; this is a real deterministic first policy, not the full target Composer.

Unknown, expired, revoked and old-epoch sessions return generic 401. Foreign decisions/exposures fail 422; foreign events return 404. Retained older-epoch references fail 409 before idempotency replay. History clear removes old records, so erased references use the existing missing-reference 422/404 behavior. Epoch-invalidated jobs still present report `jobStatus:"discarded"`, `projected:false`; history clear removes its universe's jobs with the rest of its bootstrap encounter data. Full account deletion, semantic reset and pause personalization remain separate scope.

Mobile reads title/summary/body/sources; Source opens the actual URL. Home begins as an honest empty universe and offers Enter Scroll. After keep, return restores origin and refreshes traces. Show visible connection error/retry. Do not add unavailable Ask/Friends/Reel buttons as fake working features.

## Saved Trace source revisit

`GET /v1/traces/:eventId` follows the strict [source revisit contract](trace-revisit.md). It authorizes the current owner scope, validates the original Keep/exposure/decision lineage and unchanged shared source, and returns a no-store read receipt. It creates no new events. Universe Trace titles now derive from validated selection history; unavailable entries retain a neutral label.
