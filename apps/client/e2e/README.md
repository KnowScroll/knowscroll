# Browser smoke tests

These tests run Chromium over actual Expo exports. [playwright.config.ts](playwright.config.ts)
starts two private fixture servers: `production` serves `dist/` and `gallery` serves `dist-gallery/`.
The exports use edge-like headers, including CSP. Authored HTTP fixtures stand in for the API;
a browser assertion is not evidence of a real provider, personal activity or dev backend behavior.

The hosted `client` check installs Chromium and builds both exports before
`pnpm --filter @knowscroll/client test:web`. To focus that configured suite, use
`pnpm --filter @knowscroll/client exec playwright test -c e2e/playwright.config.ts --project production account-smoke.spec.ts`.
The build prerequisites still apply. The config refuses focused-only tests, uses one worker and
has zero retries; keep those assertions and failure visibility intact.

Specs cover keyboard/link semantics, responsive layouts, privacy/scope disposal and complete
reader/social/room journeys. Fixtures and videos are supported test inputs, not dead product
content. Production exports must omit gallery and development evidence markers; gallery exports
provide the positive control. The optional native lane owns emulator evidence, not this suite.
