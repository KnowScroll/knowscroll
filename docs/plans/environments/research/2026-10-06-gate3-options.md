# Gate 3 options research (2026-10-06)

The owner asked for Gate 3's least-confident items 1–3 to be researched, and for ideas that make
the setup faster and more stable. Items 4–7 were accepted as written. Everything below was either
measured on 2026-10-06 or read from official docs that day; each claim says which.

## 1. Android: product flavours, not build types (recommendation changed)

**What the official docs say** (developer.android.com/build/build-variants, read 2026-10-06):

- Build types define *how* the app is built: debug vs release, signing, optimisation.
- Product flavours define *which version* of the app it is: different endpoints and
  `applicationIdSuffix`.
- Variants are build types × flavours. Unwanted combinations are switched off with
  `androidComponents.beforeVariants { enable = false }`.

**Why Gate 3 chose build types:** adding flavours renames Gradle tasks (`assembleDebug` →
`assembleLocalDebug`) and APK paths, which breaks existing scripts.

**What that really costs (measured):** **12 files**: 11 `scripts/android-*.py` journeys plus
`.github/workflows/checks.yml`. That is 36 task references (`assembleDebug` ×12,
`assembleDebugAndroidTest` ×10, `testDebugUnitTest` ×7, `lintDebug` ×7) and 16 APK paths. The
update is mechanical: one find-and-replace, verified by running one Android journey.

**What build types would have cost:**
- Dev and stage builds would be release-shaped: minified and not debuggable.
- The agent could not attach a debugger, read app data with `run-as`, or run instrumented tests
  against the real dev server, because Android runs instrumented tests on the `debug` build type
  only.

**Recommendation:** one flavour dimension, `world`, with flavours `local`, `dev`, `stage` and
`live`. Enabled variants:

| Variant | For |
|---|---|
| `localDebug` | Today's emulator work, against `10.0.2.2` |
| `devDebug` | The agent's debuggable build against `backend.dev`, served at `/download` |
| `stageRelease` | The owner's prod-like build against `backend.stage`, served at `/download` |
| `liveRelease` | Google Play |

Every other combination is switched off. The 12 files are updated in the same slice.

## 3. Bundle everything; no npm install on the server (measured)

A throwaway spike ran on the SSD (`knowscroll-dev/tmp/env-spike`, deleted afterwards) against
commit `e5fdc319`:

- esbuild 0.28.2 bundled `api`, `worker`, `generation`, `maintenance`, `migrate` and `seed`
  **with every npm dependency inside**. It took under a second, with no warnings; each bundle is
  1.0–2.8 MB.
- The release was the bundles, `packages/db/migrations/` and `content/`: **18 MB, no
  `node_modules`**.
- Against a throwaway PostgreSQL 16:
  - bundled `migrate` applied **38 migrations**;
  - bundled `seed` loaded **23 Scrolls** and the substrate (6/6 bridges);
  - the bundled API answered `/health` 200 (`database: true`), the feed 200 with a bearer, and
    401 without.

| How the API runs | Ready after start | Memory (RSS) |
|---|---|---|
| Bundled, plain `node --enable-source-maps` | **0.1 s** | **118 MB** |
| `tsx apps/api/src/main.ts` (today) | 1.3 s | 183 MB (process tree) |

Stack traces from the bundle still point at the original `.ts` files, because of the source
maps.

**Recommendation:** bundle everything. The server never runs `npm` or `pnpm install`, never
contacts the npm registry during a deploy, and needs no build tools for KnowScroll. If a future
dependency cannot be bundled, mark only that one as external and ship it with
`pnpm deploy --prod`, which produces a self-contained folder (pnpm.io/cli/deploy, read
2026-10-06).

## 2. Server scripts: split by job (recommendation changed)

Bash was chosen because it runs before Node exists. A better split by job:

| Job | How often | Tool | Why |
|---|---|---|---|
| Set up the server (packages, users, firewall, Postgres, Caddy, units) | rarely | **Ansible playbook in `ops/vps/ansible/`**, run from the Mac | Declarative and idempotent; re-running fixes drift. `--check --diff` shows exactly what would change on the server **before** it changes, which is the owner's "stay in the loop" in a reviewable form. Python 3 is already on the server |
| Deploy, back up, roll back, status | every push | **TypeScript, bundled to one file**, like the app | The logic (backup verification, health polling, rollback) gets unit tests with `node:test`. Node is on the server once the setup has run |
| SSH gate for the deploy key | every push | about 10 lines of bash | Parses `SSH_ORIGINAL_COMMAND` and calls the deploy tool, nothing more |

Ansible's cost is a Python tool on the Mac, installed into a virtualenv on the SSD. The fallback,
if the owner prefers fewer tools, is the original bash plan with `shellcheck`.

## Further ways to make it faster and more stable

1. **Build once, promote the same bits.**
   - The release is built once per commit, not once per world. The web app reads its world at
     runtime from the host it is served on (or a `config.json` Caddy serves), instead of having it
     baked into the build.
   - Promotion reuses the release that is already on the server. Stage and live run
     **byte-identical** code to what passed in dev. Promoting takes seconds.
   - Only the Android builds differ per world, because their app IDs do.
2. **Restarts users never see.**
   - Caddy holds requests during a restart and retries for a few seconds (`lb_try_duration`;
     caddyserver.com reverse_proxy docs, read 2026-10-06).
   - The bundled API is ready in about 0.1 s.
   - So a deploy shows no errors to someone using the app at that moment.
3. **Self-healing services.**
   - `Restart=on-failure` with backoff.
   - systemd sandboxing: `ProtectSystem=strict`, `NoNewPrivileges`, `PrivateTmp`, write access
     only to that world's folders.
   - Per-world memory caps.
4. **Faster CI.**
   - Cache the pnpm store and Gradle.
   - Build Android only when `apps/mobile` changed, otherwise reuse the last build.
   - A newer push to `dev` cancels an older dev deploy still in flight (concurrency group).
5. **Backups that are proven.**
   - Every week, live's latest backup is restored into a scratch database on the server, row
     counts are compared, and the scratch copy is dropped.
   - A backup that has never been restored is a hope, not a backup.
6. **Disk and log hygiene.**
   - journald capped at 1 GB.
   - The last 3 releases kept per world.
   - Cutroom working files pruned once KnowScroll has imported the final MP4.
7. **Someone notices when it's down.**
   - A free external uptime check on the three `/health` addresses, alerting the owner by email.
   - Optionally through the owner's existing Hermes WhatsApp butler.
8. **In-app update prompt for Stage and Dev.** The app checks `/download/latest.json` at launch
   and offers the new build. That makes the owner's chosen download-page route feel like an
   app-store update.
