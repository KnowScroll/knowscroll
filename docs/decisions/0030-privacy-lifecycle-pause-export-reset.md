# ADR-0030 — Privacy lifecycle: pause, export and reset

## Status

Contract only: this ADR and migration `0020_privacy_lifecycle.sql` land ahead of any HTTP route,
`packages/db/src/privacy.ts` export, or client surface. Nothing described here is reachable yet.
It extends [ADR-0009](0009-device-sessions-and-privacy-epochs.md)'s session/epoch fence and
[ADR-0010](0010-clear-scroll-history.md)'s Clear boundary; it does not contradict, replace, or
loosen either. It also does not touch the generated-Reel supply chain
([ADR-0023](0023-generated-reel-supply.md)–[0025](0025-eligible-reels-in-inventory.md)), because
`generation_brief`/`generation_job`/`cutroom_attempt`/`media_object`/`generated_reel` carry no
`universe_id` — they are shared editorial-pipeline state, not personal data, exactly as those ADRs
already say Clear does not touch them.

## Context

ADR-0010 shipped one bounded control, Clear Scroll history, and explicitly listed three things it
is not: a reversible pause, a full export, and a stronger dependency-aware reset. Issue #4 asks for
those three now, honestly bounded to what the current schema can actually do — no semantic-entity
system exists yet (target chapter 04), so "reset" here cannot be the future semantic reset ADR-0010
reserved; it is a stronger version of the present bootstrap-scope erasure.

## Decision

Add three operations, all universe-scoped, all requiring `authenticateAndLock` (universe lock
before any session/domain row, matching ADR-0009's lock order), all rechecking the authenticated
session's expiry/revocation/epoch **after** the lock wait resolves — a session read before waiting
for the lock is not durable authorization once the wait is over.

### Pause / resume

`POST /v1/privacy/pause` and `POST /v1/privacy/resume`, each accepting exactly
`{requestId: UUID, expectedPrivacyEpoch: nonnegative integer}`. Under the universe lock: an
identical `(universe, requestId)` key replays its receipt; a reused key with a different expected
epoch returns 409; an unknown key requires `expectedPrivacyEpoch === current epoch` or 409, exactly
Clear's replay contract. On success, the caller sets `universe.recording_paused_at` (to
`clock_timestamp()` for pause, to `NULL` for resume) and inserts one `privacy_recording_receipt`
row in the same transaction — the receipt-guard trigger refuses to record "paused" unless the
universe is actually, at that moment, marked paused, so the two facts cannot drift apart.

**Pause does:** stop new exposure, keep and explicit-Ask facts for this universe. The
`ledger_pause_guard` trigger refuses any new `ledger` row for a paused universe's `universe_id`,
regardless of which code path attempts the insert — this is the database's own refusal, not a
promise kept only by `apps/api`. Because `job(project_keep)` and `explicit_ask` both require a
freshly inserted `ledger` row to reference, blocking that insert transitively blocks new keep-jobs
and new Asks without a second guard. The interface can state precisely: *while paused, we do not
record what you're shown or what you keep or ask; you can still read.*

**Pause does NOT:** erase, hide, or reclassify anything recorded before the pause (existing
`ledger`/`decision`/`exposure`/`trace`/`job`/reasoning rows are untouched and remain readable).
Does not stop the served feed/candidate generation (`decision` rows) — browsing continues. Does not
advance the privacy epoch, because nothing is erased or invalidated, so no client cache needs
purging and no other device is signed out. Does not withdraw or discard reasoning work already
admitted before the pause; it only prevents new admission that would itself require a new Ask or
keep ledger row. Does not distinguish per device — pause is universe-wide, matching every other
privacy control in this system, so one device pausing pauses recording for all of them.

### Export

`POST /v1/privacy/export`, accepting exactly `{requestId: UUID, expectedPrivacyEpoch: nonnegative
integer}`. Under the universe lock, with the same epoch-precondition contract as above (a stale
`expectedPrivacyEpoch` — for example because a Reset happened since the client last read the
Universe receipt — returns 409 rather than silently exporting a different, smaller universe than
the one the caller thinks they're reading). Unlike Clear, an export retry is **not** promised to be
byte-identical to an earlier attempt at the same `requestId`: export is read-only, so re-running it
is safe, and if real activity happened between two attempts (the person kept reading while a
network response was lost), a fresh export correctly includes it. What retry does guarantee: the
`(universe, requestId)` key inserts at most one `privacy_export_receipt` row — the receipt is
idempotent bookkeeping and a manifest, not a frozen copy of the content, so it cannot itself become
stale data that a later Reset would need to separately erase.

**Export includes**, generated live from current rows: the account's own `email`; `universe.id`,
`revision`, `privacy_epoch`, `recording_paused_at`; `accounts.kept_asset_ids`/`revision`; every
`decision` row for the universe (what was ever served); every `ledger` row (`exposure`, `keep`,
`ask` — the full recorded event stream, including each Ask's literal question, which lives in the
ledger payload); every `exposure` and `trace` row; every `job` row (`project_keep` processing
status); every `device_session` row's non-secret fields (`device_id`, `origin`, `created_at`,
`expires_at`, `revoked_at` — never `token_hash`); and, for reasoning, every `reasoning_job`,
`reasoning_step`, `reasoning_receipt` and `reasoning_accounting` row scoped to the universe
(status, class, timestamps, and recorded token/cost usage — the evidence that reasoning ran and
what it cost, not its internal working state).

