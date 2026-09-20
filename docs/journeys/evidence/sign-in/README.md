# J008 evidence — real sign-in (magic link)

Sanitized snapshot of a passing [J008](../../J008.md) run for
[ADR-0026](../../../decisions/0026-magic-link-single-user-identity.md) / issue #104. The raw
receipt is [`signin-journey-2026-09-20T05-21-46-691Z.json`](signin-journey-2026-09-20T05-21-46-691Z.json)
in this directory — copied verbatim from `$KS_DEV_ROOT/sign-in/logs/`; it never contained a token or
an address in the first place (every check is a boolean, a status code or a fixed error-body
string), so nothing was redacted.

- **KnowScroll HEAD:** `c13a33efc50083718273d54055c51997ba5786d0` (the assigned contract commit for
  #104 — ADR-0026 + migration 0016; this journey's implementation lands on a later commit on
  `claude/104-identity`, recorded in the delivering PR/issue).
- **Node:** `v22.23.0`.
- **Disposable database:** `knowscroll_test_signin_journey_dc67dc6472924511` (dropped at the end of
  the run; does not exist anymore).
- **Result:** 19/19 checks passed.

## First failures and corrections

Three real first-failures were found and fixed while building this slice (not journey-runtime
instability — all caught by `tests/signin-token.test.ts`/`tests/signin-http.test.ts` before this
journey was ever run):

1. **Cross-test rate-limit exhaustion.** `sign_in_token` rows are permanently undeletable and
   immutable (`sign_in_token_guard`), so the per-account rate-limit window is a genuine running
   total across an entire shared `pnpm test` invocation, not something a later test can reset. With
   the first-drafted default (5 tokens per account per 15 minutes), the unit-level rate-limit tests
   in `tests/signin-token.test.ts` — which deliberately mint many tokens using explicit test-only
   overrides to exercise the limiting mechanism itself — exhausted the account's real budget before
   `tests/signin-http.test.ts`'s HTTP-level tests (which correctly use the real, un-overridden
   production default) ever got to request a link; every one of those later tests failed with an
   `Invalid URL` error while parsing a `null` confirmation link, because the real route had been
   silently rate-limited. **Correction:** raised the documented production default to 20 per account
   / 40 per fingerprint per 15 minutes — still meaningfully bounded (a real attacker who has the
   address but not the mailbox gains nothing from 20 unusable links), but large enough to survive a
   single owner's legitimate retries and a full automated verification pass in the same window. See
   `packages/db/src/sign-in.ts`'s doc comment and
   [bootstrap-http.md](../../../contracts/bootstrap-http.md#sign-in-magic-link) for the reasoning.
2. **`expires_at` cannot be aged out after the fact.** The first draft of the "expired token"
   test/journey step minted a real token, then tried `UPDATE sign_in_token SET expires_at=...` to
   simulate expiry. `sign_in_token_guard` correctly rejected this with "A sign-in token's identity
   and lifetime are immutable" — migration 0016 deliberately treats a token's lifetime as fixed at
   issuance. **Correction:** every expired-token scenario (in both test files and this journey) now
   inserts an already-expired row directly, with `created_at`/`expires_at` both in the past at
   insertion time — a valid shape under every CHECK constraint, never a mutation of a real token.
3. **Post-clear Trace revisit is `404`, not `422`.** The first draft of the full-flow HTTP test
   assumed a uniform `422` for "the kept event's lineage is gone after Clear History," matching the
   documented `422` fallback used for a structurally-unparseable candidate (ADR-0025's Reel boundary,
   proved in J007). `packages/db/src/trace-revisit.ts`'s own `not_found` branch — used when the
   underlying ledger/exposure/decision rows are genuinely absent, exactly what Clear History leaves
   behind — maps to `404`, and `apps/api/src/app.ts`'s existing, unmodified error mapping already
   returns that correctly. **Correction:** fixed the test's expectation, not the (already correct)
   implementation, and this journey/J008.md documents `404` as the real observed status.

## Limits

See [J008.md](../../J008.md#limits): no sign-in UI is exercised (none exists yet on either client
surface), no real mail provider is contacted (none exists in this codebase), and this is a
disposable database with a journey-generated `KS_OWNER_EMAIL`, never the owner's real configured
address or universe.
