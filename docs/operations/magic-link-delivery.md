# Magic-link email delivery (AgentMail)

[Issue #106](https://github.com/KnowScroll/knowscroll/issues/106) implements the real
`MagicLinkSender` [ADR-0027](../decisions/0027-agentmail-magic-link-delivery.md) defines on top of
[ADR-0026](../decisions/0026-magic-link-single-user-identity.md)'s sign-in. Delivery stays a port
(`apps/api/src/magic-link-sender.ts`): the development sink (a local file, ADR-0026 section 4) and
`AgentMailSender` (`apps/api/src/agentmail-sender.ts`) are its only two implementations, and
`POST /v1/auth/magic-link`'s `202` never varies with which one is configured or whether it succeeded.

## Choosing a sender: `KS_MAIL_SENDER`

- Unset, or `dev-sink`: the development sink. Requires `KS_DEV_ROOT` (see
  [development.md](development.md)); writes the confirmation link to
  `$KS_DEV_ROOT/sign-in/magic-link.txt`, mode `0600`, holding only the most recent link.
- `agentmail`: the real AgentMail sender. Requires `AGENTMAIL_API_KEY` and `AGENTMAIL_INBOX_ID`
  (below) to both be present, or `createMagicLinkSender()` refuses at startup with a
  `invalid_config` error rather than falling back to the sink.
- Any other value is a configuration error, never a silent fallback to either sender.

**In `NODE_ENV=production`, `KS_MAIL_SENDER` must be exactly `agentmail`, fully configured.** There
is no path from production back to the development sink: a deployment that cannot send real mail
refuses to start rather than quietly writing links to a local file nobody but this machine can read.
(`apps/api/src/main.ts` already refuses every production-mode start unconditionally today, ahead of
this check ever running; this check exists so that remains true independently once that changes.)

## AgentMail configuration

Set these as ordinary process environment variables — naming them here, never their values:

- `AGENTMAIL_API_KEY` — the inbox's bearer credential. Read once per process from the environment
  the API is started with; never written to this repository, a lane `.env` committed anywhere, a
  log line, an error message, a receipt or any file this code writes. The owner's key lives only in
  the owner's own `.env` and is never given to a worker lane.
- `AGENTMAIL_INBOX_ID` — the sending/receiving inbox (the owner's is `knowscroll@agentmail.to`).
  Not a secret, but still configuration rather than a literal in code, since it is part of the
  request path (`/v0/inboxes/{inbox}/messages/send`).
- `AGENTMAIL_BASE_URL` — optional. Exists **only** so a test can point `AgentMailSender` at a local
  fake HTTP server instead of the real host; leave it unset in every real deployment, where it
  defaults to `https://api.agentmail.to`.
- `AGENTMAIL_TIMEOUT_MS` — optional. Bounds the one attempt AgentMail gets per send; unset means the
  documented default of 10 seconds (`AGENTMAIL_TIMEOUT_MS` export in `agentmail-sender.ts`). Exists
  so a test can bound a stalled-connection scenario without waiting out the real default; a real
  deployment should not normally need to set this.

## What a send does, and does not, do

One `POST /v0/inboxes/{inbox}/messages/send` with `Authorization: Bearer <key>` and a strict
`{to, subject, text, html}` body (the link appears in both `text` and `html`); a bounded response
read; **no automatic retry** and no redirect ever followed (ADR-0027 section 1 — a retry is the
person asking for another link, and a silently resent mail would mint a second live token nobody
asked for). A 2xx response is only trusted if its body actually parses and carries a `message_id`;
anything else — a non-2xx status, a connection refusal, a timeout, or a 2xx with a malformed or
empty body — is a delivery failure.

**A delivery failure never changes `POST /v1/auth/magic-link`'s response.** The route always answers
`202 {"status":"requested"}`, identically, whether the address was the owner's, whether a token was
actually issued, and whether the chosen sender succeeded — exactly as ADR-0026 section 2 already
requires for the no-enumeration guarantee, now extended to delivery itself (ADR-0027 section 3).

## What a failure looks like in the log

Fastify's own logger is disabled application-wide (`Fastify({logger:false})`), so a failing send
writes one structured JSON line to **stderr**, matching the convention `apps/worker/src/**/main.ts`
already uses for operator-visible events:

```
{"service":"api","event":"magic_link_send_failed","httpStatus":<number|null>,"reason":"<http_error|timeout|network_error|malformed_response|unknown>","messageId":<string|null>}
```

That is the entire failure record. It never contains the recipient address, the issued token, the
confirmation link or the key — nothing in this code path ever logs, throws or writes any of those
four values anywhere except the one outbound request itself (and, for the development sink, its own
single link file, which is the sink's own deliberate, documented exception). If you see this line
repeating, check the key and inbox id are correct and that the process can reach
`https://api.agentmail.to` outbound; AgentMail's own status page and API responses are the next
place to look, not this application.

## Deliverability is not this application's concern

Once a send returns success (an accepted `message_id`), everything after that — whether the message
actually reaches an inbox, spam filtering, AgentMail's own uptime, and how long a message stays
readable in the inbox — is AgentMail's responsibility, not KnowScroll's. This application records
only that a request was accepted or refused at the HTTP layer; it makes no delivery guarantee and
performs no read-receipt or bounce handling. The coordinator's one real end-to-end proof (issue #106)
reads the sent message back from the same inbox via AgentMail's own API rather than asserting
delivery any other way.

## Testing

Every automated test in this repository (`tests/agentmail-*.test.ts`) runs against a local fake
AgentMail HTTP server started and stopped by the test itself, using `AGENTMAIL_BASE_URL` (and, for
one class of test, an injected `fetch` that never invokes the real network) so that no test can ever
reach `api.agentmail.to`. The one real send against the real AgentMail host and inbox is a deliberate
manual/coordinator action outside the automated suite, never something a routine `pnpm test` run
performs.
