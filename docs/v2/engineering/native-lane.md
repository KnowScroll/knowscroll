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
| Add the label **`run-native`** to a pull request | Always available. The lane runs on the label being added and on every later push to that PR (`opened`, `reopened`, `synchronize`, `labeled`); adding some other label to a labelled PR starts nothing. Pull requests build against the dev origin (`https://app.dev.knowscroll.space`) with the developer gallery. |
| `gh workflow run native.yml --ref <branch> [-f api_origin=<https origin>] [-f gallery=true\|false]` | Only once `native.yml` is on `dev`, the default branch (GitHub lists a dispatchable workflow only from the default branch). `api_origin` is baked into the build (HTTPS only); `gallery=false` builds without the developer gallery and skips the gallery flows. |

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
   embedded bundle, signer and whether the gallery marker is in the bundle. Caches: pnpm store (setup-node)
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

## Flows (`apps/client/maestro/`)

All flows start with `launchApp` and `clearState: true`, so each one is a cold start of a signed-out app.

| File | Proves (emulator) | Screenshots |
|---|---|---|
| `shell.yaml` | Cold start reaches the four-tab shell (Explore, Universe, Talk, Keep by testID and by label) on Explore's honest empty state, with the account avatar | `shell-01-cold-start` |
| `tabs-and-back.yaml` | Each tab opens its screen; from Keep the avatar pushes the account screen (signed out, "Back to Keep"); the **system Back** returns to Keep, not to the start tab; the on-screen Back does the same | `tabs-01…04`, `back-01`, `back-02` |
| `gallery.yaml` (gallery builds) | `knowscroll://gallery` opens the developer gallery (marker `ks-component-gallery`), it scrolls to its last section, and the system Back returns to the shell. The API-health panel asks the baked-in origin; the flow does not depend on the answer, but the screenshot shows it | `gallery-01…06` |
| `scroll-blocks.yaml` (gallery builds) | Placeholder. When the gallery has an element with testID **`gallery-scroll-blocks`** it opens it and takes a screenshot. Until the Scroll renderers (#230 part 2) add it, the flow logs a `KS-LANE-SKIP` line and checks nothing; `run-ci.sh` then reports it as **skipped**, never as passed | `scroll-blocks-01-section` |

Adding a flow: put `<name>.yaml` in `apps/client/maestro/` (selectors are testIDs, which React Native exposes as the
Android resource id, or visible text) and add a `run_flow` line to `run-ci.sh`. Keep names of screenshots unique
across flows; they are collected into one folder. When the renderers land, the author of #230 part 2 gives the
gallery's Scroll section the testID above and extends `scroll-blocks.yaml` with one assertion per block type.

## What it proves, and what it cannot

Proves (label **emulator**): the Android build of the pinned Expo SDK 58 / React Native 0.88 workspace compiles
(Gradle, R8, Hermes bytecode, native modules for x86_64); the release app starts from a cold state and renders the
shell; navigation, tab state and Android Back behave as the code says; the gallery and its deep link work in a
gallery build; the app does not crash while doing so.

Cannot prove yet:

- **Signed-in native journeys.** Native sign-in binding is off on every world (D-022, `KS_NATIVE_SIGN_IN_BINDING`),
  and a mailed link cannot be read by a test. A signed-in flow needs a session on the device. The smallest change
  that would allow it is to let operator sign-in links for the disposable `@test.knowscroll.space` accounts
  (`KS_OPERATOR_SIGN_IN_PATTERN`, dev and stage only) be redeemed by the native client, for example by a
  `knowscroll://redeem#token=…` deep link opened by the flow. That is an identity change, so it is the
  coordinator's decision, not this lane's; until then every flow is signed out.
- **A physical device**: real GPU, real keyboard and IME, gestures at speed, thermals, Hermes performance on phone
  hardware (the emulator runs x86_64 with a software GPU), push, deep-link verification by Android's
  App Links. The owner's phone remains the only physical-device evidence.
- **iOS**: not built here; iPhone users use the web app for now.
- **Store signing and release builds for distribution**: the APK is debug-signed on purpose.
- **Other API levels, screen sizes and the tablet rail**: one AVD (API 35, pixel_6, 1080×2400).
- **The server**: the app asks the dev origin only for diagnostics (the gallery's `/health`); no flow depends on it.

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
