# Wave three — Clear Scroll history

Observed September 16, 2026; receipts retain UTC timestamps. Coordination: [#29](https://github.com/KnowScroll/knowscroll/issues/29). Backend: [#33](https://github.com/KnowScroll/knowscroll/pull/33); Android: [#35](https://github.com/KnowScroll/knowscroll/pull/35); service journey: [#34](https://github.com/KnowScroll/knowscroll/pull/34). Workers used gpt-5.6-sol and gpt-5.6-terra. The coordinator reviewed actual diffs and reproduced combined runtime checks.

## Verified behavior

- `pnpm typecheck` passed. `pnpm test`: **38 passing tests**, comprising 12 bootstrap/migration and 26 identity/API/privacy checks. [Output](backend-tests.txt) includes exact retry, concurrent keys, universe isolation, caller-only session rollover, admission/worker lock ordering, rollback and maximum-epoch overflow atomicity.
- Two [negative verifier checks](verifier-tests.txt) passed. Separate API/worker/PostgreSQL runs passed [J001](http-j001.json), [J002](http-j002.json), and [J003](http-j003.json). J003 proves nonempty scoped erasure, shared library and neighbor preservation, stale-device rejection, no erased-job resurrection, and new activity surviving replay of an old receipt.
- [J003 cancellation](cancellation.json): SIGTERM after worker start exited nonzero and left no new test database or API/worker/verifier processes. An orphan API from the earlier runner was identified and removed before this clean reproduction. This is not SIGKILL/host-loss proof.
- Six Android privacy instrumentation phases passed on API36 arm64 at compact 840×1680: confirmation cancellation; nonempty clear; committed response dropped by an HTTP transport proxy; force-stop/cold-process retry; higher-epoch cache purge; foreign local universe binding. The proxy forwards real requests and drops a real committed response; it does not invent product responses. It records request bodies on both sides of process death and checks exact identity plus no second epoch advance.
- The existing five-phase Android journey passed: reading-position/retry restoration after force-stop, keep/return and Activity recreation, unavailable-server behavior, and compact layout/recovery. See [regression environment](regression-environment.json) and [compiled source context](regression-build-context.json): the artifact-only screenshot test addition landed while this regression ran; product code did not change.

The final privacy run includes [environment and source hashes](privacy-environment.json), [pending request before process death](privacy-j003-pending-before.json), [restored result](privacy-j003-pending-after.json), and [foreign-binding result](privacy-j003-universe-binding.json). The [confirmation](privacy-j003-confirmation.png) and [cleared universe](privacy-j003-cleared.png) screenshots were captured inside the running Activity and visually inspected.

## Review corrections

Epoch persistence and private-cache removal now use one atomic preference write. Invalidated asynchronous operations cannot leave the app permanently busy or overwrite newer state. Cached Scrolls and pending clears carry a local universe binding; authenticated identity is checked before replay, and blank/foreign bindings purge local state without clearing server history. The separate reviewer rechecked these fixes and found no remaining actionable issue in that bounded review.

## Existing development history

Migration 0003 only creates the minimal clear-receipt table. The regular owner was never cleared. The [post-migration snapshot](development-history.json) retains counts and hashes: one universe, one Accounts row, six decisions, five Ledger rows, three exposures, two completed jobs, two Traces, three editorial assets and one device session. Counts match the prior dated observation. The attempted fresh pre-migration snapshot failed before producing a receipt, so this wave does **not** claim a fresh before/after hash comparison. Migration tests and SQL review cover the additive schema change.

The regular development API/worker were restarted from merged implementation with provider credentials withheld. [Observed service state](development-state.json) shows API health, a fresh worker and all three migration checksums. The updated regular app was installed without clearing its data; [owner receipt](owner-universe.json) and [visually inspected screen](owner-universe.png) show both original Traces at privacy epoch zero and the new control. These are dated observations, not a promise that services stay running. Legacy unbound local reading caches are deliberately purged on this upgrade; server history is preserved.

## Reproduction and limits

Run `pnpm exec tsx scripts/run-isolated-history-journey.ts` and, with one booted emulator, `python3 scripts/android-history-journey.py` after sourcing `scripts/env.sh`. Run Android journey scripts sequentially. Destructive checks use disposable databases and the separate `.journey` app.

Git IDs in receipts identify the checkout observed during each run; source hashes identify the implementation. The foreign-binding test injects only a previous-universe local namespace fixture, then checks real server history; it does not prove public account switching or identity recovery. No production deployment, backup erasure, account deletion, personalization pause, semantic reset, physical-device behavior, performance or usefulness claim follows. No MiniMax or Cutroom call ran. Receipt retention and the remaining privacy controls are explicit in ADR-0010; the full semantic/cosmic/social product remains target scope.
