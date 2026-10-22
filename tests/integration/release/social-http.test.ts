/** Hosted Actions only: installed normal API/worker and disposable PostgreSQL. Authored people,
 * no actual contacts/client journey/provider/presence or consumption evidence claim. */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEVELOPMENT_SESSION_COOKIE_NAME,
  OwnSharingProfileSchema,
  CreateFriendInviteResultSchema,
  OwnFriendInvitesSchema,
  FriendInviteAcceptanceSchema,
  ResolvedFriendInviteSchema,
  FriendPagesPageSchema,
  SharingProfileAcceptanceSchema,
  SharingPersonLookupSchema,
  FriendPairResultSchema,
  FriendCommandAcceptanceSchema,
  SocialProblemSchema,
  ClearExplorationAcceptanceSchema,
  ClearExplorationStatusSchema,
  type PublicPersonRef,
} from '@knowscroll/contracts';
import {
  createDatabase,
  withTransaction,
  type Database,
  type DatabaseHandle,
} from '@knowscroll/backend/infrastructure/postgres';
import { createEmptyDatabase } from '../support/empty-database.js';
import { freePort, startReleaseProcess, waitForHttp, type ReleaseProcess } from '../support/processes.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { seedKeepSessions } from '../support/keep-fixture.js';
import { gate } from '../support/fixture-model.js';

const version = 'sharing.v1' as const,
  root = '/v1/social/',
  canary = 'PRIVATE-SOCIAL-HTTP-BODY-CANARY';
