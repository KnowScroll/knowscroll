# modules/identity

Who a person is and how they sign in: accounts, their personal universe roots, email addresses,
single-use sign-in links and sessions (D-007, decided as the first-party implementation in D-018).

## Tables

| Table | Migration | Holds | Erasure |
|---|---|---|---|
| `identity.accounts` | `0001_identity` | One row per person: `status` (`active`/`suspended`) | Account deletion (privacy work) |
| `identity.universes` | `0001_identity` | The personal root: one per account (`universes_account_key`), `privacy_epoch`, `status`, `revision` | Account deletion |
| `identity.email_addresses` | `0007_identity_sign_in` | The account's normalised address (unique) and `disposable` (made by operator sign-in) | Account table: account deletion |
| `identity.sign_in_links` | `0007_identity_sign_in` | SHA-256 of each link token, the address, `origin` (`email`/`operator`), expiry ≤ 15 min (checked by the database), and who consumed it (`consumed_command_id`, `consumed_account_id`) | Account table: deleted a day after expiry by the request path; account deletion removes the rest |
| `identity.sessions` | `0007_identity_sign_in` | SHA-256 of each session token, `client` (`web` cookie / `native` bearer), expiry ≤ 30 days (checked), `revoked_at`/`revoked_reason` | Account table: an account's ended sessions are deleted at its next sign-in; account deletion removes the rest |

No token is ever stored: links and sessions are looked up by the hash of the presented token.
The erasure declaration (`adapters/erasure.ts`) lists the three account-keyed tables (the
inventory test fails for an undeclared identity table) and AgentMail's sent copies of sign-in
mail, which no eraser of ours reaches. Clearing or resetting a universe leaves identity alone.

## Public surface (`public.ts`, framework-free)

- Personal-scope types: `PersonalAuthority`, `PersonalScopeTx`, `SharedScopeTx`, `ScopeRefusal`,
  `WithPersonalScope`, `AuthorityHolds`, and for sign-in `WithResolvedPersonalScope` with
  `RootResolutionTx`/`RootResolution` (implemented by `infrastructure/postgres`).
- Read ports `ReadAccountUniverse`, `ReadUniverseAccess` (tokens `READ_ACCOUNT_UNIVERSE`,
  `READ_UNIVERSE_ACCESS`): claims that `withPersonalScope` rechecks under the lock.
- Sign-in use cases (tokens `REQUEST_SIGN_IN`, `REDEEM_SIGN_IN`, `RESOLVE_SESSION`,
  `SESSION_VALID`, `SIGN_OUT`) and `IssueOperatorSignIn`, with their typed results.
- Built by `adapters/nest-providers.ts`: `identityProviders` (read ports), `identityUseCases`
  (all sign-in use cases over one database; the mail sender from `IdentitySettings`),
  `signInProviders` (Nest wiring), `operatorSignInUseCase` (the operator command alone).

## Use cases

| Use case | Route | Authority, effects, failure |
|---|---|---|
| `requestSignIn({email})` | `POST /auth/sign-in` | None. Normalise the address (NFC, trim, lower-case). One short transaction under the address lock: ≥ 3 links for the address in 15 minutes → `rate_limited` (429 with `Retry-After`), else insert the link hash (15 minutes, database clock) and delete links that expired over a day ago. After commit, one AgentMail send is started and **not awaited**: the answer is 202 for every well-formed address whether or not an account exists or the mail is delivered. No account is created. |
| `redeemSignIn({token, commandId, client})` | `POST /auth/redeem` | Possession of an unexpired, unconsumed link. One transaction (below). Unknown, expired, consumed-by-another-command, or operator links where operator sign-in is off → `link_invalid` (400 `SIGN_IN_LINK_INVALID`, one answer for each). A suspended account → `account_unavailable`, rolling back the consumption. |
| `resolveSession(token)` | every authenticated request | Session unrevoked and unexpired, account and universe active; returns the account, its universe and the **current** privacy epoch (re-read every time, never remembered from sign-in). |
| `sessionValid({sessionId, accountId})` | sockets | The same session checks for a socket's session, on every subscribe and re-authorisation. |
| `signOut({sessionId, accountId, everywhere})` | `POST /auth/sign-out` | One transaction: revoke the session (or all live sessions of the account) and `revokeAccountSockets` in the same transaction, so every API process drops the account's sockets on commit. |
| `issueOperatorSignIn({email})` | `dist/operator.js issue-sign-in` | dev/stage only (below). Finds or creates a **disposable** account, refuses an address that signed up by mail (`not_disposable`), writes a receipt and an operator link, returns the link to print. |

