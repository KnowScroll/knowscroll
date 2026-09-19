# #92 web-reader evidence

Fixture/source-level evidence for a disposable Chromium journey against a disposable
PostgreSQL + API + worker stack. This is **not** owner visual acceptance and **not** a
production-auth proof (production identity for `apps/web` does not exist yet; #2).

## Exact commit and environment

- Repository: KnowScroll/knowscroll, branch `claude/92-web-reader`
- Commit under test: `835b86cbe70433c5f8342d9b2b467361a21a653f`
  ("Add apps/web desktop reader per ADR-0022 (#92)")
- Contract: `docs/decisions/0022-desktop-web-surface.md` at
  `0339b6334118f90fb679c60932e57ce825cad68b`
- Worktree: `/Volumes/Mrigesh SSD/knowscroll-worktrees/92-web-reader`
- Node: `v22.23.0` (via `. ./scripts/env.sh`); pnpm `10.30.3`
- Playwright: `1.63.0`; browser: Chromium build 1243 (Google Chrome for Testing
  `153.0.8010.12`, `mac-arm64`), cached at
  `$KS_DEV_ROOT/playwright-browsers` on the external SSD (never the default
  `~/Library/Caches/ms-playwright`)
- PostgreSQL: local SSD cluster at `127.0.0.1:55432`; the journey runner creates and
  drops its own `knowscroll_test_*` database and never touches the owner database
  `knowscroll` (the runner refuses that name outright if `DATABASE_URL` ever pointed
  at it)
- Disposable API/worker/fault-proxy/Vite dev server run as separate real Node
  processes on dynamically assigned ports (never a fixed/shared port), started and
  torn down by `scripts/run-web-reader-journey.ts`

## Commands run

```
. ./scripts/env.sh
pnpm typecheck                 # root; apps/web excluded (tsconfig.json)
pnpm typecheck:web             # apps/web: `tsc -b --force`
pnpm test:web                  # apps/web: `vitest run`
pnpm exec tsx scripts/run-web-reader-journey.ts   # disposable Playwright/axe journey
```

## Results

| Check | Command | Expected | Observed |
|---|---|---|---|
| Root typecheck | `pnpm typecheck` | 0 errors, apps/web excluded | 0 errors |
| Web typecheck | `pnpm typecheck:web` | 0 errors | 0 errors |
| Web unit/component tests | `pnpm test:web` | all pass | **32/32 passed**, 5 files (`discovery.test.ts`, `readerStore.test.ts`, `storage.test.ts`, `ScrollScreen.test.tsx`, `build-no-secrets.test.ts`) |
| Playwright journey | `run-web-reader-journey.ts` | all pass | **14/14 passed** (see `last-run-receipt.json`); run at `2026-09-19T22:27:48Z`–`22:28:02Z`, database `knowscroll_test_d61e131cd7302760`, dropped afterward (`databaseDropped: true`), dev-auth proxy smoke check passed |

### Per-behavior evidence (Playwright spec → assertion)

| Behavior (brief clause) | Spec | Observed |
|---|---|---|
| Honest empty-universe copy, no Traces | `01-reader-journey.spec.ts:17` | "Your universe" heading, "Nothing lives here yet.", zero saved-Trace nav items, "Enter Scroll" visible — pass |
| Exposure posted once, only after real visibility; reason/truth-state/source are returned facts | `01-reader-journey.spec.ts:25` | exactly 1 `POST /v1/exposures`; why-panel reason non-empty; truth-state text `DOCUMENTED`/"Directly supported by strong cited evidence"; source link `target=_blank` `rel="noopener noreferrer"` `https://` href; stored `exposureEventId` fetched live via `GET /v1/events/:id` returns `kind:"exposure"` — pass |
| No exposure while hidden/off-screen; exposure fires on becoming visible | `01-reader-journey.spec.ts:72` | 0 exposure requests while `document.visibilityState==="hidden"`; exactly 1 after visibility restored — pass |
| Keep retry-by-identity after a dropped response yields exactly one keep; kept Trace then listed | `01-reader-journey.spec.ts:97` | fault-proxy drops first `POST /v1/interactions` response; UI reaches "Kept" via the client's own retry; `GET /v1/events/:exposureEventId` returns 200; returning to Universe shows "Revisit the saved Trace: <title>" — pass |
| Deliberate Next discovery reaches a finite-library rest (no auto-advance) | `01-reader-journey.spec.ts:131` | after finite editorial seed content is exhausted, "You've reached the end of the current library" heading appears; Next is a manual button/`n` key, never automatic — pass |
| Saved-Trace revisit is read-only: no new exposure, disabled Keep, exact return | `01-reader-journey.spec.ts:147` | "Saved Trace · revisiting a kept Scroll" label shown; "Kept" button disabled; 0 exposure requests during revisit; "Return to Universe" returns to the Universe heading — pass |
| Reload restores current Scroll/origin and retry envelope | `01-reader-journey.spec.ts:168` | same `assetId` and `exposureId` in `localStorage`'s `ks_web_v1:session` before/after reload — pass |
| API unavailable → visible retry preserving the page; recovers | `02-recovery.spec.ts:4` | outage via fault-proxy shows "The universe is unavailable" + "Retry loading the universe"; clearing outage and retrying restores "Enter Scroll" — pass |
| 401 purges scoped storage; honest session-unavailable state | `02-recovery.spec.ts:23` | fault-proxy forces a 401 on `GET /v1/universe`; `ks_web_v1:session` and `ks_web_v1:revisit` both become `null`; "This device session is no longer available." shown; retry recovers — pass |
| Keyboard-only complete path; no ArrowRight binding | `03-keyboard-and-a11y.spec.ts:17` | Enter→Enter Scroll, ArrowRight is a no-op (`page.content()` unchanged), ArrowDown/Up scroll, Enter→Keep reaches "Kept", `n`→Next, Escape→Home returns to Universe — pass |
| Accessibility scan, Universe | `03-keyboard-and-a11y.spec.ts:46` | axe (`@axe-core/playwright`) on `main`: **0 violations of any impact** (`axe-universe.json`, 16 passing rules) |
| Accessibility scan, Scroll reader | `03-keyboard-and-a11y.spec.ts:55` | axe on `main`: **0 violations of any impact** (`axe-scroll.json`, 15 passing rules) |
| Reference screenshots | `03-keyboard-and-a11y.spec.ts:69` | `screenshots/{universe,scroll,scroll-sources}-{1440x900,1024x768}.png` captured, full-page, real rendered state |
| Dev-auth token never in client bundle | `apps/web/test/unit/build-no-secrets.test.ts` | a real `vite build` (only under the internal test-only env escape hatch) contains neither the injected token string nor the literal `Authorization` anywhere in its emitted `.js/.mjs/.cjs/.css/.html/.map/.json` output — pass |
| Production build refusal | `apps/web/test/unit/build-no-secrets.test.ts` | `vite build` without the escape hatch exits non-zero and produces no `outDir` — pass |

Full machine output: `last-run-receipt.json`, `axe-universe.json`, `axe-scroll.json`.
Screenshots: `screenshots/*.png`.

## Limits (what this evidence does not prove)

- **No owner visual/UX acceptance.** These are automated fixture-driven checks, not a
  human owner sign-off on the design or copy.
- **No production authentication path.** ADR-0022's dev-auth proxy is deliberately
  dev/preview-only; `vite build` refuses until #2 (real identity) exists. This
  evidence never exercises a production auth flow because none exists yet.
- **No Reel, Ask, Friends, branch, Clear, or sign-out surface on web.** Out of scope
  for this slice per the brief.
- **Playwright is not part of CI in this slice** (only `pnpm typecheck:web` and
  `pnpm test:web` were added to `.github/workflows/checks.yml`); the Playwright/axe
  evidence above is reproducible locally via `scripts/run-web-reader-journey.ts` but
  is not continuously re-verified by CI.
- **Editorial/seed content is fixture data** from the same disposable-seed path used
  by other backend journeys (`scripts/seed.ts`), not real user content or real
  provider output. No provider keys, network providers, or paid calls were used
  anywhere in this work.
- **Single-browser coverage.** Only Chromium was exercised (per the brief); no
  Firefox/WebKit/real-device pass exists yet.
- **The disposable stack's ports, database name and token are randomized per run**
  and are torn down/dropped at the end of the run (`databaseDropped: true` in
  `last-run-receipt.json`); this run's specific values are historical and not a
  live service.

## Coordinator reproduction after merging main (2026-09-19/20)

The coordinator merged current `main` (which carries the #93 Cutroom slice) into this lane at
`4f718b5cd0d514d59c63f9dbb6810b8c6fa3a124` and re-ran everything independently:

- `pnpm typecheck` and `pnpm typecheck:web` — 0 errors.
- `pnpm test:web` — 32/32.
- `pnpm exec tsx scripts/run-web-reader-journey.ts` — **14/14 Playwright checks passed**, disposable
  database `knowscroll_test_16cf08b657d4baa1` created and dropped, dynamic ports (api 62936,
  fault proxy 62951, web 62952), dev-auth proxy smoke check passed. The injected-fault specs log
  `socket hang up` from the proxy by design; those are the faults under test, not failures.
- Independent secret check, not relying on the lane's own test: `vite build` refuses by default; with
  the test-only escape hatch and `KS_DEV_TOKEN=probe-token-abc123xyz`, the 336 kB client bundle
  contains neither that token nor any `Authorization` header.
- Full backend `pnpm test` on the merged head (result recorded in the #92 pull request).

Unchanged limits: Chromium only; no owner visual acceptance; no production identity; Playwright not
in CI; no Reel, Ask, Friends, branch, Clear or sign-out surfaces on web yet.
