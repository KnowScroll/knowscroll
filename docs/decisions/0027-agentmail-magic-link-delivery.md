# ADR-0027 — Magic links are delivered through AgentMail

Date: 2026-09-20. Status: accepted — **owner decision** (AgentMail, inbox `knowscroll@agentmail.to`,
key in `AGENTMAIL_API_KEY`), recorded by the coordinator for #2 under #12/#72. Implements the
`MagicLinkSender` port left open by [ADR-0026](0026-magic-link-single-user-identity.md) §4.

## Context

Sign-in works but delivers nowhere: the only sender is a local file sink, and a production process
refuses to start without a real one. The owner supplied AgentMail, whose REST API both sends from an
inbox and reads that inbox back. Because the owner's sign-in address **is** that inbox, the entire
loop — send, deliver, read, sign in — can be proved by machine instead of asserted.

## Decision

### 1. One sender, one attempt, no cleverness

`POST https://api.agentmail.to/v0/inboxes/{inbox}/messages/send` with `Authorization: Bearer <key>`
and a strict body of `to`, `subject`, `text` and `html`. One attempt with a bounded timeout and a
bounded response read; no automatic retry, because a retry is the person asking for another link,
and a silent resend would mint a second live token. The response's `message_id` and `thread_id` are
recorded as delivery metadata; neither is evidence that anybody read it.

### 2. The key lives in the process environment and nowhere else

`AGENTMAIL_API_KEY` is read from the environment at send time. It is never written to this
repository, a lane, a log line, an error message, a receipt or evidence, and no worker lane is given
it. `AGENTMAIL_INBOX_ID` and `KS_OWNER_EMAIL` are ordinary ignored configuration. A missing or
malformed key is a configuration refusal at startup in production mode, not a runtime surprise
mid-sign-in.

### 3. Sending never becomes a side channel

The magic-link route already answers `202` identically for any address. A send failure — refusal,
timeout, malformed response — is recorded and logged **without** the address, the token or the link,
and changes neither the status code nor the body. The person sees the same answer whether mail flew
or failed; the operator sees the failure in the log.

### 4. Selection is explicit

`KS_MAIL_SENDER` chooses `dev-sink` (default outside production) or `agentmail`. Production mode
requires `agentmail` with its key and inbox present. There is no fallback from `agentmail` to the
sink: a deployment that cannot send mail must fail loudly rather than quietly writing links to disk.

### 5. Proof is machine-checked, and the one real send is the coordinator's

Workers build and test against a **local fake AgentMail server** that asserts method, path, bearer
presence, body shape and timeout behaviour; no test sends real mail or holds the real key. The
coordinator performs exactly one real send, reads the message back from the same inbox
(`GET /v0/inboxes/{inbox}/messages` then `GET .../messages/{id}`), extracts the link, completes a
real sign-in, and records the outcome with the token, link and address redacted.

## Alternatives and why

- *SMTP:* another credential shape and no read-back, so the loop could not be proved end to end here.
- *Retry on failure:* mints extra live tokens for one request; the person asking again is the retry.
- *Fall back to the file sink in production:* a deployment that believes it sent mail while writing to
  a local file is worse than one that refuses to start.
- *Report send failures to the caller:* turns delivery into an address-existence oracle.

## Consequences

Sign-in becomes real for the owner on this machine. The link still expires in 15 minutes, is consumed
once, and a scanner following it cannot sign anyone in (ADR-0026). Mail deliverability, inbox
retention and AgentMail's own availability are outside KnowScroll's control and are not claimed; a
failed send is visible to the operator and invisible to a caller. Release deployment, custom domains
and any second recipient remain out of scope while v1 is single-user.
