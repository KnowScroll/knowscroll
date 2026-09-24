# ADR-0047 — Release readiness before the owner's inputs: a release build that refuses until it has them, App Links that open the confirmation, and rollback by restoring a verified backup

Date: 2026-09-25. Status: accepted by the coordinator for [#168](https://github.com/KnowScroll/knowscroll/issues/168)
(parent #135). Builds on ADR-0026 (a magic link opens a confirmation, never the consumption), ADR-0027
(AgentMail delivery), ADR-0030/0035 (privacy lifecycle, account deletion and its note on backups) and
ADR-0034 (the emailed link is `<KS_WEB_ORIGIN>/sign-in#token=…`). Owner decision of 2026-09-24: the
App Links domain, the production mail credentials and the release keystore arrive at the end of the
release work. Everything else is built now, with placeholders only and no real value invented.

## Context

The release variant is switched off (`beforeVariants … enable = false`): it has no signing, no API
address (`""`) and no shrinking rules that were ever exercised. The app handles no links at all; a
sign-in link is pasted. Migrations are forward-only in practice (`runMigrations` applies every pending
file in one transaction and refuses a changed or reordered ledger), but nothing written says how to
back up the owner's database before a migration or how to undo one. The development stack keeps no
backups (ADR-0035 §6). Android's backup rules exclude `ks_state.xml`, a file the app stopped writing
at its first rename, so its real private state (`ks_session_v1`, `ks_session_vault_v1`) is not
excluded from device-to-device transfer. On Android 12 and later, `allowBackup="false"` cannot
switch that transfer off on every manufacturer's devices.

## Decision

1. **A release build takes its inputs from outside Git.** `KS_RELEASE_STORE_FILE`,
   `KS_RELEASE_STORE_PASSWORD`, `KS_RELEASE_KEY_ALIAS`, `KS_RELEASE_KEY_PASSWORD`,
   `KS_RELEASE_API_BASE` and, optionally, `KS_APP_LINKS_HOST`. Each is read from the environment,
   otherwise from the ignored `apps/mobile/release.properties` (a template with empty values is
   committed). Debug builds read none of them.
2. **It refuses rather than guesses.** The release variant exists again, and a `checkReleaseInputs`
   task runs before any release task. It fails, naming every missing input, when a signing value is
   absent, the store file does not exist, or the API base is not an `https://` URL (release traffic
   is never cleartext). There is no default production address. `BuildConfig.KS_DEBUG_API_BASE`
   becomes `KS_API_BASE`, because the release build now has one too.
3. **Shrunk, with what reflection needs kept.** Release enables R8 and resource shrinking. The app
   itself uses no reflection. The ViewModels the default factory creates by constructor, the
   coroutines main dispatcher's service loader and Media3 are covered by their libraries' own
   consumer rules; `proguard-rules.pro` keeps `BuildConfig` and says what it relies on.
4. **An App Link opens the confirmation, never the consumption.** The release manifest declares
   `https://${appLinksHost}/sign-in` with `android:autoVerify`. The placeholder defaults to
   `links.knowscroll.invalid`: `.invalid` never resolves (RFC 6761), so nothing is verified until the
   owner names the domain. The activity takes only that exact scheme, host, default port and path,
   with a token the paste parser accepts, and never from a relaunch out of Recents. The link fills
   the sign-in screen's field, and the reader presses "Sign in with this link", exactly as for a
   pasted link and as the web page's "Sign in on this browser". A signed-in device ignores it.
   Debug builds declare no link filter and keep pasting. The host must be the host of
   `KS_WEB_ORIGIN`, because that is the link the API mails. The domain serves
   `/.well-known/assetlinks.json` naming `com.knowscroll.mobile` and the release certificate's
   SHA-256 fingerprint.
5. **Nothing on the device leaves through backup or device transfer.** The extraction rules exclude
   every domain for both cloud backup and device-to-device transfer, instead of one file name.
6. **Migrations stay forward-only; rollback is restoring the backup.** There are no down migrations.
   Before every `pnpm db:migrate` against the owner database, the operator writes a `pg_dump -Fc` of
   it to `$KS_DEV_ROOT/backups` (mode 0600, on the SSD) and migrates only after `pg_restore --list`
   reads it back. Rollback stops the API and worker, restores the backup into a new database, checks
   it, swaps the database names and starts the previous release's code. The failed database is kept
   under another name until the restore is checked. Anything written after the backup is lost, and
   the procedure says so.
7. **Backups are personal data.** A backup keeps history that Clear, Reset and account deletion
   later erase; those controls do not reach it (ADR-0035 §6). Backups stay on the SSD, never in Git,
   evidence or a synced folder. The operator keeps the latest verified pre-migration backup and
   deletes older ones once the upgrade they protected is verified.
8. **Upgrade evidence comes from a disposable fixture.** A test builds a schema at migration 0009,
   fills it with representative history of that shape, migrates it to head, compares every key field
   and reads it back through the current API. The owner database is never migrated to prove this.

## Alternatives and why

- *Keep release disabled until the inputs arrive:* the signing, shrinking and link configuration
  would first run on the day the owner hands them over.
- *A default production API address:* a build that silently talks to a host nobody chose.
- *A keystore or passwords in `gradle.properties` or `local.properties`:* the first is committed and
  the second is rewritten by `scripts/mobile-config.sh`.
- *Consume the token when the link opens:* any app can send the activity a link, and the reader
  would be signed in without pressing anything (ADR-0026 §3).
- *Down migrations:* reversing schema cannot bring back rows a migration or a privacy action removed
  or reshaped; restoring a checked backup is exact.

## Consequences

- `apps/mobile/app/build.gradle.kts`, `proguard-rules.pro`, `release.properties.template`,
  `src/release/AndroidManifest.xml`, `res/xml/data_extraction_rules.xml`; `MainActivity` passes an
  opened link to `AccountViewModel.receiveSignInLink`; `receivedSignInLink` in `data/SignInLink.kt`.
- `docs/operations/deployment.md` (backup, migrate, rollback, restart, environment, health) and
  `docs/operations/release-inputs.md` (the three owner inputs, how to apply and verify each).
- `tests/populated-upgrade.test.ts`; Android unit tests for the link, the extraction rules and the
  sign-in and privacy hardening in the same slice.
- The owner database, the owner's preview app and every live provider stay untouched. The release
  build is proved to refuse without its inputs and to build with throwaway ones; installing a signed
  release and verifying App Links need the owner's inputs.
