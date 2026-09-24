# Release inputs: what the owner supplies at release time

Owner decision of 2026-09-24: the App Links domain, the production mail credentials and the release
keystore arrive at the end of the release work. Everything else is built and tested without them
([ADR-0047](../decisions/0047-release-readiness-before-owner-inputs.md)); nothing here holds a real
value. Never commit a keystore, a password, a key or `apps/mobile/release.properties`; `.gitignore`
excludes `release.properties`, `*.jks` and `*.keystore`.

## Checklist

- [ ] **1. Domain for App Links** — the web origin the API mails links for.
- [ ] **2. Production mail credentials** — AgentMail key and inbox.
- [ ] **3. Release keystore** — store file, alias and both passwords.
- [ ] **With 1: the release API address** — `KS_RELEASE_API_BASE`, an `https://` address that reaches
  the API. The API listens on `127.0.0.1` only and refuses `NODE_ENV=production`
  ([deployment.md](deployment.md)); an HTTPS endpoint in front of it is not built in this repository.

## Without them

Debug builds need none of these. A release build refuses before it builds anything:

```sh
. ./scripts/env.sh && cd apps/mobile && ./gradlew :app:assembleRelease --console plain -q
```

```
* What went wrong:
Execution failed for task ':app:checkReleaseInputs' (registered in build file 'app/build.gradle.kts').
> Release build refused. Missing or invalid: KS_RELEASE_STORE_FILE (an existing keystore file); KS_RELEASE_STORE_PASSWORD; KS_RELEASE_KEY_ALIAS; KS_RELEASE_KEY_PASSWORD; KS_RELEASE_API_BASE (an https:// URL). Set each as an environment variable or in apps/mobile/release.properties (ignored by Git; see release.properties.template and docs/operations/release-inputs.md). Debug builds need none of them.
```

Each input is read from the environment first, then from `apps/mobile/release.properties`
(`cp apps/mobile/release.properties.template apps/mobile/release.properties && chmod 600 apps/mobile/release.properties`).

## 1. Domain for App Links

The API mails `<KS_WEB_ORIGIN>/sign-in#token=…` (ADR-0034). On a phone with the release app, that
link opens the app, which fills the sign-in field; the reader presses "Sign in with this link". The
App Links host and the web origin's host must be the same domain.

1. The API's environment gets `KS_WEB_ORIGIN=https://<domain>`; restart the API
   ([deployment.md](deployment.md)). Browsers without the app still need the web app's `/sign-in`
   page served at that origin.
2. The domain serves `https://<domain>/.well-known/assetlinks.json`: status 200, no redirect,
   `Content-Type: application/json`. The fingerprint is the release certificate's SHA-256 (step 3
   of the keystore section prints it); with Google Play App Signing, it is Play's app signing
   certificate from the Play Console, not the upload key.
   ```json
   [{
     "relation": ["delegate_permission/common.handle_all_urls"],
     "target": {
       "namespace": "android_app",
       "package_name": "com.knowscroll.mobile",
       "sha256_cert_fingerprints": ["<AA:BB:…: the 32-byte SHA-256 of the release certificate>"]
     }
   }]
   ```
3. The release build gets `KS_APP_LINKS_HOST=<domain>`: the host only, no scheme or path. Unset,
   it stays `links.knowscroll.invalid`, which can never verify, and the reader pastes the link.

Verify:

- `curl -fsSI https://<domain>/.well-known/assetlinks.json` shows `200` and `application/json`.
- `curl -fsS "https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://<domain>&relation=delegate_permission/common.handle_all_urls"`
  lists `com.knowscroll.mobile` with the release fingerprint.
- `"$ANDROID_HOME/build-tools/36.0.0/aapt2" dump xmltree --file AndroidManifest.xml apps/mobile/app/build/outputs/apk/release/app-release.apk | grep 'android:host'`
  shows the domain.
- On the device, after installing that APK: `adb shell pm verify-app-links --re-verify com.knowscroll.mobile`,
  then `adb shell pm get-app-links com.knowscroll.mobile` shows the domain as `verified`.
- On a signed-out device, a mailed link opens the app on the sign-in screen with the link filled
  in, and pressing "Sign in with this link" signs in.

## 2. Production mail credentials (AgentMail)

ADR-0027 and [magic-link-delivery.md](magic-link-delivery.md). The key is a secret; the inbox id and
owner address are configuration.

1. In the API's environment (the ignored `.env` at the main checkout root, mode 0600, or the
   shell): `KS_MAIL_SENDER=agentmail`, `AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX_ID` (an inbox that key
   can see; on 2026-09-20 the owner's key could not see `knowscroll@agentmail.to`) and
   `KS_OWNER_EMAIL`. Leave `AGENTMAIL_BASE_URL` and `AGENTMAIL_TIMEOUT_MS` unset.
2. Restart the API ([deployment.md](deployment.md)). With the key or inbox missing, every send
   fails and is logged (`"reason":"unknown"`); it never falls back to the file sink.

Verify:

- Request a link from the app's sign-in screen with the owner address. The screen shows the one
  fixed "check your email" message whether or not mail was sent, so check the API's stderr: no
  `magic_link_send_failed` line.
- The mail arrives, its link opens the sign-in (in the app once the domain is verified, otherwise
  the web page), and signing in with it works once.
- ADR-0027 §5's machine proof is the coordinator's: one real send, read back from the same inbox,
  recorded with the token, link and address redacted.

## 3. Release keystore

1. Use the owner's keystore, or create one outside this repository (it prompts for both passwords,
   so none is on the command line or in the shell history):
   ```sh
   mkdir -m 700 -p "$KS_DEV_ROOT/release-signing"
   keytool -genkeypair -keystore "$KS_DEV_ROOT/release-signing/knowscroll-release.jks" -storetype PKCS12 \
     -alias knowscroll -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=KnowScroll"
   ```
   Keep a copy offline. Every update must be signed by the same key, or with Play App Signing, the
   same upload key.
2. Set `KS_RELEASE_STORE_FILE` (an absolute path), `KS_RELEASE_STORE_PASSWORD`,
   `KS_RELEASE_KEY_ALIAS`, `KS_RELEASE_KEY_PASSWORD` and `KS_RELEASE_API_BASE` in
   `apps/mobile/release.properties` or the environment, then build:
   ```sh
   . ./scripts/env.sh
   cd apps/mobile && ./gradlew :app:assembleRelease --console plain
   ```
   The APK is `apps/mobile/app/build/outputs/apk/release/app-release.apk`: signed, shrunk by R8,
   with no cleartext traffic and no development token.
3. Verify:
   - `"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --print-certs apps/mobile/app/build/outputs/apk/release/app-release.apk`
     prints `Signer #1 certificate SHA-256 digest:`, the same bytes as the `SHA256:` line of
     `keytool -list -v -keystore "<store file>" -alias <alias>`. That line's `AA:BB:…` form goes
     into `assetlinks.json`.
   - `git status --short` lists neither `release.properties` nor the keystore.
   - Installed on a device, the app starts on the sign-in screen, signs in, and reaches the API at
     `KS_RELEASE_API_BASE`.

The build logic was proved without the owner's inputs: it refuses as shown above, it reads the
ignored file as well as the environment, and with a throwaway keystore and a placeholder `https://`
address it builds, signs and shrinks a release whose manifest carries the App Links filter; the
ViewModel constructors the default factory needs are kept.
