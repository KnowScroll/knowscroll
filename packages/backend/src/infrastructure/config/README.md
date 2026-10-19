# infrastructure/config

Reads process environment variables once at startup into typed, validated configuration.

- `readApiConfig(env)`, `readWorkerConfig(env)`, `readMigrateConfig(env)`; the variables are
  listed in `docs/v2/engineering/runtime-configuration.md`.
- `readReleaseIdentity(env)`: `NODE_ENV`, `KS_WORLD`, `KS_COMMIT`, `KS_ARTIFACT_SHA256`.
  Production refuses missing or placeholder values; development and test default to `local` /
  `unknown`.
- Failure: one `ConfigurationError` whose `problems` name each variable and the kind of problem.
  Values are never echoed (several variables carry credentials); the processes log
  `config.invalid` and exit with status 1.
- `DatabaseSettings.url` is a credential: pass it only to the driver, never to a log.
