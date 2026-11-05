# Platform adapters

Features import extensionless adapter names. Metro selects the `.web.ts` or `.web.tsx` sibling
for web; native uses the base file. Both are live entry points even when ordinary import search
finds only one. Keep their common port and test both behaviors before changing a platform split.

## Follow sign-in and storage

[api.ts](api.ts) chooses same-origin HTTP on web and the configured world origin on native.
[sign-in-link.ts](sign-in-link.ts) and its web sibling parse the link; the auth flow makes the
explicit redemption request. Native session tokens use encrypted platform storage; web uses
HttpOnly server cookies. Link tokens, bearer tokens and media grants must not enter diagnostics.

[scope-storage.ts](scope-storage.ts) supplies native scope storage through
[secure-key-value-store.ts](secure-key-value-store.ts). Web uses local storage. A scope key is
namespaced by account and privacy epoch and is purged when that scope ends. The deletion receipt
lives outside that namespace so progress remains readable after sign-out. Native writes are
ordered but asynchronous: a process killed before persistence can lose the latest change.

[device-preferences-store.ts](device-preferences-store.ts) holds display/playback choices above
the account scope. Those choices survive sign-out and Clear because they belong to the device.
They do not grant recording authority.

## Browser and mounted-view behavior

`after-pending-back`, `document-title`, `opening-ground` and their web siblings adapt browser
history, titles and visibility. [use-mounted-resource.ts](use-mounted-resource.ts) constructs a
route-owned resource in effect setup and disposes it in cleanup; React's development remount
must make a fresh resource. Scope-owned encounter resources have a different lifetime and must
not be disposed merely because their view unmounted.

Run `pnpm --filter @knowscroll/client exec jest --ci --runInBand platform` from the repository
root for the adapter fixtures. Hosted web export/browser checks exercise actual `.web` resolution;
Android emulator checks are in the optional native lane. Neither proves physical-device parity.
