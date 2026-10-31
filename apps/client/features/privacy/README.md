# Privacy & history (P02, D05)

Related: #345, #246.

`/account/privacy` is in the account Stack and is linked from Account (P01). It is the hub of what a
person can do with their own data. Each control says what it changes, and reports done only when it is.

| Control                     | File                    | What it does                                                                                                                            |
| --------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Recording                   | `recording-control.tsx` | Pause and resume new personal recording; independent of Clear (#376)                                                                    |
| History & export            | `export-panel.tsx`      | Asks for a copy of the person's own data and keeps the receipts: preparing, ready (Download, once), downloaded, expired, failed (Retry) |
| Clear exploration           | `clear-panel.tsx`       | Selective Clear (#345): consequences, an acknowledgement, a deliberate step and honest receipt states                                   |
| Delete account              | `delete-panel.tsx`      | Consequences, an acknowledgement, one deliberate step; the result is read from the receipt                                              |
| Sharing & visibility        | `../visibility/`        | Who may visit the universe, which systems visitors see, whether friends see the person as online (F02, D-047) and whether the people they talk with see SEEN (D-150) |
| Anything another slice adds | `privacy-extensions.ts` | A row on the hub and a card on desktops; the sharing slices go between Clear and Delete                                                 |

Phones and tablets get the hub of rows and a page for each control (`/account/privacy/export`, `/clear`,
`/delete`). Desktops (D05) get the settings list beside one card per control on `/account/privacy`, and the
sub-page addresses redirect there.

Status: implemented; component fixtures exercise the real route tree, manager and provider with authored
HTTP answers (`features/account/account-privacy.test.tsx`, `privacy-screen.test.tsx`). They run in hosted
Actions and are not a real-device or dev acceptance.

## Clear (P02 "Clear exploration")

`/account/privacy/clear` mounts the manager-owned `privacy` session, so the minimal exact unknown request
survives a privacy-triggered AccountScope remount while all old scope data and resources are purged. A new
page or controller reads the latest status; it never automatically creates or retries a clear.

The consequence and preservation copy and the irreversible acknowledgement precede the typed fixed
confirmation command. Clear removes exploration history, derived plans, the universe and the person's export
files; Keep items and places and Social stay. Accepted, pending, failed, unknown, not-recorded and
live-complete states have distinct copy. Unknown exposes only explicit same-body retry and status checking: a
read cannot promise a delayed send is absent. Current account, epoch, selector and receipt lineage are checked
in client-core. Session recovery uses the actual session read, never an ACK-derived epoch.

Context already sent to an AI provider cannot be recalled. Live completion is separate from backup,
provider-copy and offline-device expiry, and no unverified expiry date is shown. There is no generic erasure
selector, time range, artificial percentage or claim of full privacy completion.

## Export

The file holds the person's own records in words: titles and times of what they saved, opened and reacted to,
their requests, the places in their universe, their sharing profile and how many people they are connected to.
Nothing of anyone else, and no identifier. A download works once, through a link made for the moment of the
click (`platform/export-download`: the browser downloads on the web; native hands the address to the system,
since the app has no file store yet). While an export prepares the page asks about it every four seconds.

## Delete account

The request is sent after the acknowledgement. The server ends every session with its answer, so the page
sends the person to Account, where the receipt is read without a session: in progress, could not finish
(Retry), or gone from our live systems, with backups named as a separate line and no date the app cannot
know (`features/account/deletion-receipt-panel.tsx`, also on the sign-in page). The receipt id is kept before
the request is sent, so a lost answer is recovered by asking; "Check" says whether the request arrived.

## Recording

`recording-control.tsx` mounts the scope-owned current recording session independently of Clear. Pause stops
new collection locally before sending; unknown choices expose only same-body retry and status checks. Current
policy is displayed from a new correlated read, never inferred from the historical ACK. Saved items, places
and history remain; necessary Save, Remove and action records still work while recording is known paused.
Resume explains that opening a fresh encounter is required for recording to begin again. Legacy unuploaded
batches with unknowable original generation are counted and disclosed as discarded; missing activity never
becomes reading. Native persistence remains memory-only. RN and production-export HTTP fixtures are source and
CI evidence, not live privacy, qualification, emulator or physical-device acceptance.
