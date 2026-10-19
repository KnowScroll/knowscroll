# infrastructure/notices

Disposable live hints (blueprint §4 "Socket.IO and durable conversation delivery").

| Operation | Purpose |
|---|---|
| `notifyScopeChanged(scope, { revision, eventId })` | `pg_notify('ks_scope_changed', {v, scope, revision, eventId})` inside the scope's transaction. PostgreSQL delivers it only after commit; a rollback drops it. No private content. |
| `revokeAccountSockets(db, accountId)` | `pg_notify('ks_access_revoked', {v, accountId})`: every API process's gateway disconnects that account's sockets. S1.3 identity calls it in the transaction that signs out, revokes a session or advances the privacy epoch. |
| `ScopeNoticeRelay` | One dedicated LISTEN connection per API process (outside the pool) on both channels. Validates each payload and hands it to the sink. On any loss (error, end, a heartbeat that fails or does not answer within `heartbeatTimeoutMs`) it keeps retrying with capped exponential backoff for as long as the outage lasts, re-issues LISTEN and calls `onResync('reconnected')`, because hints sent while it was away are gone. `state` (`listening`/`reconnecting`) is reported by `/health`. A sink that throws is logged (`relay.sink_failed`) and never disturbs the connection. |

A hint is never the only copy of anything: clients refetch through authorised HTTP reads after
`scope_changed`, after `scope_resync`, on reconnect and on foreground. The API starts the relay
before accepting connections, so no hint is lost between a subscription and LISTEN. CI proves the
relay through a connection kill and through an outage in which the database refuses all
connections for longer than the reconnect delay.
