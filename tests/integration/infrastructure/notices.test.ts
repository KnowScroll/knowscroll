import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ScopeNoticeRelay,
  notifyScopeChanged,
  revokeAccountSockets,
  type ScopeNotice,
} from '@knowscroll/backend/infrastructure/notices';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import {
  advanceScopeRevision,
  makeWithPersonalScope,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import { quoteIdentifier, withAdmin } from '../support/admin.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson } from '../support/fixtures.js';

const silent: LogEvent = () => undefined;

function recordingSink() {
  const notices: ScopeNotice[] = [];
  const resyncs: string[] = [];
  const revoked: string[] = [];
  return {
    notices,
    resyncs,
    revoked,
    sink: {
      onNotice: (notice: ScopeNotice) => notices.push(notice),
      onResync: (reason: string) => resyncs.push(reason),
      onAccessRevoked: (accountId: string) => revoked.push(accountId),
    },
  };
}

describe('scope notices and the LISTEN relay (real database)', () => {
  let database: TestDatabase<Database>;
  beforeAll(async () => {
    database = await createTestDatabase<Database>('notices');
  });
  afterAll(async () => {
    // Whatever a test did to connections, the database must accept them again before it is dropped.
    await withAdmin((client) =>
      client.query(`alter database ${quoteIdentifier(database.name)} with allow_connections true`),
    );
    await database.drop();
  });

  it('delivers a hint only after its transaction commits, and never for a rollback', async () => {
    const person = await seedPerson(database.db);
    const recorder = recordingSink();
    const relay = new ScopeNoticeRelay({ database: database.settings, sink: recorder.sink, logEvent: silent });
    await relay.start();
    try {
      expect(recorder.resyncs).toEqual(['listening']);
      expect(relay.state).toBe('listening');
      const withPersonalScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
      const rolledBack = randomUUID();
      await expect(
        withPersonalScope(person.authority, async (scope) => {
          await notifyScopeChanged(scope, { revision: await advanceScopeRevision(scope), eventId: rolledBack });
          throw new Error('rolled back on purpose');
        }),
      ).rejects.toThrow('rolled back on purpose');

      const committed = randomUUID();
      let observedBeforeCommit = -1;
      await withPersonalScope(person.authority, async (scope) => {
        await notifyScopeChanged(scope, { revision: await advanceScopeRevision(scope), eventId: committed });
        await new Promise((resolve) => setTimeout(resolve, 300));
        observedBeforeCommit = recorder.notices.length;
      });
      await expect.poll(() => recorder.notices.length).toBe(1);
      expect(observedBeforeCommit).toBe(0);
      expect(recorder.notices[0]).toEqual({
        v: 1,
        scope: { kind: 'universe', id: person.universeId },
        revision: 1,
        eventId: committed,
      });
    } finally {
      await relay.stop();
    }
  });

  it('reconnects after its connection is killed, re-LISTENs, asks subscribers to resync and keeps delivering', async () => {
    const person = await seedPerson(database.db);
    const recorder = recordingSink();
    const relay = new ScopeNoticeRelay({
      database: database.settings,
      sink: recorder.sink,
      logEvent: silent,
      reconnectDelayMs: 50,
    });
    await relay.start();
    try {
      const pid = await relay.listenerPid();
      expect(pid).toBeTypeOf('number');
      await sql`select pg_terminate_backend(${pid})`.execute(database.db);
      await expect.poll(() => recorder.resyncs, { timeout: 10_000 }).toEqual(['listening', 'reconnected']);
      expect(await relay.listenerPid()).not.toBe(pid);

      const withPersonalScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
      const eventId = randomUUID();
      await withPersonalScope(person.authority, async (scope) =>
        notifyScopeChanged(scope, { revision: await advanceScopeRevision(scope), eventId }),
      );
      await expect.poll(() => recorder.notices.map((notice) => notice.eventId), { timeout: 5_000 }).toEqual([eventId]);
    } finally {
      await relay.stop();
    }
  });

  it('keeps retrying through an outage longer than its reconnect delay, then resyncs and delivers again', async () => {
    const person = await seedPerson(database.db);
    const recorder = recordingSink();
    const relay = new ScopeNoticeRelay({
      database: database.settings,
      sink: recorder.sink,
      logEvent: silent,
      reconnectDelayMs: 50,
      maxReconnectDelayMs: 200,
    });
    await relay.start();
    try {
      // The database refuses every new connection and every existing one is terminated: the
      // first reconnect attempts fail, as they would during a server restart.
      await withAdmin(async (client) => {
        await client.query(`alter database ${quoteIdentifier(database.name)} with allow_connections false`);
        await client.query(
          'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
          [database.name],
        );
      });
      await expect.poll(() => relay.state, { timeout: 5_000 }).toBe('reconnecting');
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(relay.state).toBe('reconnecting');
      expect(recorder.resyncs).toEqual(['listening']);

      await withAdmin((client) =>
        client.query(`alter database ${quoteIdentifier(database.name)} with allow_connections true`),
      );
      await expect.poll(() => recorder.resyncs, { timeout: 10_000 }).toEqual(['listening', 'reconnected']);
      expect(relay.state).toBe('listening');

      const withPersonalScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
      const eventId = randomUUID();
      await expect
        .poll(
          async () => {
            await withPersonalScope(person.authority, async (scope) =>
              notifyScopeChanged(scope, { revision: await advanceScopeRevision(scope), eventId }),
            );
            return true;
          },
          { timeout: 10_000 },
        )
        .toBe(true);
      await expect
        .poll(() => recorder.notices.some((notice) => notice.eventId === eventId), { timeout: 5_000 })
        .toBe(true);
    } finally {
      await withAdmin((client) =>
        client.query(`alter database ${quoteIdentifier(database.name)} with allow_connections true`),
      );
      await relay.stop();
    }
  });

  it('relays access revocations for an account', async () => {
    const recorder = recordingSink();
    const relay = new ScopeNoticeRelay({ database: database.settings, sink: recorder.sink, logEvent: silent });
    await relay.start();
    try {
      const accountId = randomUUID();
      await database.db.transaction().execute((trx) => revokeAccountSockets(trx, accountId));
      await expect.poll(() => recorder.revoked).toEqual([accountId]);
    } finally {
      await relay.stop();
    }
  });

  it('ignores a malformed payload on its channels', async () => {
    const recorder = recordingSink();
    const relay = new ScopeNoticeRelay({ database: database.settings, sink: recorder.sink, logEvent: silent });
    await relay.start();
    try {
      await sql`select pg_notify('ks_scope_changed', '{"v":1,"scope":{"kind":"universe","id":"not-a-uuid"}}')`.execute(
        database.db,
      );
      await sql`select pg_notify('ks_scope_changed', 'not json')`.execute(database.db);
      await sql`select pg_notify('ks_access_revoked', '{"v":1,"accountId":"not-a-uuid"}')`.execute(database.db);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect({ notices: recorder.notices, revoked: recorder.revoked }).toEqual({ notices: [], revoked: [] });
    } finally {
      await relay.stop();
    }
  });
});
