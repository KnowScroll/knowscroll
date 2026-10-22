# modules/identity

Who a person is and how they sign in: accounts, their personal universe roots, email addresses,
single-use sign-in links and sessions (D-007, decided as the first-party implementation in D-022).

## Tables

| Table | Migration | Holds | Erasure |
|---|---|---|---|
| `identity.accounts` | `0001_identity` | One row per person: `status` (`active`/`suspended`) | Account deletion (privacy work) |
| `identity.universes` | `0001_identity` | The personal root: one per account (`universes_account_key`), `privacy_epoch`, `status`, `revision` | Account deletion |
| `identity.email_addresses` | `0007_identity_sign_in` | The account's normalised address (unique) and `disposable` (made by operator sign-in; cleared when the address proves itself by a mailed link) | Account table: account deletion |
| `identity.sign_in_links` | `0007_identity_sign_in` | SHA-256 of each link token, the address and its `domain`, `origin` (`email`/`operator`), the native `code_challenge` (or none), expiry ≤ 15 min (checked by the database), and who consumed it (`consumed_command_id`, `consumed_account_id`) | Account table: deleted a day after expiry by the scheduled sweep; account deletion removes the rest |
| `identity.sessions` | `0007_identity_sign_in` | SHA-256 of each session token, `client` (`web` cookie / `native` bearer), the redemption command that issued it (`issued_by_command`), expiry ≤ 30 days (checked), `revoked_at`/`revoked_reason` (`signed_out`, `signed_out_everywhere`, `replaced`) | Account table: an account's ended sessions are deleted at its next sign-in, and by the sweep 30 days after they ended; account deletion removes the rest |
| `ops.operator_sign_ins` | `0008_ops_operator_sign_ins` | The audit of every operator link: `world`, `issued_at`, `operator_source` (`cli:<user>`), `account_id`, `account_created` | Kept as an audit (not exploration history): clearing a universe leaves it; account deletion sets `account_id` to null (declared as an account-linked column) |

No token is ever stored: links and sessions are looked up by the hash of the presented token.
The erasure declaration (`adapters/erasure.ts`) lists the three account-keyed tables (the
inventory test fails for an undeclared identity table), the audit's account column, and
AgentMail's sent copies of sign-in mail, which no eraser of ours reaches. Clearing or resetting a
universe leaves identity alone.

## Public surface (`public.ts`, framework-free)

- Personal-scope types: `PersonalAuthority`, `PersonalScopeTx`, `SharedScopeTx`, `ScopeRefusal`,
  `WithPersonalScope`, `AuthorityHolds`, and for sign-in `WithResolvedPersonalScope` with
  `RootResolutionTx`/`RootResolution` (implemented by `infrastructure/postgres`).
- Read ports `ReadAccountUniverse`, `ReadUniverseAccess` (tokens `READ_ACCOUNT_UNIVERSE`,
  `READ_UNIVERSE_ACCESS`): claims that `withPersonalScope` rechecks under the lock.
- Sign-in use cases (tokens `REQUEST_SIGN_IN`, `PEEK_SIGN_IN_LINK`, `REDEEM_SIGN_IN`,
  `RESOLVE_SESSION`, `SESSION_VALID`, `SIGN_OUT`, `SWEEP_SIGN_IN_RECORDS`) and
  `IssueOperatorSignIn`, with their typed results; `OPERATOR_WORLDS`, `operatorAddressMatcher`;
  the sweep's queue `sweepSignInRecordsQueue` (`events.ts`).