type Person = FixturePerson & { tokens: Awaited<ReturnType<typeof seedKeepSessions>> };
describe('explicit Friends installed HTTP lifecycle (authored disposable accounts)', () => {
  let database: Awaited<ReturnType<typeof createEmptyDatabase>>,
    db: DatabaseHandle<Database>,
    other: DatabaseHandle<Database>,
    api: ReleaseProcess,
    worker: ReleaseProcess | undefined,
    origin: string;
  const processes: ReleaseProcess[] = [],
    secrets = new Set<string>();
  const env = () => ({
    NODE_ENV: 'test',
    KS_WORLD: 'ci',
    DATABASE_URL: database.url,
    KS_SCOPE_LOCK_TIMEOUT_MS: '5000',
    KS_SHUTDOWN_GRACE_SECONDS: '10',
  });
  async function startAPI() {
    const process = startReleaseProcess('api', 'main', {
      ...env(),
      PORT: new URL(origin).port,
      KS_PUBLIC_ORIGIN: origin,
      KS_AUTH_ADAPTER: 'session',
      KS_MAIL_SENDER: 'fixture',
      AGENTMAIL_API_KEY: 'fixture-not-key',
      AGENTMAIL_INBOX_ID: 'fixture@agentmail.invalid',
      KS_BODY_LIMIT_BYTES: '4096',
    });
    processes.push(process);
    await process.waitForEvent('process.started');
    await waitForHttp(origin + '/health');
    return process;
  }
  beforeAll(async () => {
    database = await createEmptyDatabase('social_http');
    expect(await startReleaseProcess('api', 'migrate', { DATABASE_URL: database.url, KS_WORLD: 'ci' }).exited()).toBe(
      0,
    );
    const settings = { url: database.url, applicationName: 'ci-social-http', poolMax: 5, statementTimeoutMs: 15000 };
    db = createDatabase<Database>(settings, { onIdleClientError: () => undefined });
    other = createDatabase<Database>(
      { ...settings, applicationName: 'ci-social-http-barrier', poolMax: 2 },
      { onIdleClientError: () => undefined },
    );
    origin = `http://127.0.0.1:${await freePort()}`;
    api = await startAPI();
  });
  afterAll(async () => {
    try {
      if (worker) expect(await worker.stop()).toBe(0);
      if (api) expect(await api.stop()).toBe(0);
      for (const p of processes) {
        for (const secret of secrets) expect(p.rawOutput()).not.toContain(secret);
        expect(p.rawOutput()).not.toContain(canary);
        expect(p.records.filter((r) => r.event === 'http.unexpected_error')).toEqual([]);
      }
    } finally {
      await other?.close();
      await db?.close();
      await database?.drop();
    }
  });
  async function person(): Promise<Person> {
    const p = await seedPerson(db.db),
      tokens = await seedKeepSessions(db.db, p);
    secrets.add(tokens.native);
    secrets.add(tokens.web);
    return { ...p, tokens };
  }
  const headers = (p: Person, epoch = 1, web = false): Record<string, string> => ({
    'x-ks-scope': `${p.accountId}:${epoch}`,
    ...(web
      ? { cookie: `${DEVELOPMENT_SESSION_COOKIE_NAME}=${p.tokens.web}`, origin }
      : { authorization: `Bearer ${p.tokens.native}` }),
  });
  const post = (path: string, body: unknown, h: Record<string, string>) =>
    fetch(origin + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...h },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  async function ok(response: Response) {
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    return response.json() as Promise<unknown>;
  }
  async function problem(response: Response, code: string) {
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const value = SocialProblemSchema.parse(await response.json());
    expect(value.code).toBe(code);
    expect(response.status).toBe(value.status);
    expect(JSON.stringify(value)).not.toContain(canary);
    return value;
  }
  const profile = async (p: Person, epoch = 1) =>
    OwnSharingProfileSchema.parse(
      await ok(
        await fetch(origin + root + 'profile', { headers: headers(p, epoch), signal: AbortSignal.timeout(15000) }),
      ),
    );
  async function claimProfile(p: Person, handle = `ci.${p.accountId.replaceAll('-', '').slice(0, 16)}`, revision = 0) {
    const input = {
      version,
      commandId: randomUUID(),
      expectedProfileRevision: revision,
      handle,
      displayName: 'आशा · 友人',
    };
    const accepted = SharingProfileAcceptanceSchema.parse(
      await ok(await post(root + 'profile', input, headers(p, 1, true))),
    );
    expect(accepted).toMatchObject({
      commandId: input.commandId,
      operation: 'profile.set',
      baseProfileRevision: revision,
      acceptedProfileRevision: revision + 1,
    });
    const current = await profile(p);
    if (current.status !== 'claimed') throw new Error('CI_PROFILE_NOT_CLAIMED');
    expect([p.accountId, p.universeId]).not.toContain(current.person.personId);
    return current.person;
  }
  const pair = async (p: Person, peer: PublicPersonRef, epoch = 1) =>
    FriendPairResultSchema.parse(
      await ok(await post(root + 'pairs/read', { version, peerPersonId: peer.personId }, headers(p, epoch))),
    );
  async function view(p: Person, peer: PublicPersonRef, epoch = 1) {
    const r = await pair(p, peer, epoch);
    if (r.status !== 'available') throw new Error('CI_PAIR_UNAVAILABLE');
    return r.pair;
  }
  const request = (peer: PublicPersonRef, expectedPairRevision = 0) => ({
    version,
    commandId: randomUUID(),
    expectedPeerPersonId: peer.personId,
    expectedPairRevision,
    target: { kind: 'handle', handle: peer.handle },
  });
  const command = (peer: PublicPersonRef, expectedPairRevision: number, requestId?: string) => ({
    version,
    commandId: randomUUID(),
    peerPersonId: peer.personId,
    expectedPairRevision,
    ...(requestId ? { requestId } : {}),
  });
  const accepted = async (p: Person, operation: string, input: unknown, epoch = 1, web = false) =>
    FriendCommandAcceptanceSchema.parse(
      await ok(await post(root + 'friends/' + operation, input, headers(p, epoch, web))),
    );
  async function connect(a: Person, b: Person, pa: PublicPersonRef, pb: PublicPersonRef) {
    const q = request(pb);
    await accepted(a, 'request', q);
    const incoming = await view(b, pa);
    if (incoming.state !== 'incoming') throw new Error('CI_NOT_INCOMING');
    const accept = command(pa, incoming.pairRevision, incoming.requestId);
    await accepted(b, 'accept', accept);
    return { q, accept };
  }
  async function nonEvidence() {
    return (
      await sql<{ value: unknown }>`select jsonb_build_object(
      'exposures',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]'::jsonb) from experience.exposures r),
      'actions',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]'::jsonb) from experience.actions r),
      'observations',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]'::jsonb) from evidence.observations r),
      'jobs',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]'::jsonb) from pgboss.job r)
    ) as value`.execute(db.db)
    ).rows[0]!.value;
  }
  async function socialRows() {
    return (
      await sql<{ value: Record<string, unknown[]> }>`select jsonb_build_object(
      'invites',(select coalesce(jsonb_agg(to_jsonb(r) order by account_id),'[]'::jsonb) from social.invites r),
      'rosterHeads',(select coalesce(jsonb_agg(to_jsonb(r) order by owner_account_id,kind),'[]'::jsonb) from social.roster_heads r),
      'rosterEntries',(select coalesce(jsonb_agg(to_jsonb(r) order by owner_account_id,peer_account_id),'[]'::jsonb) from social.roster_entries r),
      'profiles',(select coalesce(jsonb_agg(to_jsonb(r) order by account_id),'[]'::jsonb) from social.profiles r),
      'pairs',(select coalesce(jsonb_agg(to_jsonb(r) order by pair_id),'[]'::jsonb) from social.pairs r),
      'sides',(select coalesce(jsonb_agg(to_jsonb(r) order by pair_id,account_id),'[]'::jsonb) from social.pair_sides r),
      'requests',(select coalesce(jsonb_agg(to_jsonb(r) order by request_id),'[]'::jsonb) from social.requests r),
      'bindings',(select coalesce(jsonb_agg(to_jsonb(r) order by pair_id,actor_account_id,operation,command_id),'[]'::jsonb) from social.command_bindings r)
    ) as value`.execute(db.db)
    ).rows[0]!.value;
  }
  it('private early errors and strict selectors preserve state; declared-only surfaces are not mounted', async () => {
    const p = await person(),
      before = await socialRows();
    expect(await profile(p)).toMatchObject({ status: 'unclaimed', profileRevision: 0 });
    await problem(await post(root + 'profile', {}, {}), 'UNAUTHENTICATED');
    await problem(await post(root + 'profile', {}, headers(p, 2)), 'SCOPE_MISMATCH');
    await problem(
      await post(root + 'profile', {}, { ...headers(p, 1, true), origin: 'https://foreign.invalid' }),
      'ORIGIN_NOT_ALLOWED',
    );
    await problem(
      await post(root + 'people/lookup', { version, handle: 'ci.person', [canary]: canary }, headers(p)),
      'INVALID_REQUEST',
    );
    await problem(
      await fetch(origin + root + 'profile', {
        method: 'POST',
        headers: { ...headers(p), 'content-type': 'application/json' },
        body: `{"${canary}":`,
      }),
      'INVALID_REQUEST',
    );
    await problem(
      await fetch(origin + root + 'profile', {
        method: 'POST',
        headers: { ...headers(p), 'content-type': 'text/plain' },
        body: canary,
      }),
      'UNSUPPORTED_MEDIA_TYPE',
    );
    await problem(await post(root + 'profile', { [canary]: 'x'.repeat(5000) }, headers(p)), 'PAYLOAD_TOO_LARGE');
    for (const route of [
      'friends/read',
      'requests/read',
      'visibility',
      'conversations/start',
      'content-shares/create',
      'visits/read',
    ]) {
      const response = await post(root + route, {}, headers(p));
      expect(response.status).toBe(404);
    }
    expect(await socialRows()).toEqual(before);
  });
  it('composes profile, lookup and deliberate friendship/withdrawal with real sessions and no consumption or jobs', async () => {
    const before = await nonEvidence(),
      a = await person(),
      b = await person(),
      pa = await claimProfile(a),
      pb = await claimProfile(b);
    const lookup = SharingPersonLookupSchema.parse(
      await ok(await post(root + 'people/lookup', { version, handle: pb.handle }, headers(a))),
    );
    expect(lookup).toMatchObject({ status: 'available', person: pb, pairRevision: 0 });
    const q = request(pb);
    await accepted(a, 'request', q);
    const incoming = await view(b, pa);
    if (incoming.state !== 'incoming') throw new Error('CI_NOT_INCOMING');
    // Reciprocal request is an admitted no-op, never an implicit acceptance.
    await accepted(b, 'request', request(pa, incoming.pairRevision));
    expect((await view(a, pb)).state).toBe('outgoing');
    const originalAccept = command(pa, incoming.pairRevision, incoming.requestId);
    await accepted(b, 'accept', originalAccept, 1, true);
    const friends = await view(a, pb);
    expect(friends).toMatchObject({ state: 'friends', availability: { state: 'unknown' } });
    const friendsPage = FriendPagesPageSchema.parse(
      await ok(
        await post(
          root + 'friends/page',
          { version: 'friend-pages.v2', requestId: randomUUID(), filter: 'friends', limit: 20 },
          headers(a),
        ),
      ),
    );
    expect(friendsPage.items).toEqual([friends]);
    expect(friendsPage.next).toBeUndefined();

    await accepted(a, 'remove', command(pb, friends.pairRevision));
    expect((await view(a, pb)).state).toBe('none');
    // An unchanged historical grant ACK does not restore a currently revoked lineage.
    await problem(await post(root + 'friends/accept', originalAccept, headers(b)), 'SHARING_UNAVAILABLE');
    expect((await view(b, pa)).state).toBe('none');
    const removed = await view(a, pb);
    await accepted(a, 'block', command(pb, removed.pairRevision));
    const blocked = await view(a, pb);
    expect(blocked.state).toBe('blocked');
    const blockedPage = FriendPagesPageSchema.parse(
      await ok(
        await post(
          root + 'friends/page',
          { version: 'friend-pages.v2', requestId: randomUUID(), filter: 'blocked', limit: 20 },
          headers(a),
        ),
      ),
    );
    expect(blockedPage.items).toEqual([blocked]);

    await accepted(a, 'unblock', command(pb, blocked.pairRevision));
    expect((await view(a, pb)).state).toBe('none');
    // The old fixed seven-day window remains a cooldown after removal/unblock. Exercise cancel
    // on an independent new pair; do not advance time or bypass that existing privacy policy.
    const c = await person(),
      pc = await claimProfile(c),
      cancel = request(pc);
    await accepted(a, 'request', cancel);
    const outgoing = await view(a, pc);
    if (outgoing.state !== 'outgoing') throw new Error('CI_NOT_OUTGOING');
    await accepted(a, 'cancel', command(pc, outgoing.pairRevision, outgoing.requestId));
    expect((await view(a, pc)).state).toBe('none');
    expect(await nonEvidence()).toEqual(before);
  });
  it('a private decline/block preserves the complete pending sender projection, revision and expiry', async () => {
    const a = await person(),
      b = await person(),
      pa = await claimProfile(a),
      pb = await claimProfile(b);
    const q = request(pb);
    await accepted(a, 'request', q);
    const before = await pair(a, pb),
      incoming = await view(b, pa);
    if (incoming.state !== 'incoming') throw new Error('CI_NOT_INCOMING');
    const expires = await db.db
      .selectFrom('social.requests')
      .select('expires_at')
      .where('request_id', '=', incoming.requestId)
      .executeTakeFirstOrThrow();
    await accepted(b, 'decline', command(pa, incoming.pairRevision, incoming.requestId));
    expect(await pair(a, pb)).toEqual(before);
    const own = await view(b, pa);
    await accepted(b, 'block', command(pa, own.pairRevision));
    expect(await pair(a, pb)).toEqual(before);
    expect(
      await db.db
        .selectFrom('social.requests')
        .select('expires_at')
        .where('request_id', '=', incoming.requestId)
        .executeTakeFirstOrThrow(),
    ).toEqual(expires);
    const hidden = SharingPersonLookupSchema.parse(
      await ok(await post(root + 'people/lookup', { version, handle: pb.handle }, headers(a))),
    );
    const absent = SharingPersonLookupSchema.parse(
      await ok(await post(root + 'people/lookup', { version, handle: 'ci.absent.person' }, headers(a))),
    );
    expect(hidden).toEqual(absent);
    expect(hidden.status).toBe('unavailable');
  });
  it('identical device retries and a deliberately discarded ACK survive restart without a second effect or new target', async () => {
    const a = await person(),
      b = await person();
    await claimProfile(a);
    const pb = await claimProfile(b),
      q = request(pb);
    const results = await Promise.all([accepted(a, 'request', q), accepted(a, 'request', q, 1, true)]);
    expect(results.filter((x) => x.replayed)).toHaveLength(1);
    expect(results[0]).toEqual({ ...results[1], replayed: results[0].replayed });
    const original = results.find((x) => !x.replayed)!,
      after = await socialRows();
    expect(await api.stop()).toBe(0);
    api = await startAPI();
    // Discarding that first ACK models loss after commit; no timing-based abort claims are made.
    expect(await accepted(a, 'request', q)).toEqual({ ...original, replayed: true });
    expect(await socialRows()).toEqual(after);
    await problem(
      await post(root + 'friends/request', { ...q, expectedPairRevision: 1 }, headers(a)),
      'COMMAND_KEY_REUSED',
    );
    expect(await socialRows()).toEqual(after);
  });
  it('handle reassignment cannot redirect a displayed original public person selection to replacement B', async () => {
    const a = await person(),
      b = await person(),
      replacement = await person();
    await claimProfile(a);
    const pb = await claimProfile(b),
      originalHandle = pb.handle;
    await claimProfile(b, `next.${b.accountId.replaceAll('-', '').slice(0, 16)}`, 1);
    const pc = await claimProfile(replacement, originalHandle);
    expect(pc.personId).not.toBe(pb.personId);
    const before = await socialRows();
    await problem(await post(root + 'friends/request', request(pb), headers(a)), 'SHARING_UNAVAILABLE');
    expect(await socialRows()).toEqual(before);
    expect((await view(a, pc)).state).toBe('none');
  });
  it.each(['epoch', 'inactive-peer'] as const)(
    'root-wait rechecks %s before an old acceptance can replay',
    async (mode) => {
      const a = await person(),
        b = await person(),
        pa = await claimProfile(a),
        pb = await claimProfile(b),
        connected = await connect(a, b, pa, pb);
      const before = await socialRows(),
        entered = gate(),
        release = gate();
      let pid = 0;
      const held = withTransaction(other.db, 'ci-social-root-barrier', async (tx) => {
        pid = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(tx)).rows[0]!.pid;
        await tx.selectFrom('identity.universes').select('id').where('id', '=', b.universeId).forUpdate().execute();
        entered.open();
        await release.promise;
        if (mode === 'epoch')
          await tx.updateTable('identity.universes').set({ privacy_epoch: 2 }).where('id', '=', b.universeId).execute();
        else
          await tx
            .updateTable('identity.accounts')
            .set({ status: 'suspended' })
            .where('id', '=', a.accountId)
            .execute();
      });
      await entered.promise;
      const pending = post(root + 'friends/accept', connected.accept, headers(b));
      try {
        await expect
          .poll(
            async () =>
              (
                await sql<{
                  blocked: boolean;
                }>`select exists(select 1 from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))) as blocked`.execute(
                  db.db,
                )
              ).rows[0]!.blocked,
            { timeout: 3000 },
          )
          .toBe(true);
      } finally {
        release.open();
        await Promise.all([held, pending]);
      }
      await problem(await pending, 'SHARING_UNAVAILABLE');
      expect(await socialRows()).toEqual(before);
    },
  );
  it('mounts private versioned pages and revocable links; restart recovers receipts without re-delivering a secret', async () => {
    const before = await nonEvidence(),
      a = await person(),
      b = await person(),
      c = await person(),
      pa = await claimProfile(a),
      pc = await claimProfile(c);
    await claimProfile(b);
    const q = { version, commandId: randomUUID(), expectedInviteRevision: 0 };
    const first = CreateFriendInviteResultSchema.parse(
      await ok(await post(root + 'invites/create', q, headers(a, 1, true))),
    );
    if (first.delivery.status !== 'available') throw new Error('CI_INVITE_DELIVERY');
    const token = first.delivery.token;
    secrets.add(token);
    const own = OwnFriendInvitesSchema.parse(
      await ok(await fetch(origin + root + 'invites', { headers: headers(a), signal: AbortSignal.timeout(15000) })),
    );
    expect(own.invite).toMatchObject({ status: 'active', linkId: first.acceptance.linkId, inviteRevision: 1 });
    expect(
      ResolvedFriendInviteSchema.parse(await ok(await post(root + 'invites/resolve', { version, token }, headers(b)))),
    ).toMatchObject({ status: 'available', issuer: pa, pairRevision: 0 });
    await problem(
      await post(root + 'invites/resolve', { version, token, [canary]: canary }, headers(b)),
      'INVALID_REQUEST',
    );
    const requestA = { ...request(pa), target: { kind: 'invite', token } };
    await accepted(b, 'request', requestA);
    await accepted(b, 'request', request(pc));
    const read = { version: 'friend-pages.v2', requestId: randomUUID(), filter: 'outgoing', limit: 1 };
    const page = FriendPagesPageSchema.parse(await ok(await post(root + 'requests/page', read, headers(b))));
    expect(page.requestId).toBe(read.requestId);
    expect(page.items).toHaveLength(1);
    expect(page.next).toBeDefined();
    await problem(await post(root + 'friends/page', {}, {}), 'UNAUTHENTICATED');
    await problem(
      await post(root + 'requests/page', { ...read, limit: 2, cursor: page.next }, headers(b)),
      'SHARING_UNAVAILABLE',
    );
    const beforeRestart = await socialRows();
    expect(await api.stop()).toBe(0);
    api = await startAPI();
    const replay = CreateFriendInviteResultSchema.parse(await ok(await post(root + 'invites/create', q, headers(a))));
    expect(replay).toEqual({
      acceptance: { ...first.acceptance, replayed: true },
      delivery: { status: 'unavailable' },
    });
    expect(await socialRows()).toEqual(beforeRestart);
    await problem(
      await post(root + 'requests/page', { ...read, requestId: randomUUID(), cursor: page.next }, headers(b)),
      'SHARING_UNAVAILABLE',
    );
    const refresh = FriendPagesPageSchema.parse(
      await ok(await post(root + 'requests/page', { ...read, requestId: randomUUID(), limit: 50 }, headers(b))),
    );
    expect(refresh.items).toHaveLength(2);
    expect(refresh.next).toBeUndefined();
    const revoke = { version, commandId: randomUUID(), linkId: first.acceptance.linkId, expectedInviteRevision: 1 };
    expect(
      FriendInviteAcceptanceSchema.parse(await ok(await post(root + 'invites/revoke', revoke, headers(a)))),
    ).toMatchObject({ operation: 'invite.revoke', acceptedInviteRevision: 2 });
    await problem(await post(root + 'friends/request', requestA, headers(b)), 'SHARING_UNAVAILABLE');
    expect(
      ResolvedFriendInviteSchema.parse(await ok(await post(root + 'invites/resolve', { version, token }, headers(b)))),
    ).toMatchObject({ status: 'unavailable' });
    const replacement = CreateFriendInviteResultSchema.parse(
      await ok(
        await post(root + 'invites/create', { ...q, commandId: randomUUID(), expectedInviteRevision: 2 }, headers(a)),
      ),
    );
    if (replacement.delivery.status !== 'available') throw new Error('CI_INVITE_DELIVERY');
    secrets.add(replacement.delivery.token);
    await problem(await post(root + 'invites/create', q, headers(a)), 'SHARING_UNAVAILABLE');
    expect(await nonEvidence()).toEqual(before);
  });
  it('normal selective Clear preserves populated Social while old-epoch grant commands cannot replay', async () => {
    const a = await person(),
      b = await person(),
      pa = await claimProfile(a),
      pb = await claimProfile(b),
      connected = await connect(a, b, pa, pb);
    const invite = CreateFriendInviteResultSchema.parse(
      await ok(
        await post(
          root + 'invites/create',
          { version, commandId: randomUUID(), expectedInviteRevision: 0 },
          headers(b),
        ),
      ),
    );
    if (invite.delivery.status === 'available') secrets.add(invite.delivery.token);
    const before = await socialRows();
    for (const rows of Object.values(before)) expect(rows.length).toBeGreaterThan(0);
    const clear = {
      version: 'clear-exploration.v1',
      commandId: randomUUID(),
      expectedPrivacyEpoch: 1,
      confirmation: 'clear-exploration-preserve-keep-and-social',
    };
    const response = await post('/v1/privacy/clear-exploration', clear, headers(b));
    expect(response.status).toBe(202);
    expect(ClearExplorationAcceptanceSchema.parse(await response.json())).toMatchObject({ fromEpoch: 1, toEpoch: 2 });
    worker = startReleaseProcess('worker', 'main', { ...env(), KS_REASONING_PROVIDER: 'none' });
    processes.push(worker);
    await worker.waitForEvent('process.started');
    await expect
      .poll(
        async () => {
          const status = await post(
            '/v1/privacy/clear-exploration/status',
            { version: 'clear-exploration.v1', target: { kind: 'command', commandId: clear.commandId } },
            headers(b, 2),
          );
          expect(status.status).toBe(200);
          return ClearExplorationStatusSchema.parse(await status.json()).status;
        },
        { timeout: 20000 },
      )
      .toBe('completed_live');
    expect(await socialRows()).toEqual(before);
    expect((await view(b, pa, 2)).state).toBe('friends');
    await problem(await post(root + 'friends/accept', connected.accept, headers(b, 1)), 'SCOPE_MISMATCH');
    await problem(await post(root + 'friends/accept', connected.accept, headers(b, 2)), 'SHARING_UNAVAILABLE');
    expect(await socialRows()).toEqual(before);
    for (const table of ['experience.exposures', 'experience.actions', 'evidence.observations'] as const)
      expect(await db.db.selectFrom(table).select('id').where('universe_id', '=', b.universeId).execute()).toEqual([]);
  });
});
