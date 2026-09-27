# ADR-0034 — Desktop session: an HttpOnly cookie the page never reads, with CSRF on every change

Date: 2026-09-24. Status: accepted — the owner chose this design on 2026-09-24 ("HttpOnly Secure
SameSite=Strict session cookie set by the API on magic-link consumption for the web origin, CSRF on
mutations; web JS never sees a token; Android keeps bearer") for
[#135](https://github.com/KnowScroll/knowscroll/issues/135), parent #72. Builds on ADR-0026
(magic-link single-owner identity) and ADR-0009 (device sessions and privacy epochs); supersedes
ADR-0022's "production web refused until production identity exists" for the web surface.

## Context

The desktop web client never holds a bearer token (`apps/web/src/api/client.ts` states it as an
invariant). In development a same-origin proxy injects the development bearer server-side
(ADR-0022). A real deployment needs the browser to authenticate itself without script ever seeing
a credential, and a cookie that authenticates on its own must not let another site cause changes.

## Decision

1. **Minting.** `POST /v1/auth/web-session {token}` consumes a magic-link sign-in token exactly as
   `POST /v1/auth/session` does (same single-use, rate-limited, indistinguishable-401 rules), mints a
   normal `device_session`, and answers with the session's metadata and a CSRF token but **not**
   the session token. The session token is set as
   `ks_session=<token>; Path=/v1; HttpOnly; Secure; SameSite=Strict; Max-Age=<until expiry>`.
   `POST /v1/auth/session` (bearer, for Android) is unchanged.
2. **Authentication.** Every authenticated route accepts either `Authorization: Bearer` or the
   `ks_session` cookie, through the same `authenticateAndLock` (epoch, revocation, expiry and
   universe lock unchanged). Presenting both is refused (400): a request has one identity.
3. **CSRF.** A request authenticated by the cookie with any method other than GET or HEAD must carry
   `X-CSRF-Token` equal to `HMAC-SHA256(KS_CSRF_SECRET, "csrf:" + hex(SHA-256(session token)))`
   (compared in constant time; the input is the token hash the `device_session` row already
   stores, never the token itself), and
   must be same-origin: an `Origin` header, when present, must equal `KS_WEB_ORIGIN`; when absent,
   `Sec-Fetch-Site` must be `same-origin`. Otherwise 403. The token is not stored; it is derived, so
   it survives reloads and tabs. `GET /v1/session/csrf` returns it to a cookie-authenticated page.
   Bearer requests (Android, the development proxy) need no CSRF token: no browser attaches them.
4. **Sign-out.** `POST /v1/session/revoke` revokes the session and, for a cookie session, clears the
   cookie (`Max-Age=0`). Reset (ADR-0030) already revokes every session, which the cookie cannot
   outlive: authentication re-reads the session row.
5. **Configuration.** `KS_WEB_ORIGIN` (e.g. `https://knowscroll.example`) and `KS_CSRF_SECRET` (32+
   bytes) are required when `NODE_ENV=production`; in development a random secret per process is
   used and the development proxy keeps working unchanged. `Secure` cookies require HTTPS, so the
   production web and API are served same-site over HTTPS.
6. **The link.** With `KS_WEB_ORIGIN` set, the emailed link is `<KS_WEB_ORIGIN>/sign-in#token=<token>`:
   the fragment never reaches a server log or a `Referer`. The page removes it from the address
   bar at once and posts it to `/v1/auth/web-session` only when the person presses "Sign in on this
   browser", so a mail scanner that fetches the page consumes nothing. Without a web origin
   (development without the web app), the link stays the API's read-only confirm URL.

## Alternatives rejected

- A bearer token in `localStorage`: any script injection reads it; the owner ruled it out.
- Double-submit cookie only: a sibling-subdomain cookie write could plant a matching pair; the
  HMAC binds the token to the session server-side without storage.
- `SameSite=Strict` alone: correct in current browsers but not a second, server-checked layer.

## Consequences

`apps/api/src/web-session.ts` (cookie parsing, CSRF derivation and checks), `sign-in-routes.ts` and
`app.ts` wiring, contracts for the new responses, tests for minting, cookie authentication, CSRF
refusal (missing, wrong, cross-origin), both-credentials refusal, revocation and Reset. The web
sign-in page and client CSRF header follow as the client slice.