- Built by `adapters/nest-providers.ts`: `identityProviders` (read ports), `identityUseCases`
  (all sign-in use cases over one database; the mail sender from `IdentitySettings`),
  `signInProviders` (Nest wiring), `operatorSignInUseCase` (the operator command alone),
  `identitySweepUseCase`/`identitySweepProviders` (the worker's sweep).

## Use cases

| Use case | Route | Authority, effects, failure |
|---|---|---|
| `requestSignIn({email, codeChallenge?})` | `POST /auth/sign-in` | None. A `codeChallenge` while native sign-in binding is off (`KS_NATIVE_SIGN_IN_BINDING`, the default on every world) → `refused: binding_not_enabled` (422, issue path `codeChallenge`; re-review N1). Accept the address only in a strict RFC 5321 subset (`domain/addresses.ts`: printable ASCII, one `@`, dot-atom local part ≤ 64, LDH domain with ≥ 2 labels and a non-numeric TLD, ≤ 254 in all; trimmed and lower-cased) or `refused` (422). One short transaction under the address lock: the address (3), and, each under its own advisory lock, recipient-domain (60) and world-wide (300) budgets per 15 minutes in that order, each counting only email links **already issued** (so malformed or refused requests spend none: review M2); the first full one → `rate_limited` (429 with `Retry-After`; a filled domain or world budget is logged once per window as `identity.sign_in_budget_full`), else insert the link hash (15 minutes, database clock) with the native app's challenge if any. After commit, one AgentMail send is started and **not awaited**: the answer is 202 for every acceptable address whether or not an account exists or the mail is delivered. No account is created. |
| `peekSignInLink({token, client, codeVerifier?})` | `POST /auth/peek` | Possession of the link. Read-only: for a web link the **full** address it opens (a mask such as `m•••@gmail.com` reads the same for a look-alike, and the holder could redeem the link and read the address anyway: re-review N6); for a native link the masked address, and only with its verifier; else `link_invalid`, exactly when redeeming it from this client would be. The redeem page shows "Continue as …" before it redeems (review m8). |
| `redeemSignIn({token, commandId, client, codeVerifier?})` | `POST /auth/redeem` | Possession of an unexpired, unconsumed link, and for a native link its verifier. One transaction (below). Unknown, expired, consumed-by-another-command, bound to another client (a native link needs its verifier; the web redeems only links without a challenge), operator links this world refuses (no operator sign-in, or an address outside its pattern), or a replay whose session has ended → `link_invalid` (400 `SIGN_IN_LINK_INVALID`, one answer for each). A suspended account → `account_unavailable`. Every refusal rolls everything back: a refused redemption consumes nothing (review m1). |
| `resolveSession(token)` | every authenticated request | Session unrevoked and unexpired, account and universe active; returns the account, its universe and the **current** privacy epoch (re-read every time, never remembered from sign-in). |
| `sessionValid({sessionId, accountId})` | sockets | The same session checks for a socket's session, on every subscribe and re-authorisation. |
| `signOut({sessionId, accountId, everywhere, reason?})` | `POST /auth/sign-out`; an account switch on a device (`replaced`) | One transaction: revoke the session (or all live sessions of the account) and `revokeAccountSockets` in the same transaction, so every API process drops the account's sockets on commit. |
| `issueOperatorSignIn({email})` | `dist/operator.js issue-sign-in` | Allow-listed worlds only (below). The address must match the world's pattern (`address_not_allowed`); finds or creates a **disposable** account, refuses an address that signed up by mail (`not_disposable`), writes a receipt, an operator link and the audit row, returns the link to print. |
| `sweepSignInRecords()` | pg-boss `identity.sweep-sign-in-records`, every 15 minutes (worker) | Deletes links a day past expiry and sessions 30 days after they ended, in transactions of at most 500 rows chosen `FOR UPDATE SKIP LOCKED` (never waits on or deadlocks with a sign-in; review m12). |

### Redemption, in one transaction

1. `lockLink`: read the link's address (no lock) → `pg_advisory_xact_lock` on the address →
   re-read the link `FOR UPDATE` (it now reflects any redemption that committed meanwhile).
2. Not bound to this client (PKCE-style S256: native needs the verifier of the link's challenge,
   the web a link without one), or an operator link this world refuses → stop. Consumed by this
   same command: the retry of a redemption whose answer was lost → enter that account's scope and
   replay. Consumed by another command, expired, unknown → stop.
3. Find the account by address, or insert the account, its address and its universe root
   (privacy epoch 1); a mailed link redeemed into a disposable account makes it a real one;
   consume the link for this command.
4. `WithResolvedPersonalScope` locks the universe root (`FOR NO KEY UPDATE`) and rechecks it exactly
   as `withPersonalScope` does; a refusal rolls back steps 1–3.
5. Receipt `(universe, commandId)`, operation `identity.redeem-sign-in`, request hash over the
   link's token hash and the client: identical replay → stored outcome, but only while a session
   this command issued is still live, which is revoked as `replaced` (a signed-out session is never
   revived: review m5); another request under the ID → `command_key_reused`; else insert it.
   Every refusal here throws, so steps 1–4 roll back too.
6. Issue a session (and delete the account's ended sessions), store the outcome
   `{accountId, universeId, accountCreated}` (version 1), commit. A replay issues a **fresh**
   session in place of the one whose token travelled only in the lost answer.

Concurrent retries of one redemption, two links for one new address, or several commands racing
for one link all serialise on the address lock: there is never a second account or universe for
an address (also enforced by `email_addresses_address_key` and `universes_account_key`).

## Lock order

**address (advisory) → (world sign-in budget, advisory) → sign-in link row → personal root → this
universe's rows**. Redemption and operator issue take them in this order; request-sign-in takes
the address lock and then the world budget's lock. Suspension
locks the universe row before changing the account status (so a command that passed its account
check cannot commit afterwards). Account deletion (privacy work) must take the address lock first,
then the root. Every wait is bounded by the personal-scope lock timeout (a timeout is a retryable
503).

## How sign-in works end to end

1. **Request.** The person enters an address on `/signin`; the client POSTs `/auth/sign-in`; the
   API answers 202 and AgentMail sends `<KS_PUBLIC_ORIGIN>/redeem#token=ksl_…`. The token rides in
   the URL **fragment**: it never reaches a server, proxy log or `Referer`.
2. **Open.** The link opens the client's redeem page (`/redeem`, served as the static web export;
   `/auth/*` is the API's). The page reads the fragment, removes it from the address bar, asks
   `POST /auth/peek` whose account it opens, and asks the person to confirm with one tap:
   "Continue as mary@example.com" (a link someone sent to sign you into *their* account says so;
   native shows the masked address).
   Nothing is consumed by opening the link: a mail scanner or prefetcher that fetches or even
   renders the page signs nobody in. A native app asked for its link with the S256 challenge of a
   verifier in its secure store, and redeems with that verifier.
3. **Redeem.** The tap POSTs `/auth/redeem {token, commandId, client, codeVerifier?}`. Web: the response sets
   `__Host-ks_session` (HTTPS) or `ks_session` (plain-HTTP development) — HttpOnly, SameSite=Lax,
   Path=/, Secure on HTTPS, 30 days — and carries no token; the redemption must come from the
   world's own origin. Native: the response carries the bearer token once, for the platform's
   secure store. A device that still presents a session (an account switch) has that session
   revoked by the API, so no live session is left behind whose token the device discarded.
4. **Use.** Every request presents `Authorization: Bearer kss_…` (native) or the cookie (web);
   the API's session caller adapter resolves it with `resolveSession`. A web session's token is
   accepted only as the cookie and a native one only as a bearer token. Cookie-authenticated
   POST/PUT/PATCH/DELETE must carry `Origin` equal to `KS_PUBLIC_ORIGIN`, and a cookie socket
   handshake likewise (`ORIGIN_NOT_ALLOWED`, 403). Sockets: bearer in `auth.token`, or the cookie.
   Every account request also names its scope, `X-KS-Scope: <accountId>:<privacyEpoch>` (a
   socket: `auth.scope`); the API refuses any other claim than the presented session's account
   and current epoch with `409 SCOPE_MISMATCH`, so a tab whose cookie another tab replaced, or a
   scope from before a privacy reset, is never served (review M1, m11). One guard in front of
   every `/v1` route checks it (`apps/api/src/http/scope-guard.ts`; opt-outs only through the
   reviewed `UNSCOPED_V1_ROUTES` in the contracts; a release test walks `apiContract`: re-review
   N3), and handlers take the caller it admitted. The client's AccountScope owns its own
   credential, ends before a switching redemption is sent, rereads the session on
   `SCOPE_MISMATCH`, and ignores a reread that answers after the credential changed (re-review N5).
5. **Sign out.** `POST /auth/sign-out` revokes the session (or every session) and drops the
   account's sockets; the next request with that credential is 401.

## Operator sign-in (D-007)

`node dist/operator.js issue-sign-in --email <address>` in the API release tree, on the server
shell as the world's v2 user with the world's environment (`docs/v2/operations/environments.md`).
Refused before touching the database, and again right before issuing, outside the allow-listed
worlds `dev`, `stage`, `ci`, `local` (never live, whatever a production world is called), when
`KS_ALLOW_OPERATOR_SIGN_IN` is not exactly `1`, or without a valid `KS_OPERATOR_SIGN_IN_PATTERN`
(one address, at most one `*` in the local part, a literal domain: dev and stage use
`*@test.knowscroll.space`, a domain that receives no mail). Only addresses matching the pattern
get a link, and the API checks the pattern again when the link is redeemed (an API without
operator sign-in refuses every operator link). It only ever opens disposable accounts (made by
itself; an address that proved itself by mail is `not_disposable`). Every use writes the audit
row in `ops.operator_sign_ins` (world, time, `cli:<SUDO_USER or USER>`, account), one
`identity.operator_sign_in` record (stderr; never the address, token or link) and a receipt in the
account's universe; the link is printed on stdout only. Operator links carry no native binding:
they are redeemed on the web.

## Mail

`adapters/agentmail-sender.ts` follows `docs/v2/operations/providers-and-secrets.md`: one
`POST /v0/inboxes/{inbox}/messages/send` with `Authorization: Bearer`, no retry, no redirect
following, the timeout (default 10 s) covering the body, at most 64 KiB read, success only for a
2xx whose body has a `message_id`; never throws; refuses to run inside a transaction. The use case
logs one `identity.sign_in_mail` record per send (`sent`, or `failed` with a fixed reason and the
HTTP status) without address, token, link or key. Production refuses to start unless the sender is
AgentMail and `AGENTMAIL_API_KEY`/`AGENTMAIL_INBOX_ID` are set (no other base URL). The CI fixture
sender (`adapters/fixture-mail-sender.ts`) records mail in memory or a JSON-lines file and is
refused outside `NODE_ENV=test` in a `ci`/`local` world.

## Failure behaviour

- A delivery failure is logged once and is otherwise invisible: the answer stays 202. The person
  asks again (a new link; there is no silent resend).
- A lost redemption answer: the client retries with the same `commandId` before the link expires
  and gets the same account with a fresh session.
- A lock wait beyond the timeout, a deadlock or a statement timeout: retryable 503, nothing written.
- A refused redemption (suspended account, stale receipt) writes nothing: the link stays usable.
- A lost access-revocation notice: the gateway rechecks `sessionValid` on every subscribe and
  relayed hint and makes every socket authenticate again after a relay reconnect.
- Rate limits: per API process 10 sign-in requests and 30 peeks or redemptions per client per 15
  minutes (an IPv6 client is its /64, an IPv4-mapped address its IPv4); taken first, so a
  client's junk spends only its own budget. That limiter is a flood brake, not a source of truth:
  it lives in memory, starts empty after a restart, and forgets the client counted longest ago
  once it counts 10,000, so a client spread over more addresses than that recycles its budget.
  What caps mail are the durable budgets, counting only links issued: 3 per address, 60 per
  recipient domain and 300 per world per 15 minutes (the domain and world ones each serialised
  by an advisory lock, so they hold exactly under concurrency: re-review N4).

## Before native sign-in binding is enabled (`KS_NATIVE_SIGN_IN_BINDING=1`; re-review N1)

It stays off on every world until the native app ships. With it on as built, anyone can ask three
links for a known address bound to a challenge only they hold: the person's mailbox fills with
links neither the web nor their app can redeem, and the per-address budget then refuses the
person's own requests for 15 minutes, repeatably. Before turning it on, one of:

- count the address budget per binding (`address, code_challenge`), so bound links never spend
  the budget the mailbox owner's own requests need; or
- let the web redeem a bound link with a short out-of-band code printed in the mail body (never in
  the URL), so whoever reads the mail can always sign in, while an interceptor of the URL alone
  still gets nothing.

Either needs its own tests (the review's probe p15 must stay a refusal for the attacker and a
working link for the owner).

## Before live (re-review N2, owner decision)

Fine for dev and stage (a handful of people). Junk no longer spends the budgets, but valid
addresses do and their mail goes out: about 30 IPv4 addresses per 15 minutes can fill the world
budget (300) and switch sign-in off for everyone, mailing strangers from the shared inbox; 6
addresses and 20 `@gmail.com` recipients fill one domain's budget (60). Options to decide before
live:

- at saturation keep answering 202 but send only to addresses that have an account, from a
  reserved budget (the answer stays identical, so no oracle);
- at saturation put a challenge or proof of work in front of `/auth/sign-in`;
- aggregate the per-client limit by IPv4 /24 and IPv6 /48 and count only links issued per client
  (durably, not in this process's memory).

## Not here yet

Privacy-epoch changes (privacy work) must call `revokeAccountSockets` in their transaction (the
scope claim already refuses an old epoch's requests if the notice is lost). Account deletion must
erase the account tables above and null `ops.operator_sign_ins.account_id`. Native magic-link
opening (universal/app links) needs mobile builds (owner decision 2); the device binding is built
and tested only against fixtures until then.

`CHECK_PERSONAL_OWNER_ACTIVE` (#239) reads the owning account's current `status` inside an already
locked personal scope, including for a system worker. Suspension operations follow the existing
root-before-account mutation protocol; this port adds no account row lock or reverse lock order.
Supply checks it before and after Content authority waits, before resolver effects. It observes
account suspension only. `withPersonalScope` still handles universe status/epoch; session/device
sign-out does not revoke an already accepted private demand or impersonate the original actor.

## Account authority fences (#246 prerequisite)

`accountAccessUseCases({ db, lockTimeoutMs })` in `adapters/nest-providers.ts` builds the
framework-free `FenceAccountPair`, `FenceOwnAccount` and internal `InvalidateOwnAccountAccess`
ports; `accountAccessProviders` binds their explicit public tokens. No HTTP route is installed.

For a peer operation: enter the actor's personal scope, take exactly two `identity.accounts`
`FOR SHARE` locks in sorted UUID order, then **separately** read both account/universe states
and epochs, then lock at most one shared root. Never lock a peer personal root. This uses the
existing one-universe-per-account constraint; account UUIDs and root ownership must never be
reused/reparented. The returned snapshots are valid only inside that transaction. Before private
context, receipt replay and final application, callers check the prepared participant epochs and
current pair/membership/visibility/source revisions; shared receipt hashes must include these
explicit authority inputs because shared receipts have no automatic actor epoch column.

Own profile/visibility/publication mutations take `FenceOwnAccount` (`FOR UPDATE`) before domain
rows. All epoch/status/root removal and access-revoking writers must take that own exclusive
fence under the personal root. Account deletion additionally takes Identity's address locks before
the root. Never take an account gate after a shared root or upgrade a pair SHARE gate. The runtime
scope guard refuses second gates, late acquisition and closed capabilities before SQL.

`invalidateOwnAccountAccess(authority, 'advance_epoch' | 'suspend')` is an internal authority
barrier: own root → own account UPDATE → increment epoch/revision → optional account suspension
→ commit-bound `revokeAccountSockets`. Both modes advance epoch; reactivation must retain the
new epoch. Counter exhaustion refuses without effects. The scope retains its frozen old epoch;
follow-on work needs a fresh scope. This operation does not erase data, complete a reset/delete,
create a privacy completion receipt or expose a public endpoint. Session logout keeps its existing
meaning. Global socket disconnect remains a disposable notice with the existing relay/cache
limits, not guaranteed instantaneous removal during relay outage.

## Selective Clear durable core (#345)

`clearExplorationFor` is an opt-in outer factory. It does not register a normal queue, HTTP route,
worker or client. Composition must provide the closed Reasoning accounting port and the complete
`explorationStores` runner, install `clearExplorationQueue`, and implement current-session privacy
error handling and client purge/refresh before exposing it. No owner clear, provider call or host
rollout follows from this source prerequisite.

Start/status enter a live `PrivacyScopeTx`: root lock → own-account UPDATE fence → fresh active
account/current-epoch checks → account-lifetime command lookup. Exact replay returns the immutable
original acceptance without advancing the epoch or enqueueing; its historical `toEpoch` never
supplies current authorization. Fresh acceptance records operation, bounded exact financial identities,
one epoch/revision advance, exact root barrier, socket revocation and required pg-boss work in one
marked transaction. A lost acknowledgment is recovered by exact retry under a fresh current session.

Ordinary personal scope, lock-free authority and socket access refuse an active barrier. Only the
existing Identity sign-in resolved-scope entry can issue/refresh sessions during the barrier. It is
not an exploration bypass; only Identity composition calls this entry, frozen by an Actions fixture.
Old personal receipts are removed through the accepted `fromEpoch`, preserving new auth receipts.

Worker delivery uses stored operation identity, never payload epochs or a selected cleanup phase.
Before `core_done_at`, a separate live `ClearCoreTx` runs owner callbacks in FK order. Every store
needs an explicit disposition. All Saved UUID/ref/revision/time/place/CAS tuples and all Social rows
are preserved. Owner callbacks delete history of every epoch/version and retained/dead queue data;
shared Content/Supply/Cutroom/pool are untouched. Completion and clearing only this barrier commit
together. The core capability is revoked immediately at completion. Later delivery obtains only
`ClearAccountingTx` bound to the captured set; it cannot erase fresh exploration or open a newer
operation's barrier. Core/completion timestamps, receipt fields and captured identities are guarded
against reversal or rewriting by migration 0034.

The financial exception retains marked/redacted current UTC budget-window links so Clear cannot
reset per-scope allowance. Unproved/dispatched/unknown liabilities remain pending; no privacy flag,
timeout or retry refunds or resends them. Exact terminal identities can be pruned after the window
closes without changing global/role receipts, late usage or brakes. The capture cap is 1000 tuples,
with SQL byte/identity guards before materialization (under 1 MiB); overflow/missing proof refuses
acceptance. `completed_live` permits this declared minimal resolved retention, and excludes backups,
provider copies and offline devices. Read-only status/replay never create reconciliation work.

All database/queue/race tests run in Actions only. Source opt-in composition is distinct from API,
client, worker drain, disposable runtime journey and dev/stage privacy acceptance.

Clear operations and their liability children are account-lifetime stores, not exploration rows.
They therefore use `account_id` plus a restricted `scope_id` universe FK and are both registered in
Identity's `accountTables` inventory. Insert guards require the account to own that scope and each
child to match its operation. Account/root deletion remains restricted until a future account
lifecycle handles these receipts explicitly. Omitting either declaration fails the existing schema
inventory. Keeping them out of the ordinary universe eraser preserves that eraser's established
semantics and assertions; tests separately prove lifetime receipts survive repeated selective Clear.

### Bounded durable recovery (migration 0035)

The opt-in `recoverClearOperationsQueue` is a strict version-only cron every five minutes.
`clearExplorationFor(...).recover()` discovers at most 25 existing operation IDs, then re-enters
root → account → exact operation maintenance with 250 ms lock and 2 s statement bounds. It rechecks
current pg-boss delivery state under that lock. An expired claim, exhausted/dead-lettered delivery
or lost worker does not become a second outbox or grant new user authority: the same transaction
records a coarse failure/cooldown and enqueues only that operation's fixed Clear job. Three recovery
waves with at least 15 minutes between waves bound automatic retries; exhaustion stays honestly
failed and requires separately authorized internal maintenance. A database outage cannot persist
an error while the database is unavailable; the normal durable schedule recovers once access returns.

Completion with current-UTC retained accounting links also stores `cleanup_due_at` at next UTC
midnight atomically with its required exact-set cleanup job. A separate cleanup recovery counter
and cooldown cover loss/exhaustion of that post-completion delivery. This completed-operation path
can verify/prune only captured identities and clear its due marker. It never rewrites completion,
sets a failure on a completed receipt, reopens core removal, clears a later barrier, or creates
endless completed wakeups. The marker cannot be retimed or reintroduced after it is cleared.
Migration 0035 derives a due marker for preexisting completed receipts from Identity's own captured
budget-window identities; it never reads or changes request/output bytes or financial states.

Source remains opt-in. Normal queue/scheduled consumer registration and installed-release recovery
are separately composed; neither status reads nor command replay perform recovery.

Discovery uses immutable operation-ID keyset pages: read 26, process at most 25. A version-only
scheduled job captures the current maximum operation ID. Before exact operation work, the same
bounded discovery transaction persists at most one fixed-queue continuation carrying strictly
advancing `afterOperationId` and that unchanged `throughOperationId`. Live or root-busy heads
therefore cannot hide a later orphan. The final page never creates a child; accepted operations
above the captured ceiling wait for a later cron pass. Identical live cursor/ceiling children
are deduplicated under a bounded transaction advisory lock using pg-boss retention/lease/heartbeat
semantics. This lock grants no personal authority. Each delivery is bounded; a whole finite pass
may span many deliveries. Overlapping cron passes can inspect the same operations and can have
different ceilings; exact operation locks, live-delivery rechecks and capped counters still govern
effects. This does not promise a global once-only scan or recovery while the queue/database stays
unavailable. Missing/exhausted continuation deliveries are revisited by later scheduled passes.

## Recording policy prerequisite (#381)

`recordingPolicyFor(db,{lockTimeoutMs})` exposes opt-in `set` and `read` use cases over the strict
recording-policy.v1 contracts. No controller, control, collection path or worker is installed.
This prerequisite alone does not implement Pause: every evidence/growth owner must carry and
fence original generations before the API and P02 can be exposed.

0041 adds on/generation to the existing personal root, initial1/on, odd/on and even/off. A SQL
trigger allows only identical fields or exactly one generation increment with a boolean flip;
Clear/epoch changes leave both fields untouched. No reset/wrap is possible. New accepted commands,
including no-ops, advance the existing root revision once. Reads and replay never advance it.

Set enters the existing genuine personal root, then own-account UPDATE gate, then a fresh current
root/account/epoch/barrier read BEFORE account-lifetime command lookup. The command key is
(account,command UUID); it stores the exact original validated body (canonical hash, preserving
UUID spelling), actual owner/root, requested epoch, from/to/on/changed/time and outcome version1.
Changed bodies conflict. Fresh stale expectations refuse; an exact old authorized retry can
recover its immutable ACK after later toggles or completed Clear without retoggling. An old ACK
is not the current policy. Pure reads echo readId/target/current scope/root revision/policy and
separate historical command receipt. Neither read nor replay repairs or enqueues anything.

Identity's public `FencePersonalRecording(personal,originalGeneration)` is an additive capability
for new durable personal contributions. Its Postgres implementation rechecks current root/owner,
active account, epoch/barrier and original-current on generation under the already-held root.
Undefined legacy generation is accepted ONLY initial1/on, and is permanently refused after any
actual toggle. It takes no second root, account-gate upgrade or lease. `RecordingScopeTx` and
`recordingTransactionOf` preserve genuine personal capability lifetime and reject copied/fabricated
or closed objects. This capability must be freshly checked at each later personal application;
never relabel delayed work with the latest generation. Necessary explicit commands retain their
existing PersonalScopeTx authority while recording is off.

recording_commands is an immutable account-lifetime receipt store in Identity's account-deletion
inventory. Selective Clear preserves it and root policy. No account deletion/export executor,
authentication bypass, shared-production suspension or provider/accounting permission follows.
Authored synthetic lock/SQL/Clear fixtures run in Actions only; source/static/schema evidence is
not deployed end-to-end Pause or disposable-account dev acceptance.

## Fresh recording lifecycle (0044; source only)

Actual createAccount explicitly inserts mode1, whose root INSERT trigger atomically records the
account/epoch1 birth witness. Disposable operator accounts use that same creation path. Existing
NULL roots, timestamps, missing state and old Clear receipts cannot claim birth. The fixed current
backend erasure runner checks the canonical v1 registry, invokes the actual frozen owner callbacks
and catalogue verifier, and issues a live ClearCoreTx proof. Generic registries cannot issue it.
coreDone writes its timestamp, creates the current witness and releases the barrier atomically.
It does not wait for old unknown financial liabilities; recording generation/on and account
recording receipts retain their account-lifetime values.

READ_RECORDING_LIFECYCLE takes a genuine RecordingScopeTx after the caller's sole owning-account
UPDATE gate. It reads current owner/epoch/status/barrier/g plus the exact witness; it neither
acquires another root/account lock nor repairs anything. Fresh, legacy_unknown, not_ready and unavailable are distinct. not_ready means a valid mode1
root/current original generation and actual own fence, with its current owner/epoch witness
absent. Necessary commands remain available with no eligible origin/session/credit; this never
grants legacy fallback. Genuine authority/protocol/dependency failure remains a hard refusal. A private live scope brand is issued only by the actual successful own UPDATE/fresh read; root-only, pair-only and failed-own scopes are unavailable. Copied/closed scopes fail. Full erasure removes this exploration witness; account
deletion also owns its account FK. No automatic recertification follows erasure or sign-in replay.
No API/control, provider permission or complete Pause/runtime acceptance is introduced.