**Export does NOT include:** any other universe's data or the shared editorial asset/Scroll
library (not personal data); session `token_hash` or any bearer secret; the sealed
`reasoning_context_payload.canonical_payload` bytes (the internal compiled prompt built from a
read-set of public and universe evidence) — only `reasoning_context.content_hash`, because that
payload is a derived computation artifact re-buildable from the included rows, not a distinct fact
recorded about the person; anything from the generated-Reel supply chain (shared, not personal);
and it does not itself change any recorded state or advance the privacy epoch.

### Reset

`POST /v1/privacy/reset`, accepting exactly `{requestId: UUID, expectedPrivacyEpoch: nonnegative
integer, confirmation: "reset-personal-universe"}` — a deliberate confirmation literal, matching
Clear's pattern, because this is irreversible. Under the universe lock, with Clear's exact replay
contract (identical key replays the stored receipt; reused key with a different expected epoch is
409; unknown key requires the current epoch or 409). On success, in one transaction:

1. Perform every step of `clearScrollHistory` (ADR-0010): erase this universe's `job`, `trace`,
   `exposure`, `ledger` and `decision` rows and the reasoning erasure it already runs; reset
   `accounts.kept_asset_ids` and bump its revision; advance `universe.privacy_epoch` by exactly one
   via the same conditional `UPDATE ... WHERE privacy_epoch = $current` pattern (a concurrent
   change fails the row match rather than being silently overwritten).
2. **Beyond Clear:** revoke every `device_session` row for this universe with `revoked_at IS NULL`
   — including the calling session. Clear deliberately rolls the calling session forward so the
   person doing the clearing stays signed in; Reset does not keep any session alive. This is the
   one concrete, schema-checkable difference that makes Reset "stronger": after Reset, the person
   who asked for it must sign in again like everyone else, and `privacy_reset_receipt` records
   `sessions_revoked >= 1` as evidence that at least the caller's own session ended.
3. Insert one `privacy_reset_receipt` row (`epoch_before`, `epoch_after = epoch_before + 1`,
   `sessions_revoked`, `reset_at`).

Failure at any point rolls everything back, exactly as Clear's transaction does.

**Reset does NOT:** touch `sign_in_token`. A live sign-in token is already immutable and capped at
15 minutes from creation (ADR-0026's `sign_in_token_guard` forbids changing `expires_at` at all),
so there is no long-lived pending token for Reset to invalidate — it already expires on its own
within minutes, and Reset does not need, and must not attempt, to shorten an immutable lifetime.
Reset does NOT delete the `account` row, the `universe` row, or the account/universe binding —
full account deletion remains explicitly future work per ADR-0010, and Reset is not it. Reset does
NOT touch the generated-Reel supply chain (not personal data, per Context above). Reset does NOT
retain a payload snapshot of what it erased — `privacy_reset_receipt` carries only counts-free
metadata (epochs, a session count, a timestamp), the same erasure-compatible shape as
`history_clear_receipt`. Reset does NOT retire `reasoning_accounting`/`reasoning_receipt` rows —
those are financial/audit evidence already retained across Clear for the same reason, and Reset
inherits that retention limit rather than silently widening it.

## Alternatives and why

**Have pause write an epoch-advancing "paused" marker:** would purge other devices' valid caches
and force re-sync for a change that deleted nothing — dishonest cost for no protective benefit.
**Store the exported content in its own receipt for exact-replay idempotency:** recreates the
retained-copy problem ADR-0010 already rejected, and the copy would itself need an erasure rule.
**Have Reset also revoke `sign_in_token`:** blocked by an existing hard invariant
(`sign_in_token_guard`); a 15-minute cap already bounds the exposure, so working around the
invariant would trade a real guarantee for a redundant one. **Fold Reset into Clear as a flag:**
would let one HTTP shape silently vary in destructiveness by an easily-missed body field; a
separate route with its own confirmation literal makes the stronger action explicit at the call
site. **Have Reset delete the account:** conflates "stronger bootstrap-scope erasure" with account
deletion, which ADR-0010 already deferred with its own unresolved retention/backup questions;
mixing them would make Reset's blast radius impossible to state exactly.

## Consequences

A person can stop new recording without losing history, read everything the database actually
holds about them, and erase more thoroughly than Clear — ending their own session too — with each
operation's exact boundary stated rather than implied. `packages/db/src/privacy.ts`,
`apps/api` routes, the Universe receipt (`recordingPausedAt`), and both mobile and web privacy UI
remain unimplemented; none of this is reachable until those land. The next migration number after
`0017` and ADR number after `0028` are free for whichever lane implements the routes.

## Sources / verification

ADR-0009, ADR-0010, ADR-0026's `sign_in_token_guard`, and target `04-EVENT-ARCHITECTURE.md`
inform the boundary. No runtime evidence exists for this contract yet — that is `pnpm typecheck`
and `pnpm test` only, proving the migration applies, its triggers behave, and nothing else regresses,
not that any operation works end to end. Required future evidence: real pause blocking a real
exposure/keep/ask insert and not blocking a keep-job that already existed; real export row counts
matching a hand-checked universe; real Reset erasing a nonempty universe, revoking a nonempty
session set, and a subsequent request from the calling session's old token failing 401; concurrent
distinct requests on the same starting epoch for each operation; and Android/web reconciliation
against a Reset epoch the same way ADR-0010 requires for Clear.
