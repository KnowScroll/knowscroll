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
