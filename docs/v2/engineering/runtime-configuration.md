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
| `KS_SUPPLY_CREATE_DAILY_CAP` | 20 in `local`, otherwise 0 | how many shared Scroll productions people's requests may start per UTC day (D-037); 0 turns Create off, so a request for missing supply closes as `budget_unavailable`. Set it to the same value as on the worker (max 500) |
| `KS_SUPPLY_PLANNER_CREATE_DAILY_CAP` | 5 | how many productions the Planner's demand may start per UTC day, counted apart from people's asks so it cannot starve them; never above `KS_SUPPLY_CREATE_DAILY_CAP` (0 there turns Create off for both). Set the same value on the API and the worker (max 500) |
| `KS_SUPPLY_ASK_DAILY_CAP` | 20 in `local`, otherwise 0 | how many ask orders (a short Scroll made for one person's question, D-218) Quartermaster may make per UTC day for the whole world, counted from its own ledger apart from every other Create cap; 0 turns ask orders off, and a question from a Scroll then closes as `budget_unavailable` (max 500). Set the same value on the API and the worker |
| `KS_SUPPLY_ASK_PERSON_DAILY_CAP` | 5 | how many ask orders one person may have made per UTC day (1 to 100; D-218). Counted from the person's own requests, so Clear resets it; the world's cap still bounds the spend. Set the same value on the API and the worker |
| `KS_SUPPLY_SCENARIO_DAILY_CAP` | 20 in `local`, otherwise 0 | how many branches of content threads (a What if or an Another perspective) Quartermaster may order per UTC day for the whole world (D-049), counted from its own ledger apart from `KS_SUPPLY_CREATE_DAILY_CAP`; 0 turns scenario Create off, and choosing a direction then answers `budget_unavailable` (max 500). Read by the API only |
| `KS_SUPPLY_SCENARIO_THREAD_DAILY_CAP` | 5 | how many branches one thread may have ordered per UTC day, what-ifs and perspectives together (1 to 100; D-158). It replaces `KS_SUPPLY_SCENARIO_THREAD_CAP`, which is no longer read. Read by the API only |
| `KS_PUBLIC_ORIGIN` | production: **required**; else `http://127.0.0.1:<PORT>` | the world's own origin (`https://app.<world>.knowscroll.space`, D-008): sign-in links point at `<origin>/redeem`, and cookie-authenticated POST/PUT/PATCH/DELETE and socket handshakes must carry this `Origin`. A bare origin; production requires HTTPS except on a loopback host (the release smoke test). HTTPS also makes the session cookie `__Host-ks_session` and Secure (`ks_session` otherwise) |
| `KS_MAIL_SENDER` | `agentmail` | how sign-in mail is sent. `agentmail` (production accepts nothing else) needs `AGENTMAIL_API_KEY` and `AGENTMAIL_INBOX_ID`. `fixture`: CI only, records each mail (to `KS_FIXTURE_MAIL_FILE`, JSON lines, when set); refused unless `NODE_ENV=test` and `KS_WORLD` is `ci` or `local` |
| `AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX_ID` | required for `agentmail` | credentials (server: `/etc/knowscroll/secrets/shared/agentmail.env`, read by the API unit only). Never logged |
| `AGENTMAIL_TIMEOUT_MS` | 10000 (max 30000) | one send's whole exchange, response body included |
| `AGENTMAIL_BASE_URL` | `https://api.agentmail.to` | a different base only outside production (tests with a fake AgentMail); production refuses it |
| `KS_ALLOW_OPERATOR_SIGN_IN` | unset | exactly `1` lets operator-minted links (`dist/operator.js`) be redeemed; any other value is refused, and so is `1` in every world but `dev`, `stage`, `ci` and `local` (an allow-list: a production world under any name is refused) |
| `KS_OPERATOR_ACCOUNTS` | unset | who may use the operator routes and the Operator screen (D-044): comma-separated addresses, each exact or with one `*` in the local part, lower case, at most 20. Unset: on `dev` with operator sign-in on, the `KS_OPERATOR_SIGN_IN_PATTERN`; elsewhere nobody. A `*` is refused on `live`. Read when the API starts |
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
| `KS_REASONING_PRODUCTION_ENABLED` | `0` | Worker-only nonpersonal Scroll supply grant (`0`/`1`). The database `scroll-supply` root must independently be enabled with the claimed generation. No provider activation. |
| `KS_REASONING_PROVIDER` | `none` | the reasoning harness's model provider (S2.2). `none`: every `propose` is refused (`provider_unavailable`) before anything is reserved. `minimax`: the MiniMax token plan; any other value is refused at startup |
| `MINIMAX_API_KEY` | required with `minimax`, otherwise unused | the token-plan key; must look like `sk-cp-…` (a pay-as-you-go key is refused: `invalid_format`). A credential: never logged, never in a problem message, never reaches the API (server: `/etc/knowscroll/secrets/shared/minimax.env`, an `EnvironmentFile=` of `ks2-worker@` only) |
| `KS_MINIMAX_MODEL` | `MiniMax-M3.1-Flash` | one of `MiniMax-M3.1-Flash`, `MiniMax-M3`, `MiniMax-M2.7`, `MiniMax-M2.7-highspeed` (`MiniMax-M3.1-Flash-Preview` is not on the token plan). Recorded on every attempt |
| `KS_MINIMAX_REQUEST_TIMEOUT_MS` | 240000 (max 300000) | one request's whole exchange; a timeout after the request left is `unknown`, never resent. `MiniMax-M3.1-Flash` thinks before it answers: a Scroll writer request took up to 126 s and a Planner request up to 225 s, so keep it at 240000 or more (the Planner needs 300000) |
| `KS_MINIMAX_QUOTA_FLOOR_PERCENT` | 25 (1–100) | both quota windows must have at least this much remaining before an attempt is dispatched; ambiguous quota fails closed. 0 is refused: it would switch the check off |
| `KS_REASONING_GLOBAL_REQUESTS_PER_DAY`, `KS_REASONING_GLOBAL_TOKENS_PER_DAY` | 300, 3,000,000 | daily caps (UTC day) for the whole process, counted from the minimal usage receipts |
| `KS_REASONING_ROLE_REQUESTS_PER_DAY`, `KS_REASONING_ROLE_TOKENS_PER_DAY` | 200, 2,000,000 | default daily caps per role, across universes (a role may declare its own) |
| `KS_REASONING_SCOPE_REQUESTS_PER_DAY`, `KS_REASONING_SCOPE_TOKENS_PER_DAY` | 60, 600,000 | daily caps per personal scope (one universe) |
| `KS_REASONING_BACKGROUND_SHARE_PERCENT` | 50 (0–100) | the share, in whole percent, of the global cap and of each person's cap (requests and tokens) that background roles (Jev, Cartographer, Planner: they run because a person read or swiped) may use together. The rest is kept for what a person asks for: What-if, a room ask, request matching, Scroll production. A background role past its share is refused as `budget_exhausted` (`background_global` or `background_scope`) and falls back: Jev to the deterministic ranking, the Cartographer to the rules, the Planner to its next run. 0 switches background roles off; 100 keeps nothing back (D-058) |
| `KS_REASONING_ROOM_ENABLED` | `0` | Residents may speak unprompted (v3 R-2, D-162). Read by the worker (the room scope's grant and the `rooms.cast-due`, `rooms.cast-pass`, `rooms.summarise` and `rooms.nightly-rituals` consumers, the last drafting each room's daily items for an operator, D-176) and by the API (a message queues the resident check, and a return after a long absence queues "while you were away", only when it is on). The database `rooms` root (`reasoning.production_scopes`) is enabled by migration 0071 and is the operator's fence. No provider activation |
| `KS_MEDIA_ROOT` (worker operator) | none | An absolute path. `rooms backdrop` stores the painted stills there (v3 R-4, D-166); without it no picture can be made and every other `rooms` command still works. The API reads the same variable to serve approved backdrops at `/media/room/<sha256>`. The image route uses the text model's key (`MINIMAX_API_KEY`, `KS_REASONING_PROVIDER=minimax`); the $1 cap and the per-image price are code, not settings |
| `KS_ROOMS_FEED_ENABLED` | `0` | Residents post finds about library assets and keep the room's memory current on a heartbeat (v3 R-8, D-248). Read by the worker only: with it on **and** `KS_REASONING_ROOM_ENABLED=1` the `rooms.feed-heartbeat` consumer (cron `7 0,8,16 * * *`) is registered and each open room with someone listening gets one look three times a day; either off, it is not. The calls are paid by the `rooms` scope as `ambient` roles, so the room scope's and the ambient share's caps bound them, and a look with nothing new, nothing due or nobody listening makes none. Off by default, also on dev, until an operator turns it on |
| `KS_ROOMS_SCOUTS_ENABLED` | `0` | Members may send a scout into a room, which posts at most one find a day, signed by its owner (v3 R-9, D-259 to D-261). Read by the API (the Feed shows the sheet and accepts the command only when it is on) and by the worker (the `rooms.scout-heartbeat` consumer, cron `37 0,8,16 * * *`, is registered only with it on **and** `KS_REASONING_ROOM_ENABLED=1`). The calls are paid by the `rooms` scope as `ambient` roles and a look with nothing to say makes none. Off by default, also on dev, until the residents have run for a week; an operator turns it on |
| `KS_REASONING_ROOM_GENERATION` | 1 | the generation of the `rooms` root the resident jobs run under (worker); it must match the database root |
| `KS_ROOMS_LAUNCH_GAP_MINUTES` | 120 | The rest between the start of one Launch and the next in a room (v3 R-6, D-178), in minutes from 1 to 1440. Read by the API, where a Launch is started. Two hours is R3's rule; a dev world may lower it so a journey can play more than one in a sitting. Not a model cap: a Launch calls no model |
| `KS_ROOMS_STARS_PER_DAY` | 3 | The most stars one room earns on a UTC day (v3 R-5, D-174), from 1 to 50. Read by the API, where the act that earns a star is decided. Three is the design's anti-farm rule; a dev world may raise it so a journey can fill a constellation in a day. Not a model cap: no call is involved |
| `KS_REASONING_ROOM_REQUESTS_PER_DAY`, `KS_REASONING_ROOM_TOKENS_PER_DAY` | 100, 1,000,000 | daily caps for the nonpersonal `rooms` scope instead of the per-person caps: all rooms' residents speaking on their own spend from it. The global, role and ambient-share caps still apply. Asked turns are on the asker's own scope and never depend on it |
| `KS_REASONING_AMBIENT_SHARE_PERCENT` | 30 (0–100) | the share, in whole percent, of the global cap (requests and tokens) that ambient roles (residents speaking on their own) may use together, so the rest is always there for what a person asks for. 0 switches residents off, 100 keeps nothing back |
| `KS_REASONING_PRODUCTION_REQUESTS_PER_DAY`, `KS_REASONING_PRODUCTION_TOKENS_PER_DAY` | 200, 3,000,000 | daily caps for the nonpersonal production scope (`scroll-supply`) instead of the per-person caps: seeding the library takes about 70 writer requests and 1.4M tokens, and Create jobs add more. The global and role caps still apply, and the worker and the production operator commands both use these |
| `KS_SCROLL_PRODUCTION_GENERATION` | 1 | the production scope generation the `content.produce-scroll` consumer works under; it must match the database root |
| `KS_SUPPLY_CREATE_DAILY_CAP` | 20 in `local`, otherwise 0 | how many shared Scroll productions Quartermaster's Create may start per UTC day for people's asks (the worker commissions for an ask the resolver finds without a production; the API takes the request itself); 0 turns Create off, and a request for missing supply then closes as `budget_unavailable`. Set the same value on both processes (max 500) |
| `KS_SUPPLY_PLANNER_CREATE_DAILY_CAP` | 5 | the part of that cap the Planner's demand may use (see the API row); the worker counts the Planner's productions against it |
| `KS_REASONING_MAX_REQUEST_BYTES` | 262144 (max 262144) | largest request body; a larger one is refused (`request_too_large`) before anything is written |
| `KS_REASONING_REQUEST_RETENTION_HOURS` | 48 (max 720) | how long the protected request bytes are kept before the scheduled purge deletes them |

A reservation charges one request and `request bytes + max output tokens` tokens against all three
caps (and, for a background role, against its share of the global and the person's cap); the provider's
reported usage replaces the estimate at settlement. Details:
`packages/backend/src/reasoning/README.md`.

## Worker operator (`node dist/operator.js reasoning …` in the `worker/` tree)

| Variable | Default | Meaning |
|---|---|---|
| `KS_WORLD` | required | world name (in diagnostics and the connection's `application_name`) |
| `DATABASE_URL` | required | the world's database (credential) |
| `KS_DB_STATEMENT_TIMEOUT_MS` | 30000 | per-statement timeout |

Subcommands: `reasoning write-off --attempt <uuid> --reason <text>`, `reasoning unknown [--limit n]`,
`reasoning sweep-dispatched [--older-than-seconds n]`, `reasoning purge-expired`, `reasoning rejected [--limit n | --attempt <uuid>]` (refused answers of Scroll production, kept 30 days). It needs no provider key and no `KS_PUBLIC_ORIGIN`. One JSON result line on
stdout, diagnostic records on stderr. Exit 0 done, 2 refused or not applicable, 1 failure. The API
tree's `dist/operator.js` is a different command (`issue-sign-in`). Running it on a world:
`docs/v2/operations/environments.md`.

## Journey inspector (`node dist/operator.js journey …` in the `worker/` tree)

`KS_WORLD` and `DATABASE_URL` only. Read-only; it prints IDs, states, codes and times. See
`docs/v2/operations/looking-at-the-system.md`.

## Library production operator (`node dist/operator.js content …` in the `worker/` tree)

| Variable | Default | Meaning |
|---|---|---|
| `KS_WORLD` | required | only `dev`, `stage`, `ci` or `local`; refused before the database is touched |
| `DATABASE_URL` | required | the world's database (credential) |
| `KS_DB_STATEMENT_TIMEOUT_MS` | 15000 | as for the API |

`produce-library [--only <keys>] [--interactive-first] [--dry-run]` sends the `content.produce-scroll`
jobs of recipes that need one, and `production-status [--only <keys>]` lists every recipe's standing.
Neither calls a provider or needs a key. `admit-continuity [--dry-run]` admits the library plan's series and
related moves between published Scrolls (D-059); it also needs only `KS_WORLD` and `DATABASE_URL`. `produce-scroll --topic <key> [--take <1-3>] [--dry-run]
[--resume]` runs one job directly and needs the worker's reasoning variables
(`KS_REASONING_PROVIDER=minimax`, `MINIMAX_API_KEY`, `KS_REASONING_PRODUCTION_ENABLED=1`,
`KS_SCROLL_PRODUCTION_GENERATION`, and the production caps). One JSON line on stdout, diagnostics on
stderr. Exit 0 done, 2 refused or not applicable, 1 failure. Steps: `docs/v2/operations/scroll-production.md`.

`scenes backfill-looks [--dry-run] [--limit <1-1000>]` gives worlds projected before looks existed their look (D-102): one
`scenes.backfill-looks` job for each universe that lacks some, which the worker runs under that universe's lock. Needs
only `KS_WORLD` and `DATABASE_URL`, calls no provider and moves no slot, seed, family or anchor. Run it once after the
release that adds the table is on the world, with `--dry-run` first; run it again while it reports `"more":true`. Run it from the world's worker tree as the other operator commands are (`docs/v2/operations/environments.md`).

## Migrate (`node dist/migrate.js` in the `api/` tree)

| Variable | Default | Meaning |
|---|---|---|
| `KS_WORLD` | required | world name (in diagnostics and the connection's `application_name`) |
| `DATABASE_URL` | required | a role that owns the world's schemas |
| `KS_DB_STATEMENT_TIMEOUT_MS` | 900000 | per-statement timeout for migrations |

Applies pending migrations from the static registry, installs or upgrades pg-boss's `pgboss`
schema, applies every declared queue's policy, rebuilds the `ops` views that read pg-boss's tables and
grants the read-only `ks2_ops_reader` role the views (a missing role is only a `migrate.warning`). Exit 0 means the database is ready for this
release. Migrations are forward-only; recovery is restoring the verified pre-migration backup
(CF-27).

## Exit codes and signals

API and worker exit 0 after a clean stop on SIGTERM/SIGINT, and 1 on invalid configuration,
failed start, failed or overdue stop, or an unhandled error. Output is JSON diagnostic records on
stdout only (journald), one per line.

`KS_PLANNER_ENABLED` (worker, 0/1; default 1 in world `local`, otherwise 0; dev sets 1): run the personal
Planner. With `MiniMax-M3.1-Flash` it needs `KS_MINIMAX_REQUEST_TIMEOUT_MS=300000`. Disabled jobs remain blocked without model reservation; explicit typed
`RequestPlanner` with `resumeRunId` resumes the same business run. This does not alter reasoning
caps, quota or failure-brake policy and does not grant permission to use the #232 allowance.

`KS_COMPOSER_POLICY` (API and worker, `v0` or `v1`, default `v0`; any other value is refused at start): the Composer policy
that new decisions are made under (D-190). The API ranks a navigation under it and the worker ranks the buffer under it, so
set both processes of a world alike (they read one environment file). The numbers of `v1` were chosen from `composer replay-policy` on dev (D-190), and dev sets `v1`; other worlds stay `v0` until they
are set. A stored decision replays under the policy it names,
whatever this is set to, so switching back and forth strands nothing, and `composer replay-policy` always replays both.

`KS_JEV_ENABLED` (worker, 0/1, default 0): enable Jev, the optional semantic assessment run by the
Composer `composer.prepare-buffer` job on the shared reasoning harness. Set it to 1 on dev. It needs a
configured reasoning provider; without one Jev is simply absent and buffers are still prepared. It does
not change reasoning caps, quota or failure-brake policy. Jev is a background role: it spends only its
share (`KS_REASONING_BACKGROUND_SHARE_PERCENT`), and it asks about a candidate at most once in 30 minutes
per person and subject, and at most once per 10 minutes per subject (D-058).
