# infrastructure/config

Reads process environment variables once at startup into typed, validated configuration.

- `readApiConfig(env)`, `readWorkerConfig(env)`, `readMigrateConfig(env)`, `readOperatorConfig(env)`;
  the variables are listed in `docs/v2/engineering/runtime-configuration.md`. The API's sign-in
  settings (`ApiConfig.identity`, S1.3): production refuses to start unless mail goes through a
  fully configured AgentMail; test-only adapters (the `fixture` mail sender, the `test-bearer`
  caller) are refused outside `NODE_ENV=test` in a `ci`/`local` world; `KS_ALLOW_OPERATOR_SIGN_IN`
  is unset or exactly `1`, never in `live`.
- `readReleaseIdentity(env)`: `NODE_ENV`, `KS_WORLD`, `KS_COMMIT`, `KS_ARTIFACT_SHA256`.
  `KS_WORLD` is required in every `NODE_ENV` and by `readMigrateConfig` too (a missing world never
  becomes `local`, which would allow test-only adapters). Production refuses missing or
  placeholder commit and artifact values; development and test default them to `unknown`.
- Failure: one `ConfigurationError` whose `problems` name each variable and the kind of problem.
  Values are never echoed (several variables carry credentials); the processes log
  `config.invalid` and exit with status 1.
- `DatabaseSettings.url` is a credential: pass it only to the driver, never to a log.

Nonpersonal reasoning production is worker-only and defaults disabled.
`KS_REASONING_PRODUCTION_ENABLED` accepts only `0`/`1`; `1` is a configuration grant, still subject
to the separate database root's enabled/generation checks. No provider is enabled by this flag.

`readScrollProductionOperatorConfig` first applies the content operator world allowlist, then reads
the worker's reasoning transport/caps and scope-lock timeout. It does not require release identity
or personal identity. Both configuration and the database production root still default disabled;
this parser does not mint a production grant.

`KS_PLANNER_ENABLED` accepts 0/1. It defaults to 1 in world `local` and to 0 in every other world; the
dev world sets 1 in its environment file (#236, D-035). It gates the personal Planner before any model
reservation and does not confer paid allowance. Disabled
work remains durable and resumes only through an explicit same-business-run request.

`KS_COMPOSER_POLICY` (v3 S-5, D-190) accepts `v0` or `v1` and defaults to `v0` in both the API and the worker configuration (`composerPolicy`).
It decides which Composer policy new decisions are made under; replay of a stored decision never reads it.

`KS_JEV_ENABLED` (#234) accepts 0/1 and defaults 0 in worker configuration. It switches on Jev, the
optional semantic assessment in the Composer buffer job. Off, the job still prepares buffers from the
deterministic ranking and makes no model call. Dev sets it to 1. It does not change reasoning caps.

`KS_REASONING_BACKGROUND_SHARE_PERCENT` (#231, D-058) is a whole number from 0 to 100, default 50. It is the
share of the global cap and of each person's cap that background roles (Jev, Cartographer, Planner) may use
together; the rest is kept for roles a person asks for. 0 switches background roles off, 100 keeps nothing
back. It is a reasoning variable: the worker and the Scroll production operator read it with the caps.

`KS_REASONING_ROOM_ENABLED` (v3 R-2, D-162) accepts 0/1 and defaults 0. On, the AI residents of a room may speak
without being asked, under the nonpersonal `rooms` reasoning scope: its own daily caps
(`KS_REASONING_ROOM_REQUESTS_PER_DAY`, `KS_REASONING_ROOM_TOKENS_PER_DAY`) and the `ambient` share of the global cap
(`KS_REASONING_AMBIENT_SHARE_PERCENT`, default 30). The API reads it to queue the resident check when a message reads as a
question or a strong claim, and the worker reads it to run the check and the model call. Off, no job is queued and no
resident speaks unprompted; asked turns are unchanged. The router's own caps (one turn per three human messages, 8 an
hour, 40 a day, per resident, per person) are code, not configuration (D-164).

`KS_CARTOGRAPHER_ENABLED` (#237) accepts 0/1 and defaults 0. Set it to 1 on the worker to let
reading form places (D-038). It is the only switch of the role: spend is bounded by the shared
reasoning budgets and the role's failure brake, not by a second permit. The role needs
`KS_REASONING_PROVIDER=minimax` and `MINIMAX_API_KEY` on that worker. With a provider, code still
forms every place the rules entitle when the model fails or answers badly. Without one, or with the
switch off, no model run starts: a claimed run applies the rules (provider missing) or is released
(`disabled`), and later reading starts a new run, so nobody is stranded.

The Reel operator commands (`readReelOperatorConfig`, `dist/operator.js reel …`) read the media-import
settings (`KS_MEDIA_ROOT`, loopback `KS_CUTROOM_ORIGIN`, `KS_CUTROOM_ARTIFACT_ROOT`, optional
`KS_FFPROBE_PATH`) and the shared pool. The pool is `KS_POOL_DATABASE_URL` (a credential, never
printed) or, when unset, the world's own `DATABASE_URL` with its database name replaced by
`knowscroll_pool`. Refused outside the operator worlds. The worker service reads none of these: it
orders nothing.
