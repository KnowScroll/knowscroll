# Runtime configuration

Every process validates its environment once at startup (`packages/backend/src/infrastructure/config`).
An invalid environment logs `config.invalid` (variable names and problem kinds, never values)
and exits with status 1. Secrets reach the process only through its environment file; never
print them.

## Release identity (API and worker)

| Variable | Production | Development/test default | Meaning |
|---|---|---|---|
| `NODE_ENV` | `production` | `development` | `test` is required (with `KS_WORLD` `ci` or `local`) by any test-only adapter; production refuses them all |
| `KS_WORLD` | required, `^[a-z][a-z0-9-]{0,31}$` | **required** (no default) | world name reported by `/health` and in every diagnostic record; a missing world never becomes `local`, so it cannot enable test-only adapters. Local runs set `KS_WORLD=local`, CI sets `ci` |
| `KS_COMMIT` | required, 40 lowercase hex | `unknown` | commit the release was built from |
| `KS_ARTIFACT_SHA256` | required, 64 lowercase hex | `unknown` | SHA-256 of the release artifact, reported by `/health` |

## API (`node dist/main.js` in the `api/` tree)

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | required | `postgres://` URL of the world's database (credential) |
| `PORT` | required | listen port |
| `KS_LISTEN_HOST` | `127.0.0.1` | listen address (Caddy proxies to loopback) |
| `KS_DB_POOL_MAX` | 10 | pool size |
| `KS_DB_STATEMENT_TIMEOUT_MS` | 15000 | per-statement timeout; idle-in-transaction timeout is twice this (≥ 60 s) |
| `KS_BODY_LIMIT_BYTES` | 65536 | JSON body limit; larger bodies get a 413 problem |
| `KS_SHUTDOWN_GRACE_SECONDS` | 20 | longest graceful stop before exit 1 |
| `KS_SCOPE_LOCK_TIMEOUT_MS` | 5000 | longest wait for a personal-scope lock before a retryable 503; must be below `KS_DB_STATEMENT_TIMEOUT_MS` |
| `KS_AUTH_ADAPTER` | `session` | how callers are authenticated. `session`: identity's sessions (S1.3, D-022) — the web session cookie or `Authorization: Bearer kss_…` (and the Socket.IO `auth.token`). `test-bearer`: CI fixture that trusts `Authorization: Bearer test.<accountId>` (and the Socket.IO `auth.token` `test.<accountId>`); refused at startup unless `NODE_ENV=test` **and** `KS_WORLD` is `ci` or `local` |
| `KS_SOCKET_AUTH_CACHE_MS` | 30000 (max 30000) | how long a socket's authorisation (session validity and scope access) may be reused before a relayed hint rechecks it; cleared whenever the relay reconnects |
| `KS_PUBLIC_ORIGIN` | production: **required**; else `http://127.0.0.1:<PORT>` | the world's own origin (`https://app.<world>.knowscroll.space`, D-008): sign-in links point at `<origin>/redeem`, and cookie-authenticated POST/PUT/PATCH/DELETE and socket handshakes must carry this `Origin`. A bare origin; production requires HTTPS except on a loopback host (the release smoke test). HTTPS also makes the session cookie `__Host-ks_session` and Secure (`ks_session` otherwise) |
| `KS_MAIL_SENDER` | `agentmail` | how sign-in mail is sent. `agentmail` (production accepts nothing else) needs `AGENTMAIL_API_KEY` and `AGENTMAIL_INBOX_ID`. `fixture`: CI only, records each mail (to `KS_FIXTURE_MAIL_FILE`, JSON lines, when set); refused unless `NODE_ENV=test` and `KS_WORLD` is `ci` or `local` |
| `AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX_ID` | required for `agentmail` | credentials (server: `/etc/knowscroll/secrets/shared/agentmail.env`, read by the API unit only). Never logged |
| `AGENTMAIL_TIMEOUT_MS` | 10000 (max 30000) | one send's whole exchange, response body included |
| `AGENTMAIL_BASE_URL` | `https://api.agentmail.to` | a different base only outside production (tests with a fake AgentMail); production refuses it |
| `KS_ALLOW_OPERATOR_SIGN_IN` | unset | exactly `1` lets operator-minted links (`dist/operator.js`) be redeemed; any other value is refused, and so is `1` in every world but `dev`, `stage`, `ci` and `local` (an allow-list: a production world under any name is refused) |
| `KS_NATIVE_SIGN_IN_BINDING` | unset (off) | exactly `1` lets native apps bind their links with a code challenge; off on every world until the native app ships, and while off `POST /auth/sign-in` with `codeChallenge` answers 422 (re-review N1; what must change before enabling it: `modules/identity/README.md`) |
| `KS_OPERATOR_SIGN_IN_PATTERN` | required with `KS_ALLOW_OPERATOR_SIGN_IN=1` | the disposable addresses operator links may open, as one address with at most one `*` in the local part and a literal domain (dev and stage: `*@test.knowscroll.space`); an operator link for any other address is refused when redeemed |