### Redemption, in one transaction

1. `lockLink`: read the link's address (no lock) → `pg_advisory_xact_lock` on the address →
   re-read the link `FOR UPDATE` (it now reflects any redemption that committed meanwhile).
2. Consumed by this same command: the retry of a redemption whose answer was lost → enter that
   account's scope and replay. Consumed by another command, expired, unknown → stop.
3. Find the account by address, or insert the account, its address and its universe root
   (privacy epoch 1); consume the link for this command.
4. `WithResolvedPersonalScope` locks the universe root (`FOR NO KEY UPDATE`) and rechecks it exactly
   as `withPersonalScope` does; a refusal rolls back steps 1–3.
5. Receipt `(universe, commandId)`, operation `identity.redeem-sign-in`, request hash over the
   link's token hash and the client: identical replay → stored outcome; another request under the
   ID → `command_key_reused`; else insert it.
6. Issue a session (and delete the account's ended sessions), store the outcome
   `{accountId, universeId, accountCreated}` (version 1), commit. A replay issues a **fresh**
   session: the first session's token travelled only in the lost answer.

Concurrent retries of one redemption, two links for one new address, or several commands racing
for one link all serialise on the address lock: there is never a second account or universe for
an address (also enforced by `email_addresses_address_key` and `universes_account_key`).

## Lock order

**address (advisory) → sign-in link row → personal root → this universe's rows**. Redemption and
operator issue take them in this order; request-sign-in takes only the address lock. Suspension
locks the universe row before changing the account status (so a command that passed its account
check cannot commit afterwards). Account deletion (privacy work) must take the address lock first,
then the root. Every wait is bounded by the personal-scope lock timeout (a timeout is a retryable
503).

## How sign-in works end to end

1. **Request.** The person enters an address on `/signin`; the client POSTs `/auth/sign-in`; the
   API answers 202 and AgentMail sends `<KS_PUBLIC_ORIGIN>/redeem#token=ksl_…`. The token rides in
   the URL **fragment**: it never reaches a server, proxy log or `Referer`.
2. **Open.** The link opens the client's redeem page (`/redeem`, served as the static web export;
   `/auth/*` is the API's). The page reads the fragment, removes it from the address bar, and asks
   the person to confirm with one tap. Nothing is consumed by opening the link: a mail scanner
   or prefetcher that fetches or even renders the page signs nobody in.
3. **Redeem.** The tap POSTs `/auth/redeem {token, commandId, client}`. Web: the response sets
   `__Host-ks_session` (HTTPS) or `ks_session` (plain-HTTP development) — HttpOnly, SameSite=Lax,
   Path=/, Secure on HTTPS, 30 days — and carries no token; the redemption must come from the
   world's own origin. Native: the response carries the bearer token once, for the platform's
   secure store.
4. **Use.** Every request presents `Authorization: Bearer kss_…` (native) or the cookie (web);
   the API's session caller adapter resolves it with `resolveSession`. A web session's token is
   accepted only as the cookie and a native one only as a bearer token. Cookie-authenticated
   POST/PUT/PATCH/DELETE must carry `Origin` equal to `KS_PUBLIC_ORIGIN`, and a cookie socket
   handshake likewise (`ORIGIN_NOT_ALLOWED`, 403). Sockets: bearer in `auth.token`, or the cookie.
5. **Sign out.** `POST /auth/sign-out` revokes the session (or every session) and drops the
   account's sockets; the next request with that credential is 401.

## Operator sign-in (D-007)

`node dist/operator.js issue-sign-in --email <address>` in the API release tree, on the server
shell with the world's environment (`docs/v2/operations/environments.md`). Refused before touching
the database, and again right before issuing, when `KS_WORLD=live` or `KS_ALLOW_OPERATOR_SIGN_IN`
is not exactly `1`; the API also refuses to start with the flag in live, and refuses operator links
wherever the flag is not set. It only ever opens disposable accounts (made by itself). Every use
writes one `identity.operator_sign_in` record (stderr; never the address, token or link) and a
receipt in the account's universe; the link is printed on stdout only.

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
- Rate limits: 3 links per address per 15 minutes (durable, per address, whoever asks); per API
  process 10 sign-in requests and 30 redemptions per client address per 15 minutes, and 300
  sign-in requests in all (in memory; resets with the process, which only loosens it).

## Not here yet

Privacy-epoch changes (privacy work) must call `revokeAccountSockets` in their transaction and the
client remounts its AccountScope on the new epoch. Account deletion must erase the account tables
above. Native magic-link opening (universal/app links) needs mobile builds (owner decision 2).
