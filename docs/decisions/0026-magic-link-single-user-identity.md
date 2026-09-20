# ADR-0026 — Real sign-in: one owner account, email magic link

Date: 2026-09-20. Status: accepted — **owner decision** ("sign-in let's do magic link and v1 is
single-user"), recorded by the coordinator for #2 under #4/#12/#72. Extends
[ADR-0009](0009-device-sessions-and-privacy-epochs.md) (device sessions and privacy epochs); does not
change [ADR-0010](0010-clear-scroll-history.md).

## Context

Both surfaces authenticate today with an operator-issued development token baked into a build:
Android reads `KS_DEV_TOKEN` from `local.properties`, and the web app's dev server injects the same
token server-side. That is deliberately not production identity, and it blocks owner acceptance,
release builds and every privacy control that depends on "who is this".

The owner chose **email magic link** and **single-user v1**: one account, the owner's, with no
password to steal and no third-party identity provider in the path.

## Decision

### 1. Exactly one account in v1, enforced by the database

An `account` holds a normalised email and nothing else about a person. A unique index permits **one
row**, so a second account cannot be created by any code path; relaxing that is a later migration and
a deliberate decision, not a config flag. The existing universe is adopted by that account on first
sign-in, so the owner's history is theirs rather than an orphan of the development token. A universe's
account binding, once set, never changes.

### 2. Requesting a link tells an attacker nothing

`POST /v1/auth/magic-link {email}` always answers `202` with no body detail, whatever the address.
Only the configured owner address (`KS_OWNER_EMAIL`, ignored local configuration) ever produces a
token. Requests are rate-limited per address and per coarse requester fingerprint, and the limit is
enforced in the same transaction that issues the token, so parallel requests cannot exceed it.

### 3. The token is a single-use secret, stored only as a hash

32 random bytes, presented base64url; stored as SHA-256 like a device session token, never logged,
never in a URL we record. It expires in 15 minutes, is consumed exactly once under a row lock, and is
bound to its purpose and address. An expired, consumed, unknown or mismatched token is one
indistinguishable refusal. Consuming a token issues a device session through the existing
`device_session` path, with its own expiry, revocation and privacy epoch.

**The link opens a page, not the consumption.** Email scanners and link previewers follow `GET`, so a
`GET` with the token only renders a confirmation surface; the token is consumed by an explicit `POST`
from that surface. A prefetched link therefore cannot sign anybody in or burn the token.

### 4. Delivery is a port, and this slice ships only a local sink

`MagicLinkSender` has one implementation here: a development sink that writes the link to a file
under `KS_DEV_ROOT` with mode 0600 and never prints it. Real email needs a provider the owner has not
supplied; until one is configured, a production-mode process refuses to start rather than pretending
mail was sent. No provider credential enters this repository, a client or a worker lane.

### 5. What does not change

Privacy epochs, Clear History, Trace revisit, the projection worker and every existing authorization
check keep working exactly as they do; sign-in creates a session, nothing more. Signing in never
changes an epoch and never erases anything. The development token keeps working for local runs and
existing journeys, marked deprecated, and is refused in production mode.

### 6. What this ADR does not do

No sign-in UI on either surface (the next slice), no account deletion or email change, no multi-user
anything, no recovery flow beyond requesting another link, no session listing or per-device naming,
and no production deployment.

## Alternatives and why

- *Passwords:* a credential to steal, store and rotate for one user. Rejected.
- *Google or Apple sign-in:* a third party in the identity path of a private universe, plus per-client
  SDK work on two surfaces. Rejected for v1; possible later without changing the account model.
- *Consume the token on `GET`:* simplest, and quietly broken by every email scanner that prefetches.
- *Multi-user now:* the product's privacy model (per-universe epochs, Blend, projections) deserves its
  own design; the single-row index makes the boundary explicit instead of half-built.

## Consequences

Owner acceptance and release builds become possible once the sign-in UI and a real mail provider
exist. The owner must set `KS_OWNER_EMAIL`, and must choose a mail provider before any non-local use:
that is an open owner decision recorded in the checkpoint. Single-user means the social areas of v1
(#11 Blend, friend universes) stay explicitly out of reach until the account model is widened, which
is now a visible migration rather than an assumption.
