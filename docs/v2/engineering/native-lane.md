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

A run takes about 15 minutes of wall time: `apk` 8 to 11 minutes (Gradle with a warm cache is about 6; a cold cache is
slower), `emulator` about 6 (boot, 4 to 5 flows). Hosted-runner minutes are free on this public repository.

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

## Flows (`apps/client/maestro/`)

All flows start with `launchApp` and `clearState: true`, so each one is a cold start of a signed-out app.

| File | Proves (emulator) | Screenshots |
|---|---|---|
| `shell.yaml` | Cold start reaches the four-tab shell (Explore, Universe, Talk, Keep by testID and by label) on Explore's honest empty state, with the account avatar | `shell-01-cold-start` |
| `tabs-and-back.yaml` | Each tab opens its screen; from Keep the avatar pushes the account screen (signed out, "Back to Keep"); the **system Back** returns to Keep, not to the start tab; the on-screen Back does the same | `tabs-01…04`, `back-01`, `back-02` |
| `gallery.yaml` (gallery builds) | `knowscroll://gallery` opens the developer gallery (marker `ks-component-gallery`), it scrolls to its last section, the system Back closes the bottom sheet without leaving the gallery, and a second Back returns to the shell. The API-health panel asks the baked-in origin; the flow does not depend on the answer, but the screenshot shows what the dev API reported | `gallery-01…06` (with `04b`, `04c`) |
| `no-gallery.yaml` (builds without the gallery, i.e. `gallery=false`) | Runs instead of the two gallery flows: `knowscroll://gallery` reaches the not-found screen, not the gallery; its "Go to Explore" returns to the shell. With the APK step's bundle check this is the native counterpart of the client job's "the production export carries no developer gallery" | `no-gallery-01`, `no-gallery-02` |
| `scroll-blocks.yaml` (gallery builds) | Placeholder. When the gallery has an element with testID **`gallery-scroll-blocks`** it opens it and takes a screenshot. Until the Scroll renderers (#230 part 2) add it, the flow logs a `KS-LANE-SKIP` line and checks nothing; `run-ci.sh` then reports it as **skipped**, never as passed | `scroll-blocks-01-section` |

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

## Dedicated scoped-durability SDK fixture (#249)

The normal `apk`/`emulator` jobs and their four gallery flows above remain separate. A manual
run elects the additional jobs with `durability_sdk=true`; a labelled `run-native` PR also runs
those dedicated jobs. This source addition is not dispatch authority or runtime acceptance.
The coordinator must first compose the independently reviewed native23 and harness9 blobs on the
actual accepted base, preserving all current foreign/SQL bytes. Never merge the obsolete7417
ancestry of the development branch. Fresh exact-source/actual-PR checks and independent evidence
acceptance remain required. All programme requirements remain open.

`durability-apk` starts from its own clean checkout and prebuild, with no restored Gradle task
cache, `--no-build-cache --rerun-tasks`, and both explicit build flags:
`EXPO_PUBLIC_KS_GALLERY=1` and `EXPO_PUBLIC_KS_NATIVE_DURABILITY_CI=1`. It uses the fixed origin
`https://native249.fixture.invalid`. This produces `native249-durability-apk`, separate from
`android-release-apk`. `durability-emulator` installs it once on a fresh disposable hosted
emulator; it never installs it over a previous package. The normal APK inspection rejects both
private CI markers. The dedicated APK requires `ks-native-durability-bootstrap-v1` and
`ks-native-durability-screen-v1` as positive controls. Both the root bootstrap and route body
use build-constant conditional require; a not-found route alone is not the exclusion proof.
The coordinator separately appends the new production web route assertion to the final reviewed
web-smoke leaf. No provider, native foundation, app config, dependency or contract is changed here.

The root layout resolves a finite initial link (`seed`, `restore`, or `sqlite-denied`, with the
fixed `native249-v1` scenario) before constructing/starting the provider manager. Missing or
invalid selection blocks startup; it cannot fall back to the normal signed-out manager and
purge a restart witness. A module-owned bootstrap promise gives the existing provider's manager
prop exactly one stable actual manager, actual `sessionTokens`, actual singleton `scopeDurability`
and default Expo Crypto/SecureStore/SQLite. Hooks run before the font early return. The screen
only consumes that provider's context; it creates no second manager, adapter, socket or fake
storage port. Synthetic HTTP is a finite strict-schema fixture and never falls through to fetch.
Its public fixture credential is never sent to a real origin. These are synthetic authentication
and HTTP results, not server/provider acceptance or qualified consumption evidence.

Only explicit seed on a proved fresh installation may write the fixed fixture credential, after
both token and root are absent. Restore verifies the same credential, account/epoch/origin and
native-computed session binding, requires an existing OPEN root, and performs no token/root seed
write or clearing before hydration. It compares the pre-hydration root identity internally with
the hydrated root; random roots, keys, credentials, private bodies and their hashes are not emitted.
The single adapter decrypts the existing snapshot. The pending command and immutable event batch
are labelled authored fixture input. Grouped block state retains four revisions and its matching
index; actual anchor and private resume controllers supply the exact place. Every ready marker
waits for actual native exact-membership flush. No stored policy, ACK or snapshot grants collection.

The fixture holds provider current reads and automatic outbox ACKs until the restored pending
bytes, original generation/session/event order, grouped state/index, resume and unknown/no-collection
witness are checked. It then acknowledges the same original batch at generation1, waits for actual
committed removal, retries the original unknown Pause, and observes its receipt without collection.
Only a separate current read confirms paused generation2. An actual Resume command then reaches
generation3; its receipt alone still cannot collect, and another independent current read is required.
The fixture never relabels the old batch to a new generation. Intake ACK is not qualification.

### Process and fault sequence

`run-ci.sh` dispatches to `native-storage-failure-ci.sh` only for the dedicated flag. Otherwise
its old flows, assertions, independent results, tool pins and crash/ANR checks are unchanged.
The dedicated shell requires GitHub-hosted CI, a fixed emulator serial shape and qemu property,
the exact package and positive APK markers. It installs once. After seed-ready it records PID
and `/proc/<pid>/stat` kernel starttime, force-stops, proves process absence, and opens the same
APK/data with restore. The process identity pair must change. No clearState, pm clear, uninstall,
reinstall, reseed or app-data archive exists between halves.

Each fault is a separate required result, not a skipped pass. The shell records actual root and
run-as capability; debug signing is never treated as debuggability. The APK manifest records the
actual `android:debuggable` attribute. If required root/UID/metadata capability is absent, that
case is **UNAVAILABLE**, emits a JUnit error and fails the dedicated job. No JS throw substitutes.

Allowed private paths are only the fixed package's `files/SQLite`, `shared_prefs` and
`shared_prefs/SecureStore.xml` under `/data/user/0/com.knowscroll.client` (its canonical
`/data/data/com.knowscroll.client` alias is accepted). The shell checks exact canonical path,
non-symlink leaf, package UID ownership and captures mode/UID/GID/SELinux metadata before changes.
It never reads or uploads their contents, changes UID/GID/context, or accepts arbitrary path input.

| Case | Actual fault and required result |
|---|---|
| Cold SQLite | Force-stop and prove PID absence first, closing every app descriptor; deny the existing SQLite directory with mode000. Actual manager preparation and a separate immediately closed SDK open/PRAGMA attempt must reject, leave no successful scope/memory fallback and keep the original token/root. Restore exact metadata, cold-launch restore again and verify the complete original snapshot before acknowledging work. |
| SecureStore false commit | Keep the real process and its loaded SharedPreferences live. Set only that directory to500 and XML to400, denying atomic replacement and direct write. Actual scope end must reject with native `ERR_WRITE` and the pinned `Could not commit encrypted value to SecureStore` branch, not a generic encrypt/decrypt/permission rejection. The snapshot must remain, and actual manager signOut must stay unavailable with the original token. |
| Retry and cleanup | Restore exact original metadata, then require a new acknowledged CLOSED write through actual manager cleanup before deletion/token removal succeeds. A process-local CLOSED read after failed commit is not persistence proof. Verify keyless CLOSED/zero rows after the acknowledged receipt, refuse the same binding through the same singleton lifecycle, then permit a different synthetic session via actual manager redeem only after cleanup and clean that scope too. |

The CLOSED-before-DELETE temporal claim combines exact independently reviewed source ordering,
the real native failed-commit/no-delete observation, restored permissions and successful awaited
retry. Final row readback alone cannot prove commit ordering or disk persistence. The native
patch source hash, actual DEX branch string and native linkage are separate build evidence gates.

Every one-shot adb command has a finite timeout (5–60s); managed background logcat is capped
at1200s and stopped by the cleanup trap. Process absence has50 attempts at200ms; Maestro
phase runs are capped at100s and waits at60s. Initial-link selection is5s, internal observation
polling15s, controller operations60s, held fixture HTTP replies180s, and each hosted job remains
45 minutes. Replies are held to prevent authority races, not arbitrary test sleeps. EXIT/INT/TERM
restore exact original permission metadata and preserve failure status; failed restoration fails
the run. Cancellation/SIGKILL may interrupt a trap, so only a disposable hosted emulator is eligible;
no cancelled run establishes restoration or acceptance. There are no broad chmod/chown/rm commands.

### Evidence and limits

`native249-build-proof` binds source head/tree/full tracked blob map, lock/catalog/patch and actual
installed SecureStore source, autolinking metadata, generated manifest/backup XML and all APK ZIP
members plus the APK digest. The actual APK manifest is inspected separately. The SDK evidence
artifact includes an all-member SHA256 manifest and the upload action's official immutable archive
ID/digest is recorded outside that archive in the step summary. The coordinator must download and
verify the official archive and every member before acceptance; source generation is not that proof.

Dedicated receipts contain finite phase names, booleans, counts, fixed fixture selectors and process
identity. No root/key/token/private body or body-derived fingerprint is shown. Raw native logcat is
kept outside the upload folder only long enough to reduce app crash/ANR to a boolean, then removed;
it is never echoed or archived. Normal gallery logging remains its own unchanged lane. JUnit retains
separate restart/cold-SQLite/strict ACK/falsecommit/cleanup results, including unavailable failures.
Earlier successful results survive a later fault failure; failed/cancelled runs are never relabelled.

No local suite, native SDK, Maestro, emulator, native build or SQL has run during authoring. Local
checks are source parsing, shell/YAML syntax, types/lint/format/boundaries/Knip and normal web export.
Hosted success, if independently accepted later, proves only this Android emulator's actual SDK
process-restart/fault journey with synthetic HTTP. It does not prove real-service auth/recording,
iOS/physical device, backup restore/anti-rollback, power-loss persistence or forensic erasure.


### SecureStore must compile from the patched source

The installed SDK58 SecureStore package includes a precompiled local-maven AAR that lacks the
commit-false exception branch. Installing the pnpm Kotlin patch alone does not make an Android
APK use it. `apps/client/package.json` permanently selects
`expo.autolinking.android.buildFromSource: ["expo-secure-store"]` for ordinary and dedicated
Android builds. Versions, dependencies, the patch and lockfile stay unchanged.

The installed autolinking code reads the app's `expo.autolinking.android` configuration, carries
`buildFromSource` into the Android resolver output, and converts this package name to the exact
Gradle project name `expo-secure-store`. SettingsManager matches that full project name, disables
its precompiled publication and includes the source project. The dedicated proof requires parsed
resolver JSON with that configuration/project; both APK inspections require the actual patched
exception literal in DEX and the patched installed Kotlin source. A missing branch fails either
build. These are source/linkage build gates, not native commit, restart or fault runtime evidence.