Every account request (`/v1/*`, checked by one guard in front of every route; opt-outs only through
`UNSCOPED_V1_ROUTES` in the contracts) must carry `X-KS-Scope: <accountId>:<privacyEpoch>` and every
Socket.IO handshake the same value in `auth.scope`; no credential is `401 UNAUTHENTICATED`, and a
claim that is missing or names another account or an older epoch than the presented session's is
refused with `409 SCOPE_MISMATCH` (handshake: `SCOPE_MISMATCH`). Every API answer carries `Content-Security-Policy: default-src
'none'; frame-ancestors 'none'; base-uri 'none'`, `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`; the web app's own policy is
set by Caddy (`ops/vps/ansible/roles/caddy/files/app-content-security-policy.txt`).

The API also opens one dedicated LISTEN connection (`application_name` `knowscroll-api-<world>-relay`)
and serves Socket.IO on `/socket.io` on the same port (D-008: Caddy proxies `/socket.io/*` with
WebSocket upgrade).

`GET /health` answers `{status: "ok", world, commit, artifact, migration, relay}`, where
`migration` is the newest applied migration name or `none` and `relay` is `listening` or
`reconnecting` (live hints paused; clients still catch up by revision). A 200 also proves the
database answers. Monitoring (S1.5) should alert when `relay` stays `reconnecting`. A retryable
failure (lock wait, timeout, deadlock, serialisation) answers 503 with `Retry-After: 1`.

## Operator sign-in (`node dist/operator.js issue-sign-in --email <address>` in the `api/` tree)

| Variable | Default | Meaning |
|---|---|---|
| `KS_WORLD` | required | only `dev`, `stage`, `ci` or `local`; any other world is refused |
| `KS_ALLOW_OPERATOR_SIGN_IN` | required, exactly `1` | anything else is refused (checked at startup and again just before issuing) |
| `KS_OPERATOR_SIGN_IN_PATTERN` | required | as for the API; an address it does not match is refused (`address_not_allowed`) |
| `DATABASE_URL` | required | the world's database (credential) |
| `KS_PUBLIC_ORIGIN` | required | the origin the printed link points at |
| `KS_DB_STATEMENT_TIMEOUT_MS`, `KS_SCOPE_LOCK_TIMEOUT_MS` | 15000, 5000 | as for the API |

Prints the one-time link on stdout; diagnostic records go to stderr. Exit 0 issued, 1 refused or
failed, 2 usage. It creates or reuses a **disposable** account and refuses an address that signed up
by mail (`not_disposable`). Each issue writes an audit row in `ops.operator_sign_ins` (world, time,
`cli:<SUDO_USER or USER>`, account). Running it on a world: `docs/v2/operations/environments.md`.

## Operator content import (`node dist/operator.js content import-editorial --file <path>` in the `api/` tree)

| Variable | Default | Meaning |
|---|---|---|
| `KS_WORLD` | required | only `dev`, `stage`, `ci` or `local`; any other world (live under any name) is refused before the database is touched |
| `DATABASE_URL` | required | the world's database (credential) |
| `KS_DB_STATEMENT_TIMEOUT_MS` | 15000 | as for the API |

Admits an authored editorial Scroll (D-005): an `editorial-scroll.v1` JSON file, compiled and admitted
through scroll-model's admission path, stored as an immutable revision labelled `authored_editorial` with its
internal provenance in a separate table. The same file is the same revision (`unchanged`); a changed file is
a new revision. It needs no sign-in settings and touches no person's data (content is shared). One JSON line
on stdout (`outcome`, `assetId`, `revision`, `documentSha256`, `path`), diagnostics on stderr
(`content.scroll_admitted`; a refusal adds its stage and issue codes and paths, never source text). Exit 0
admitted or unchanged, 1 refused or failed, 2 usage. The release tree carries the starter at
`node_modules/@knowscroll/backend/dist/modules/content/starter/why-the-sky-is-blue.editorial-scroll.json`.

## Worker (`node dist/main.js` in the `worker/` tree)

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | required | as above |
| `KS_DB_POOL_MAX` | 5 | pool size (pg-boss keeps its own small pool) |
| `KS_DB_STATEMENT_TIMEOUT_MS` | 15000 | as above |
| `KS_SHUTDOWN_GRACE_SECONDS` | 20 | how long running handlers may finish after SIGTERM |
| `KS_SCOPE_LOCK_TIMEOUT_MS` | 5000 | longest wait for a personal-scope lock (the job is retried); must be below `KS_DB_STATEMENT_TIMEOUT_MS` |

## Migrate (`node dist/migrate.js` in the `api/` tree)

| Variable | Default | Meaning |
|---|---|---|
| `KS_WORLD` | required | world name (in diagnostics and the connection's `application_name`) |
| `DATABASE_URL` | required | a role that owns the world's schemas |
| `KS_DB_STATEMENT_TIMEOUT_MS` | 900000 | per-statement timeout for migrations |

Applies pending migrations from the static registry, installs or upgrades pg-boss's `pgboss`
schema and applies every declared queue's policy. Exit 0 means the database is ready for this
release. Migrations are forward-only; recovery is restoring the verified pre-migration backup
(CF-27).

## Exit codes and signals

API and worker exit 0 after a clean stop on SIGTERM/SIGINT, and 1 on invalid configuration,
failed start, failed or overdue stop, or an unhandled error. Output is JSON diagnostic records on
stdout only (journald), one per line.
