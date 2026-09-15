# Bootstrap HTTP contract v1

Status: selected for the first executable slice. Local development only until identity and authorization are implemented. This is a real persisted single-owner universe, not sample authentication for deployment.

Base URL: http://127.0.0.1:4310. Android emulator uses http://10.0.2.2:4310. All /v1 endpoints require `Authorization: Bearer <KS_DEV_TOKEN>`. Token is local debug configuration, never committed. JSON uses camelCase, UUID identifiers and ISO timestamps. Backend owns universe identity; clients cannot pick another universe.

- GET /health → {status:"ok", database:true}
- GET /v1/universe → {universeId, revision:number, traces:[{eventId,assetId,title,createdAt}], capabilities:{reasoning:false,reels:false,worldEvolution:false}}
- GET /v1/feed → {decisionId, universeId, accountRevision:number, items:[{assetId,revision:1,kind:"Scroll",title,summary,body,sourceTitle,sourceUrl,truthState:"documented",reason}]} . Bounded 3 candidates. Selection is not exposure.
- POST /v1/exposures body {decisionId,assetId,clientExposureId:UUID} → {exposureId,eventId}. Only after visible display; retry same clientExposureId. First exposure event is retained.
- POST /v1/interactions body {clientEventId:UUID,exposureId,assetId,kind:"keep"} → {eventId,jobId,status:"accepted"}. Same clientEventId is idempotent; conflicting payload returns 409. UI says Kept only after accepted; async projection may lag.
- GET /v1/events/:eventId → {eventId,causationId:string|null,exposureId:string|null,kind,jobId:string|null,jobStatus:string|null,projected:boolean}

Errors: {error:string}; non-2xx is failure. No server/provider stack traces. No synthetic fallback when unreachable. A retained action becomes a Trace/Relic reference, never an inferred planet or learning claim. API polling universe can observe projection revision after a worker commits. Feed returns a new decision each request and uses Accounts to avoid already-kept content; this is a real deterministic first policy, not the full target Composer.

Mobile reads title/summary/body/sources; Source opens the actual URL. Home begins as an honest empty universe and offers Enter Scroll. After keep, return restores origin and refreshes traces. Show visible connection error/retry. Do not add unavailable Ask/Friends/Reel buttons as fake working features.
