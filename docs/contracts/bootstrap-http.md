# Bootstrap HTTP contract v1

Status: local development only. [ADR-0009](../decisions/0009-device-sessions-and-privacy-epochs.md) defines operator-provisioned device sessions and privacy epoch fences; production login and public enrollment remain future work.

Base URL: http://127.0.0.1:4310. Android emulator uses http://10.0.2.2:4310. All /v1 endpoints require `Authorization: Bearer <session token>`. The existing `KS_DEV_TOKEN` enrolls once as an ordinary expiring, revocable owner session. Tokens are local configuration, never committed. JSON uses camelCase, UUID identifiers and ISO timestamps. Backend resolves universe identity from the session; clients cannot pick another universe.

- GET /health → {status:"ok", database:true}
- GET /v1/session → {sessionId,deviceId,universeId,privacyEpoch:number,expiresAt}
- POST /v1/session/revoke body {} → 204. Revokes only the authenticated session. Restart does not restore it.
- GET /v1/universe → {universeId, privacyEpoch:number, revision:number, traces:[{eventId,assetId,title,createdAt}], capabilities:{reasoning:false,reels:false,worldEvolution:false}}
- GET /v1/feed → {decisionId, universeId, privacyEpoch:number, accountRevision:number, items:[{assetId,revision:1,kind:"Scroll",title,summary,body,sourceTitle,sourceUrl,truthState:"documented",reason}]} . Bounded 3 candidates. Selection is not exposure.
- POST /v1/exposures body {decisionId,assetId,clientExposureId:UUID} → {exposureId,eventId}. Only after visible display; retry same clientExposureId. First exposure event is retained.
- POST /v1/interactions body {clientEventId:UUID,exposureId,assetId,kind:"keep"} → {eventId,jobId,status:"accepted"}. Same clientEventId is idempotent; conflicting payload returns 409. UI says Kept only after accepted; async projection may lag.
- GET /v1/events/:eventId → {eventId,causationId:string|null,exposureId:string|null,kind,jobId:string|null,jobStatus:string|null,projected:boolean}

Errors: {error:string}; non-2xx is failure. No server/provider stack traces. No synthetic fallback when unreachable. A retained action becomes a Trace/Relic reference, never an inferred planet or learning claim. API polling universe can observe projection revision after a worker commits. Feed returns a new decision each request and uses Accounts to avoid already-kept content; this is a real deterministic first policy, not the full target Composer.

Unknown, expired, revoked and old-epoch sessions return generic 401. Foreign decisions/exposures fail 422; foreign events return 404. Older-epoch references fail 409 before idempotency replay. Epoch advancement has no HTTP endpoint in this slice. Jobs invalidated by an epoch change report `jobStatus:"discarded"`, `projected:false`; this does not implement clear/delete/pause.

Mobile reads title/summary/body/sources; Source opens the actual URL. Home begins as an honest empty universe and offers Enter Scroll. After keep, return restores origin and refreshes traces. Show visible connection error/retry. Do not add unavailable Ask/Friends/Reel buttons as fake working features.
