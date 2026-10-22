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

`KS_PLANNER_ENABLED` accepts0/1 and defaults0 in worker configuration (#236). It gates the
personal Planner before any model reservation and does not confer paid allowance. Disabled
work remains durable and resumes only through an explicit same-business-run request.

`KS_CARTOGRAPHER_ENABLED` (#237) accepts0/1 and defaults0. It is a feature gate only. Geography's
worker additionally requires an independently reviewed economic-permit callback, default false;
credentials, flag1 or a deployment never grant paid Cartographer calls. No actual host/env setting
or role allowance is changed by this source declaration.

Connected Cutroom worker source is off by default (`KS_CUTROOM_COMMISSIONING_ENABLED=0`). Enabling
it is permitted only for `dev`/`stage` and requires every explicit dependency:
`KS_CUTROOM_APPROVAL_PACKET` (canonical root-owned non-writable-by-others regular file below
`/etc/knowscroll/`, at most1MiB), fixed HTTP loopback `KS_CUTROOM_ORIGIN`, absolute
`KS_CUTROOM_ARTIFACT_ROOT` and `KS_CUTROOM_MEDIA_ROOT`, reviewed installed
`KS_CUTROOM_EVIDENCE_FUNCTION_SHA256`, and separate `KS_CUTROOM_POOL_DATABASE_URL` (credential,
never printed). The packet contains independently obtained actual complete corpus/individual
human approvals and current installed profile/sole-writer/funds attestations; source does not
create or renew them. SESSION principal/world, current admission generation and exact bound
receipt are checked again by the operation. The flag/configuration alone is never a provider
permit. No API or client activation input is added.
