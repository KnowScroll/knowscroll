# API ownership

Own admission, authorization, idempotent events and response contracts. No model or Cutroom calls in request handlers. Selection is not exposure. Event + job admission is one SQL transaction. Current bearer identity is local development only and binds one server-owned universe; production deployment is blocked pending real identity and ownership authorization. Validate strict input and reject idempotency-key payload conflicts. Read docs/contracts/bootstrap-http.md before changing mobile-facing JSON.
