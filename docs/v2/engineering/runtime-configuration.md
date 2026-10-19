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
| `KS_AUTH_ADAPTER` | `none` | how callers are authenticated. `none`: no caller, every personal route answers 401 (until S1.3 sessions). `test-bearer`: CI only, trusts `Authorization: Bearer test.<accountId>` (and the Socket.IO `auth.token` `test.<accountId>`); refused at startup unless `NODE_ENV=test` **and** `KS_WORLD` is `ci` or `local` |
| `KS_SOCKET_AUTH_CACHE_MS` | 30000 (max 30000) | how long a socket's authorisation (session validity and scope access) may be reused before a relayed hint rechecks it; cleared whenever the relay reconnects |

The API also opens one dedicated LISTEN connection (`application_name` `knowscroll-api-<world>-relay`)
and serves Socket.IO on `/socket.io` on the same port (D-008: Caddy proxies `/socket.io/*` with
WebSocket upgrade).

`GET /health` answers `{status: "ok", world, commit, artifact, migration, relay}`, where
`migration` is the newest applied migration name or `none` and `relay` is `listening` or
`reconnecting` (live hints paused; clients still catch up by revision). A 200 also proves the
database answers. Monitoring (S1.5) should alert when `relay` stays `reconnecting`. A retryable
failure (lock wait, timeout, deadlock, serialisation) answers 503 with `Retry-After: 1`.

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
