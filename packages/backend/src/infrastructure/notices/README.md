# infrastructure/notices

Disposable live hints (blueprint §4 "Socket.IO and durable conversation delivery").

| Operation | Purpose |
|---|---|
| `notifyScopeChanged(scope, { revision, eventId })` | `pg_notify('ks_scope_changed', {v, scope, revision, eventId})` inside the scope's transaction. PostgreSQL delivers it only after commit; a rollback drops it. No private content. |
| `ScopeNoticeRelay` | One dedicated LISTEN connection per API process (outside the pool). Validates each payload, hands it to the sink (`onNotice`), and on any connection loss (error, end, failed heartbeat) reconnects with backoff, re-issues LISTEN and calls `onResync('reconnected')`, because hints sent while it was away are gone. |

A hint is never the only copy of anything: clients refetch through authorised HTTP reads after
`scope_changed`, after `scope_resync`, on reconnect and on foreground. The API starts the relay
before accepting connections, so no hint is lost between a subscription and LISTEN.
