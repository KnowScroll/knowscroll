# The native lane (Android emulator in GitHub Actions)

`.github/workflows/native.yml` (workflow `native`) builds the Expo app for Android on a GitHub-hosted
runner and drives it on an Android emulator with Maestro. It is the source of **emulator** evidence
(AGENTS.md evidence labels) until the owner tests on a real phone. Owner decision D-019 allows it;
issue #249 (S6.4 part 1) built it, pulled forward into Phase 2 because the Scroll renderers (#230), generated
Scrolls (#232) and the Explore journeys (#234) need emulator evidence.

It is **not** one of the six required `checks` jobs (D-020) and does not change `checks.yml`. It never gates
a merge, never deploys, uses no secret and no signing key, and never runs on a self-hosted runner (CF-04).
Android builds and the emulator run only here, never on a developer's Mac.

## Running it

| How | When |
|---|---|
| Add the label **`run-native`** to a pull request | Always available. The lane runs on the label being added and on every later push to that PR (`opened`, `reopened`, `synchronize`, `labeled`); adding some other label to a labelled PR starts nothing. Pull requests build against the lane's test API (below) with the developer gallery. |
| `gh workflow run native.yml --ref <branch> [-f api_origin=<https origin>] [-f gallery=true\|false]` | Only once `native.yml` is on `dev`, the default branch (GitHub lists a dispatchable workflow only from the default branch). `api_origin` is baked into the build: the default is the test API; an https origin builds a normal app and runs the signed-out flows only. `gallery=false` builds without the developer gallery and skips the gallery flows. |

A run takes about 15 minutes of wall time without the test API: `apk` 8 to 11 minutes (Gradle with a warm cache is about 6; a cold cache is
slower), `emulator` about 6 (boot, 4 to 5 flows). The test API adds its build and the journey to the `emulator` job. Hosted-runner minutes are free on this public repository.

Follow a run with `gh run watch <id>`, and fetch the evidence with `gh run download <id> -D <folder>`
(artifacts below). A newer push to the same ref cancels the older run; a pull-request event that does not
run the lane (no label) never cancels one.

## What a run does

1. **`apk`** (`ubuntu-latest`, one job, at most 45 minutes). Node 22.23.0 and pnpm as in `checks.yml`;
   `pnpm install --frozen-lockfile`; `@knowscroll/contracts` built (the bundle reads its `dist/`, D-012);
   `expo prebuild --platform android --clean --no-install` generates `apps/client/android/` (never committed;
   the template is the one inside the pinned `expo` package, so the Expo SDK fixes AGP, Gradle, the NDK and the
   SDK levels); the Gradle wrapper's distribution is pinned by SHA-256; then
   `./gradlew :app:assembleRelease -PreactNativeArchitectures=x86_64`. The release build embeds the JavaScript
   bundle (`expo export:embed` through the React Native Gradle plugin), so there is no Metro at run time, and
   it is signed with the template's debug keystore. `EXPO_PUBLIC_KS_API_ORIGIN` is the `api_origin`;
   `EXPO_PUBLIC_KS_GALLERY=1` when the gallery is on. The step summary records the APK's package, size, SHA-256,
   embedded bundle, signer and the gallery marker and API origin found in the bundle; the step fails if the marker
   is missing from a gallery build or present in one made without the gallery, or if the origin is not baked in. Caches: pnpm store (setup-node)
   and Gradle (`gradle/actions/setup-gradle`, writable from pull requests).
2. **`emulator`** (`ubuntu-latest` with KVM, at most 45 minutes). Takes the APK, installs the pinned Maestro CLI
   (checksum verified), boots an **API 35, google_apis, x86_64, pixel_6** emulator (software GPU
   `swiftshader_indirect`, animations off) through `reactivecircus/android-emulator-runner`, then runs
   `apps/client/maestro/run-ci.sh`: install the APK, record logcat, run each flow as its own Maestro run (a failing
   flow never hides the screenshots of the others), copy the screenshots, and fail on any flow failure or an app
   crash in logcat.

The emulator job can be re-run alone (**Re-run failed jobs**) without rebuilding the APK, while the artifact lives
(7 days).

## Artifacts

| Artifact | Contents | Kept |
|---|---|---|
| `android-release-apk` | `app-release.apk` (debug-signed, x86_64 only, dev origin): installable on an x86_64 emulator, not on a phone | 7 days |
| `emulator-screenshots` | every `takeScreenshot` PNG, plus `adb-final-screen.png` (an independent capture of the last screen) | 14 days |
| `emulator-report` | `summary.md`, `device.txt`, `reports/<flow>.xml` (JUnit), `logs/<flow>.log` (Maestro output), `maestro/<flow>/…` (Maestro's artifact folders: commands, failure screenshots and hierarchies, device log), `logcat.txt` | 14 days |

## The test API and the journey (#249, D-045)

When the APK is built for the default origin `http://127.0.0.1:3399`, the `emulator` job also builds the API and
worker release trees (`pnpm deploy`, as `checks` does), starts `apps/client/maestro/test-api/serve.mjs` over the
job's PostgreSQL service (database `knowscroll_fixture_native`), and waits for `/health`. The script migrates,
admits the authored starter Scroll ("Why the sky is blue"), imports one Reel made from generated colour-bar video
through a fake Cutroom ("[Fixture] A blanket made of gas"; no provider, no spend), and starts the API with the fixture
mail sender (mail goes to `mail.jsonl`, never uploaded) and native sign-in binding on. It is a fixture world: the
configuration refuses all of this outside `ci` and `local`. `run-ci.sh` forwards the port with `adb reverse`.

The build flag `EXPO_PUBLIC_KS_TEST_API=1` (set only for that origin) lets the client use plain HTTP to localhost and makes
the manifest allow cleartext traffic (`plugins/test-api-cleartext.js`); the APK step fails if a test build lacks it or any
other build has it.

The journey is three Maestro runs on one install, joined by `run-ci.sh`:

1. `journey-1-request-link`: signed-out Explore, Sign in, Continue with email, a fresh `journey-<time>@test.example`
   address, "Check your inbox". The app binds the link to this device (verifier in the secure store).
2. The script reads the link from the recorded mail and turns it into `knowscroll://redeem#token=...`.
   `journey-2-sign-in-and-explore`: the link opens the app, "Continue as ...", the fixture Reel appears, the first-arrival
   hint is dismissed, Next subject reaches the Scroll, Keep this place, Keep lists it, Universe opens.
3. `journey-3-restart`: the app is stopped and started with its data: still signed in, the hint stays dismissed
   (encrypted scope storage), Keep still lists the Scroll, the account screen shows the address; then Sign out, and another
   restart finds a signed-out app (the stored token is gone).

Artifacts add `test-api-logs` (the API, worker and operator logs).

## Flows (`apps/client/maestro/`)

All flows start with `launchApp` and `clearState: true`, so each one is a cold start of a signed-out app.

| File | Proves (emulator) | Screenshots |
|---|---|---|
| `shell.yaml` | Cold start reaches the four-tab shell (Explore, Universe, Talk, Keep by testID and by label) on Explore's honest empty state, with the account avatar | `shell-01-cold-start` |
| `tabs-and-back.yaml` | Each tab opens its screen; from Keep the avatar pushes the account screen (signed out, "Back to Keep"); the **system Back** returns to Keep, not to the start tab; the on-screen Back does the same | `tabs-01…04`, `back-01`, `back-02` |
| `gallery.yaml` (gallery builds) | `knowscroll://gallery` opens the developer gallery (marker `ks-component-gallery`), it scrolls to its last section, the system Back closes the bottom sheet without leaving the gallery, and a second Back returns to the shell. The API-health panel asks the baked-in origin; the flow does not depend on the answer, but the screenshot shows what the dev API reported | `gallery-01…06` (with `04b`, `04c`) |
| `no-gallery.yaml` (builds without the gallery, i.e. `gallery=false`) | Runs instead of the two gallery flows: `knowscroll://gallery` reaches the not-found screen, not the gallery; its "Go to Explore" returns to the shell. With the APK step's bundle check this is the native counterpart of the client job's "the production export carries no developer gallery" | `no-gallery-01`, `no-gallery-02` |
| `scroll-blocks.yaml` (gallery builds) | Placeholder. When the gallery has an element with testID **`gallery-scroll-blocks`** it opens it and takes a screenshot. Until the Scroll renderers (#230 part 2) add it, the flow logs a `KS-LANE-SKIP` line and checks nothing; `run-ci.sh` then reports it as **skipped**, never as passed | `scroll-blocks-01-section` |
| `journey-1-request-link.yaml`, `journey-2-sign-in-and-explore.yaml`, `journey-3-restart.yaml` (test API builds) | The signed-in journey described above, as three runs chained by `run-ci.sh` (they need its address and link, so they never run on their own). Skipped, and reported as skipped, for an https-origin build | `journey-1-01…02`, `journey-2-01…05`, `journey-3-01…03` |

Every flow begins with `runFlow: start-app.yaml` (a shared subflow, never run on its own): a cold start of the signed-out
app and a wait for the shell. It also dismisses an Android "Pixel Launcher isn't responding" dialog if one appears: the
software-rendered emulator starts under load, and while that dialog is up the app is not in the view hierarchy, so
every wait times out (seen once in a probe run, with the app already drawn behind the dialog). A dialog about KnowScroll
itself is never dismissed, and `run-ci.sh` also fails on an `ANR in com.knowscroll.client` line in logcat.

Adding a flow: put `<name>.yaml` in `apps/client/maestro/` (selectors are testIDs, which React Native exposes as the
Android resource id, or visible text) and add a `run_flow` line to `run-ci.sh`. Keep names of screenshots unique
across flows; they are collected into one folder. When the renderers land, the author of #230 part 2 gives the
gallery's Scroll section the testID above and extends `scroll-blocks.yaml` with one assertion per block type.

## What the first runs found

- **The release bundle did not compile with Hermes.** Metro bundled the app, then `hermesc` rejected
  `async (...[input, options2 = {}]) =>` in `@orpc/client` ("invalid destructuring target"): Expo's Hermes profile
  leaves parameters alone, so no Android release build of the app could be produced. `apps/client/babel.config.js`
  (Expo's own preset plus `@babel/plugin-transform-parameters`) fixes it for every platform. It was a product
  defect, not a lane defect, and no Android release build had been made before this lane.
- **Generated files may lack a final newline.** Appending Gradle properties glued the first appended line onto
  `expo.inlineModules.watchedDirectories=[]`, which `:expo:generateInlineModules` parses as JSON. The workflow starts
  its appends on a new line.
- **Maestro keeps `console.log` out of its console output.** A flow that skips itself is recognised from Maestro's
  own per-flow `maestro.log`, which records the command that ran.

## What it proves, and what it cannot

Proves (label **emulator**): the Android build of the pinned Expo SDK 58 / React Native 0.88 workspace compiles
(Gradle, R8, Hermes bytecode, native modules for x86_64); the release app starts from a cold state and renders the
shell; navigation, tab state and Android Back behave as the code says; the gallery and its deep link work in a
gallery build; the app does not crash while doing so.

Cannot prove yet:

- **Signed-in journeys against a deployed world.** The journey runs against the lane's own test API. Native sign-in binding
  stays off on dev and stage (D-022, `KS_NATIVE_SIGN_IN_BINDING`), so no journey signs in there.
- **A physical device**: real GPU, real keyboard and IME, gestures at speed, thermals, Hermes performance on phone
  hardware (the emulator runs x86_64 with a software GPU), push, deep-link verification by Android's
  App Links. The owner's phone remains the only physical-device evidence.
- **iOS**: not built here; iPhone users use the web app for now.
- **Store signing and release builds for distribution**: the APK is debug-signed on purpose.
- **Other API levels, screen sizes and the tablet rail**: one AVD (API 35, pixel_6, 1080×2400).
- **A deployed server.** The journeys use fixture content on a disposable database; dev and stage are not exercised.

## Pins

Everything the lane depends on is pinned; the exact versions, dates and licences are in
`operations/dependency-matrix.md` ("Native lane"). Actions are pinned by commit SHA with a version comment;
Maestro and the Gradle distribution by SHA-256. Not pinned: the Temurin 17 patch release, the emulator binary and
the API 35 system-image revision (sdkmanager's current stable channel), and Android SDK components that Gradle
installs for the compile SDK, build tools, NDK and CMake the React Native version names. A change in one of these
shows up as a failed run, not as a silent change of what is tested.

When Expo or React Native moves, the generated Gradle version changes with it: the `Pin the Gradle distribution`
step fails with the new version, and the pin (`KS_GRADLE_VERSION`, `KS_GRADLE_SHA256`) is updated together with the
matrix.
