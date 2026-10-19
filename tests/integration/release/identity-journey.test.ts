import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SOCKET_PATH, socketEvents } from '@knowscroll/contracts';
import { createDatabase, type Database, type DatabaseHandle } from '@knowscroll/backend/infrastructure/postgres';
import { createEmptyDatabase } from '../support/empty-database.js';
import { seedAsset } from '../support/fixtures.js';
import {
  freePort,
  releaseDirectory,
  startReleaseProcess,
  waitForHttp,
  type ReleaseProcess,
} from '../support/processes.js';

/**
 * Sign-in through the deployed release trees (S1.3 #226, D-022): email links (fixture mail
 * sender, and AgentMail against a local fake), web cookies with origin checks, native bearer
 * tokens, sockets, sign-out, the operator command and the production refusals.
 *
 * Evidence label: CI fixture + real database. Every address is a fixture under `.test`; the
 * AgentMail key is a canary for a fake server on loopback; no mail leaves the runner.
 */
const agentMailCanaryKey = 'canary-agentmail-key-Rt55';
const fixtureAgentMail = { AGENTMAIL_API_KEY: 'fixture-not-a-key', AGENTMAIL_INBOX_ID: 'fixture@agentmail.invalid' };
let addressCounter = 0;
/** A fixture address, each on its own subdomain so no test runs into another's domain budget. */
const freshAddress = (domain?: string) => {
  addressCounter += 1;
  return `release-${Date.now()}-${addressCounter}@${domain ?? `d${addressCounter}.identity.test`}`;
};
/** Any fixture address this journey used (each is under identity.test or operator.test). */
const fixtureAddress = /@[a-z0-9.-]*(identity|operator)\.test/;
/** A native app's sign-in binding (review m10): its verifier and the S256 challenge. */
function nativeDevice(): { readonly verifier: string; readonly challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier, 'ascii').digest('base64url') };
}
/** The scope claim of an account (review M1): `X-KS-Scope: <accountId>:<epoch>`. */
const scopeOf = (account: { readonly accountId: string; readonly privacyEpoch: number }) =>
  `${account.accountId}:${account.privacyEpoch}`;
/** A distinct client address per call (the API trusts X-Forwarded-For only from its loopback peer). */
let clientCounter = 0;
const freshClient = () => `198.51.100.${(clientCounter += 1) % 250}`;

interface Problem {
  readonly status: number;
  readonly code: string;
}

describe('sign-in through the built API', () => {
  let database: Awaited<ReturnType<typeof createEmptyDatabase>>;
  let handle: DatabaseHandle<Database>;
  let api: ReleaseProcess;
  let baseUrl: string;
  let outboxDirectory: string;
  let outboxFile: string;
  let asset: { readonly assetId: string; readonly revision: number };
  const sockets: Socket[] = [];
  /** Every secret the journey saw: none may reach any output. */
  const secrets = new Set<string>();
  const extraOutputs: string[] = [];

  beforeAll(async () => {
    database = await createEmptyDatabase('release_identity');
    const migrate = startReleaseProcess('api', 'migrate', { DATABASE_URL: database.url, KS_WORLD: 'ci' });
    expect(await migrate.exited()).toBe(0);
    handle = createDatabase<Database>(
      { url: database.url, applicationName: 'knowscroll-it-fixtures', poolMax: 2, statementTimeoutMs: 10_000 },
      { onIdleClientError: () => undefined },
    );
    asset = await seedAsset(handle.db);
    outboxDirectory = mkdtempSync(join(tmpdir(), 'ks-identity-outbox-'));
    outboxFile = join(outboxDirectory, 'outbox.jsonl');
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    api = startReleaseProcess('api', 'main', {
      NODE_ENV: 'test',
      KS_WORLD: 'ci',
      DATABASE_URL: database.url,
      PORT: String(port),
      KS_PUBLIC_ORIGIN: baseUrl,
      KS_MAIL_SENDER: 'fixture',
      KS_FIXTURE_MAIL_FILE: outboxFile,
      KS_ALLOW_OPERATOR_SIGN_IN: '1',
      KS_OPERATOR_SIGN_IN_PATTERN: '*@operator.test',
      KS_SOCKET_AUTH_CACHE_MS: '0',
      KS_SHUTDOWN_GRACE_SECONDS: '10',
    });
    await api.waitForEvent('process.started');
    await waitForHttp(`${baseUrl}/health`);
  });

  afterAll(async () => {
    for (const socket of sockets) socket.close();
    await handle.close();
    await database.drop();
    rmSync(outboxDirectory, { recursive: true, force: true });
  });

  async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': freshClient(), ...headers },
      body: JSON.stringify(body),
    });
  }

  async function expectProblem(response: Response, status: number, code: string): Promise<void> {
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    const problem = (await response.json()) as Problem;
    expect({ status: response.status, code: problem.code }).toEqual({ status, code });
  }

  /** The link the fixture sender recorded last for `address`. */
  function lastLinkFor(address: string): string {
    const lines = readFileSync(outboxFile, 'utf8').trim().split('\n');
    const mails = lines.map((line) => JSON.parse(line) as { fixture: boolean; to: string; link: string });
    const mail = mails.filter((entry) => entry.to === address).at(-1);
    if (mail === undefined) throw new Error('no mail for the address');
    secrets.add(mail.link);
    return mail.link;
  }

  function tokenOf(link: string): string {
    const url = new URL(link);
    expect({ origin: url.origin, path: url.pathname, query: url.search }).toEqual({
      origin: baseUrl,
      path: '/redeem',
      query: '',
    });
    const token = url.hash.replace(/^#token=/, '');
    expect(token).toMatch(/^ksl_[A-Za-z0-9_-]{43}$/);
    secrets.add(token);
    return token;
  }

  async function requestLink(address: string, codeChallenge?: string): Promise<string> {
    const response = await post('/auth/sign-in', {
      email: address,
      ...(codeChallenge === undefined ? {} : { codeChallenge }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: 'requested' });
    await expect.poll(() => readOutbox().includes(address), { timeout: 10_000 }).toBe(true);
    return tokenOf(lastLinkFor(address));
  }

  function readOutbox(): string {
    try {
      return readFileSync(outboxFile, 'utf8');
    } catch {
      return '';
    }
  }

  interface SignedIn {
    readonly universeId: string;
    readonly accountId: string;
    readonly privacyEpoch: number;
  }

  /** Signs in on the web; returns the `Cookie` header value. */
  async function webSignIn(address = freshAddress()): Promise<SignedIn & { cookie: string }> {
    const response = await post(
      '/auth/redeem',
      { token: await requestLink(address), commandId: randomUUID(), client: 'web' },
      { origin: baseUrl },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { account: SignedIn };
    const setCookie = response.headers.getSetCookie();
    const value = /^ks_session=(kss_[A-Za-z0-9_-]{43});/.exec(setCookie[0] ?? '')?.[1];
    if (value === undefined) throw new Error('no session cookie');
    secrets.add(value);
    return { cookie: `ks_session=${value}`, ...body.account };
  }

  /** Signs in as a native app: the link is bound to this "device" (review m10). */
  async function nativeSignIn(address = freshAddress()): Promise<SignedIn & { token: string }> {
    const device = nativeDevice();
    const response = await post('/auth/redeem', {
      token: await requestLink(address, device.challenge),
      commandId: randomUUID(),
      client: 'native',
      codeVerifier: device.verifier,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { session: { token: string }; account: SignedIn };
    secrets.add(body.session.token);
    return { token: body.session.token, ...body.account };
  }

  function connect(options: { cookie?: string; origin?: string; token?: string; scope?: string }): Socket {
    const socket = io(baseUrl, {
      path: SOCKET_PATH,
      transports: ['websocket'],
      reconnection: false,
      auth: {
        ...(options.token === undefined ? {} : { token: options.token }),
        ...(options.scope === undefined ? {} : { scope: options.scope }),
      },
      extraHeaders: {
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
        ...(options.origin === undefined ? {} : { origin: options.origin }),
      },
    });
    sockets.push(socket);
    return socket;
  }

  async function connected(socket: Socket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
  }

  it('answers every well-formed address the same, mails one link, and creates no account before redemption', async () => {
    const address = freshAddress();
    const response = await post('/auth/sign-in', { email: address });
    expect(response.status).toBe(202);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'requested' });
    await expect.poll(() => readOutbox().includes(address), { timeout: 10_000 }).toBe(true);
    tokenOf(lastLinkFor(address));
    const accounts = await handle.db
      .selectFrom('identity.email_addresses')
      .select('account_id')
      .where('address', '=', address)
      .execute();
    expect(accounts).toEqual([]);
    // Outside the accepted grammar (review m4): 422, never a database error; not a string: 400.
    for (const email of ['not an address', 'nul\u0000@identity.test', 'x<attacker@evil.test>', 'a,b@evil.test'])
      await expectProblem(await post('/auth/sign-in', { email }), 422, 'UNPROCESSABLE_REQUEST');
    await expectProblem(await post('/auth/sign-in', { email: '' }), 400, 'INVALID_REQUEST');
    expect(api.records.some((record) => record.event === 'http.unexpected_error')).toBe(false);
  });

  it('sends security headers with every API answer (review m7)', async () => {
    for (const response of [
      await fetch(`${baseUrl}/health`),
      await fetch(`${baseUrl}/auth/session`),
      await post('/auth/sign-in', { email: 'not an address' }),
    ]) {
      expect(response.headers.get('content-security-policy')).toBe(
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      );
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    }
  });

  it('peeks at a link without consuming it, showing only the masked address (review m8)', async () => {
    const address = freshAddress();
    const token = await requestLink(address);
    const peek = await post('/auth/peek', { token, client: 'web' });
    expect(peek.status).toBe(200);
    expect(peek.headers.get('cache-control')).toBe('no-store');
    expect(await peek.json()).toEqual({ maskedEmail: `r•••@${address.split('@')[1] ?? ''}` });
    const link = await handle.db
      .selectFrom('identity.sign_in_links')
      .select('consumed_at')
      .where('address', '=', address)
      .executeTakeFirst();
    expect(link).toEqual({ consumed_at: null });
    // A web link is not a native app's, and an unknown token is like a used one.
    await expectProblem(await post('/auth/peek', { token, client: 'native' }), 400, 'SIGN_IN_LINK_INVALID');
    await expectProblem(
      await post('/auth/peek', { token: `ksl_${'Z'.repeat(43)}`, client: 'web' }),
      400,
      'SIGN_IN_LINK_INVALID',
    );
  });

  it('signs in on the web with an HttpOnly, SameSite=Lax cookie and no token in the body', async () => {
    const address = freshAddress();
    const token = await requestLink(address);
    const response = await post('/auth/redeem', { token, commandId: randomUUID(), client: 'web' }, { origin: baseUrl });
    expect(response.status).toBe(200);
    const [cookie] = response.headers.getSetCookie();
    expect(cookie).toMatch(/^ks_session=kss_[A-Za-z0-9_-]{43}; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax$/);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      account: { email: address, privacyEpoch: 1 },
      accountCreated: true,
      replayed: false,
      session: { kind: 'cookie' },
    });
    expect(JSON.stringify(body)).not.toMatch(/kss_/);
    const value = cookie?.split(';')[0] ?? '';
    secrets.add(value.replace('ks_session=', ''));
    const session = await fetch(`${baseUrl}/auth/session`, { headers: { cookie: value } });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({
      account: (body as { account: unknown }).account,
      client: 'web',
    });
    const account = (body as { account: SignedIn }).account;
    const saved = await fetch(`${baseUrl}/v1/saved`, { headers: { cookie: value, 'x-ks-scope': scopeOf(account) } });
    expect(saved.status).toBe(200);
  });

  it('serves a scope only its own requests: another account or an older epoch is refused, never served (review M1, m11)', async () => {
    const web = await webSignIn();
    const other = await webSignIn();
    const read = (scope?: string) =>
      fetch(`${baseUrl}/v1/saved`, {
        headers: { cookie: web.cookie, ...(scope === undefined ? {} : { 'x-ks-scope': scope }) },
      });
    expect((await read(scopeOf(web))).status).toBe(200);
    // No claim, another account's (a tab whose cookie another tab replaced), a malformed one.
    for (const claim of [undefined, scopeOf(other), `${web.accountId}`, `${scopeOf(web)}, ${scopeOf(web)}`])
      await expectProblem(await read(claim), 409, 'SCOPE_MISMATCH');
    // A privacy reset whose revocation notice the client never got: its old-epoch scope is refused.
    await handle.db
      .updateTable('identity.universes')
      .set({ privacy_epoch: 2 })
      .where('id', '=', web.universeId)
      .execute();
    await expectProblem(await read(scopeOf(web)), 409, 'SCOPE_MISMATCH');
    const action = await post(
      '/v1/actions',
      { commandId: randomUUID(), kind: 'save', target: { assetId: asset.assetId, assetRevision: asset.revision } },
      { cookie: web.cookie, origin: baseUrl, 'x-ks-scope': scopeOf(web) },
    );
    await expectProblem(action, 409, 'SCOPE_MISMATCH');
    expect(
      await handle.db
        .selectFrom('experience.saved_items')
        .select('asset_id')
        .where('universe_id', '=', web.universeId)
        .execute(),
    ).toEqual([]);
    expect((await read(scopeOf({ ...web, privacyEpoch: 2 }))).status).toBe(200);
    // The socket handshake carries the same claim.
    await expect(connected(connect({ cookie: web.cookie, origin: baseUrl, scope: scopeOf(web) }))).rejects.toThrow(
      'SCOPE_MISMATCH',
    );
    await expect(connected(connect({ cookie: web.cookie, origin: baseUrl }))).rejects.toThrow('SCOPE_MISMATCH');
    await connected(connect({ cookie: web.cookie, origin: baseUrl, scope: scopeOf({ ...web, privacyEpoch: 2 }) }));
  });

  it('refuses cookie-authenticated changes that do not come from this origin, and web redemption from elsewhere', async () => {
    const { cookie } = await webSignIn();
    const action = () => ({
      commandId: randomUUID(),
      kind: 'save',
      target: { assetId: asset.assetId, assetRevision: asset.revision },
    });
    const signedIn = await fetch(`${baseUrl}/auth/session`, { headers: { cookie } });
    const scope = scopeOf(((await signedIn.json()) as { account: SignedIn }).account);
    await expectProblem(await post('/v1/actions', action(), { cookie }), 403, 'ORIGIN_NOT_ALLOWED');
    await expectProblem(
      await post('/v1/actions', action(), { cookie, origin: 'https://attacker.invalid' }),
      403,
      'ORIGIN_NOT_ALLOWED',
    );
    await expectProblem(await post('/auth/sign-out', {}, { cookie }), 403, 'ORIGIN_NOT_ALLOWED');
    const allowed = await post('/v1/actions', action(), { cookie, origin: baseUrl, 'x-ks-scope': scope });
    expect(allowed.status).toBe(200);

    // A web redemption must come from this origin; a refused one leaves the link usable.
    const token = await requestLink(freshAddress());
    await expectProblem(
      await post('/auth/redeem', { token, commandId: randomUUID(), client: 'web' }),
      403,
      'ORIGIN_NOT_ALLOWED',
    );
    await expectProblem(
      await post(
        '/auth/redeem',
        { token, commandId: randomUUID(), client: 'web' },
        { origin: 'https://attacker.invalid' },
      ),
      403,
      'ORIGIN_NOT_ALLOWED',
    );
    expect(
      (await post('/auth/redeem', { token, commandId: randomUUID(), client: 'web' }, { origin: baseUrl })).status,
    ).toBe(200);
  });

  it('gives a native client its bearer token once, and accepts each kind of token only as itself', async () => {
    const native = await nativeSignIn();
    expect(native.token).toMatch(/^kss_[A-Za-z0-9_-]{43}$/);
    expect(
      (
        await fetch(`${baseUrl}/v1/saved`, {
          headers: { authorization: `Bearer ${native.token}`, 'x-ks-scope': scopeOf(native) },
        })
      ).status,
    ).toBe(200);
    // A bearer request needs no Origin: no browser attaches it on its own.
    const saved = await post(
      '/v1/actions',
      { commandId: randomUUID(), kind: 'save', target: { assetId: asset.assetId, assetRevision: asset.revision } },
      { authorization: `Bearer ${native.token}`, 'x-ks-scope': scopeOf(native) },
    );
    expect(saved.status).toBe(200);
    // A native link redeemed without its verifier, or by the web, signs nobody in (review m10).
    const device = nativeDevice();
    const bound = await requestLink(freshAddress(), device.challenge);
    await expectProblem(
      await post('/auth/redeem', { token: bound, commandId: randomUUID(), client: 'native' }),
      400,
      'SIGN_IN_LINK_INVALID',
    );
    await expectProblem(
      await post('/auth/redeem', {
        token: bound,
        commandId: randomUUID(),
        client: 'native',
        codeVerifier: nativeDevice().verifier,
      }),
      400,
      'SIGN_IN_LINK_INVALID',
    );
    await expectProblem(
      await post('/auth/redeem', { token: bound, commandId: randomUUID(), client: 'web' }, { origin: baseUrl }),
      400,
      'SIGN_IN_LINK_INVALID',
    );
    const redeemed = await post('/auth/redeem', {
      token: bound,
      commandId: randomUUID(),
      client: 'native',
      codeVerifier: device.verifier,
    });
    expect(redeemed.status).toBe(200);
    secrets.add(((await redeemed.json()) as { session: { token: string } }).session.token);
    // A native token presented as the cookie, and a web cookie presented as a bearer token: refused.
    await expectProblem(
      await fetch(`${baseUrl}/v1/saved`, { headers: { cookie: `ks_session=${native.token}` } }),
      401,
      'UNAUTHENTICATED',
    );
    const web = await webSignIn();
    await expectProblem(
      await fetch(`${baseUrl}/v1/saved`, {
        headers: { authorization: `Bearer ${web.cookie.replace('ks_session=', '')}` },
      }),
      401,
      'UNAUTHENTICATED',
    );
  });

  it('never signs anyone in from a GET: the link can only be redeemed by POST', async () => {
    const address = freshAddress();
    const token = await requestLink(address);
    // What a mail scanner or link prefetcher does with the link and with the API route.
    for (const url of [`${baseUrl}/redeem#token=${token}`, `${baseUrl}/auth/redeem?token=${token}`]) {
      const response = await fetch(url, { redirect: 'manual' });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.headers.getSetCookie()).toEqual([]);
    }
    const link = await handle.db
      .selectFrom('identity.sign_in_links')
      .select('consumed_at')
      .where('address', '=', address)
      .executeTakeFirst();
    expect(link).toEqual({ consumed_at: null });
    expect(
      (await post('/auth/redeem', { token, commandId: randomUUID(), client: 'web' }, { origin: baseUrl })).status,
    ).toBe(200);
  });

  it('replays a retried redemption with a replacement session and refuses the link to any other command', async () => {
    const device = nativeDevice();
    const token = await requestLink(freshAddress(), device.challenge);
    const commandId = randomUUID();
    const redeem = { token, commandId, client: 'native', codeVerifier: device.verifier };
    const first = (await (await post('/auth/redeem', redeem)).json()) as {
      account: unknown;
      session: { token: string };
    };
    const retry = await post('/auth/redeem', redeem);
    expect(retry.status).toBe(200);
    const replay = (await retry.json()) as { account: unknown; replayed: boolean; session: { token: string } };
    secrets.add(first.session.token);
    secrets.add(replay.session.token);
    expect(replay).toMatchObject({ account: first.account, replayed: true });
    expect(replay.session.token).not.toBe(first.session.token);
    // The replaced session ended (review m5: a replay never adds a live session).
    await expectProblem(
      await fetch(`${baseUrl}/auth/session`, { headers: { authorization: `Bearer ${first.session.token}` } }),
      401,
      'UNAUTHENTICATED',
    );
    await expectProblem(
      await post('/auth/redeem', { ...redeem, commandId: randomUUID() }),
      400,
      'SIGN_IN_LINK_INVALID',
    );
    // Once its session is signed out, the same retry signs nobody in.
    const out = await post('/auth/sign-out', {}, { authorization: `Bearer ${replay.session.token}` });
    expect(out.status).toBe(200);
    await expectProblem(await post('/auth/redeem', redeem), 400, 'SIGN_IN_LINK_INVALID');
  });

  it('authenticates sockets by cookie from this origin or by bearer token, and drops them at sign-out', async () => {
    const web = await webSignIn();
    const fromElsewhere = connect({ cookie: web.cookie, origin: 'https://attacker.invalid', scope: scopeOf(web) });
    await expect(connected(fromElsewhere)).rejects.toThrow('ORIGIN_NOT_ALLOWED');
    const socket = connect({ cookie: web.cookie, origin: baseUrl, scope: scopeOf(web) });
    await connected(socket);
    expect(
      await socket.emitWithAck(socketEvents.subscribeScope, { scope: { kind: 'universe', id: web.universeId } }),
    ).toEqual({ ok: true, revision: 0 });

    const native = await nativeSignIn();
    const nativeSocket = connect({ token: native.token, scope: scopeOf(native) });
    await connected(nativeSocket);

    const disconnected = new Promise<string>((resolve) => socket.once('disconnect', resolve));
    const signOut = await post('/auth/sign-out', {}, { cookie: web.cookie, origin: baseUrl });
    expect(signOut.status).toBe(200);
    expect(await signOut.json()).toEqual({ status: 'signed_out', revoked: 1 });
    expect(signOut.headers.getSetCookie()).toEqual(['ks_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax']);
    expect(await disconnected).toBe('io server disconnect');
    expect(nativeSocket.connected).toBe(true);

    // The revoked session is refused everywhere from now on: HTTP, a new socket, a resubscribe.
    await expectProblem(
      await fetch(`${baseUrl}/auth/session`, { headers: { cookie: web.cookie } }),
      401,
      'UNAUTHENTICATED',
    );
    await expectProblem(
      await fetch(`${baseUrl}/v1/saved`, { headers: { cookie: web.cookie, 'x-ks-scope': scopeOf(web) } }),
      401,
      'UNAUTHENTICATED',
    );
    await expect(connected(connect({ cookie: web.cookie, origin: baseUrl, scope: scopeOf(web) }))).rejects.toThrow(
      'UNAUTHENTICATED',
    );
  });

  it('replaces the session a device still presents when it redeems another link (account switch)', async () => {
    const first = await webSignIn();
    const second = await post(
      '/auth/redeem',
      { token: await requestLink(freshAddress()), commandId: randomUUID(), client: 'web' },
      { origin: baseUrl, cookie: first.cookie },
    );
    expect(second.status).toBe(200);
    const replacement = /^ks_session=(kss_[A-Za-z0-9_-]{43});/.exec(second.headers.getSetCookie()[0] ?? '')?.[1];
    if (replacement === undefined) throw new Error('no replacement cookie');
    secrets.add(replacement);
    await expectProblem(
      await fetch(`${baseUrl}/auth/session`, { headers: { cookie: first.cookie } }),
      401,
      'UNAUTHENTICATED',
    );
    expect((await fetch(`${baseUrl}/auth/session`, { headers: { cookie: `ks_session=${replacement}` } })).status).toBe(
      200,
    );
  });

  it('signs out everywhere: every session of the account ends', async () => {
    const address = freshAddress();
    const first = await nativeSignIn(address);
    const second = await nativeSignIn(address);
    expect(first.accountId).toBe(second.accountId);
    const response = await post('/auth/sign-out', { everywhere: true }, { authorization: `Bearer ${first.token}` });
    expect(await response.json()).toEqual({ status: 'signed_out', revoked: 2 });
    for (const token of [first.token, second.token])
      await expectProblem(
        await fetch(`${baseUrl}/auth/session`, { headers: { authorization: `Bearer ${token}` } }),
        401,
        'UNAUTHENTICATED',
      );
  });

  it('limits one address to three links per window and one client to ten requests', async () => {
    const address = freshAddress();
    for (let index = 0; index < 3; index += 1)
      expect((await post('/auth/sign-in', { email: address })).status).toBe(202);
    const limited = await post('/auth/sign-in', { email: address });
    await expectProblem(limited, 429, 'TOO_MANY_REQUESTS');
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);

    const client = '203.0.113.7';
    for (let index = 0; index < 10; index += 1)
      expect((await post('/auth/sign-in', { email: freshAddress() }, { 'x-forwarded-for': client })).status).toBe(202);
    const flooded = await post('/auth/sign-in', { email: freshAddress() }, { 'x-forwarded-for': client });
    await expectProblem(flooded, 429, 'TOO_MANY_REQUESTS');
    expect(Number(flooded.headers.get('retry-after'))).toBeGreaterThan(0);

    // One IPv6 client is its whole /64 (review M2): rotating the interface ID buys nothing.
    for (let index = 0; index < 10; index += 1)
      expect(
        (
          await post(
            '/auth/sign-in',
            { email: 'junk' },
            { 'x-forwarded-for': `2001:db8:77:1::${(index + 1).toString(16)}` },
          )
        ).status,
      ).toBe(422);
    await expectProblem(
      await post('/auth/sign-in', { email: freshAddress() }, { 'x-forwarded-for': '2001:db8:77:1:ffff:1:2:3' }),
      429,
      'TOO_MANY_REQUESTS',
    );
    expect(
      (await post('/auth/sign-in', { email: freshAddress() }, { 'x-forwarded-for': '2001:db8:77:2::1' })).status,
    ).toBe(202);
  });

  it('never lets malformed requests from many clients shut sign-in for everyone (review M2, probe p6)', async () => {
    const statuses: Record<number, number> = {};
    for (let client = 0; client < 31; client += 1)
      for (let index = 0; index < 10; index += 1) {
        const response = await post('/auth/sign-in', { email: 'abc' }, { 'x-forwarded-for': `192.0.2.${client + 1}` });
        statuses[response.status] = (statuses[response.status] ?? 0) + 1;
      }
    expect(statuses).toEqual({ 422: 310 });
    const person = await post('/auth/sign-in', { email: freshAddress() }, { 'x-forwarded-for': '203.0.113.77' });
    expect(person.status).toBe(202);
  });

  it('a redemption refused for a reused command ID leaves the link usable (review m1, probe p4)', async () => {
    const address = freshAddress();
    const commandId = randomUUID();
    const first = await post(
      '/auth/redeem',
      { token: await requestLink(address), commandId, client: 'web' },
      { origin: baseUrl },
    );
    expect(first.status).toBe(200);
    const cookie = /^ks_session=(kss_[A-Za-z0-9_-]{43});/.exec(first.headers.getSetCookie()[0] ?? '')?.[1];
    if (cookie !== undefined) secrets.add(cookie);
    const token = await requestLink(address);
    await expectProblem(
      await post('/auth/redeem', { token, commandId, client: 'web' }, { origin: baseUrl }),
      422,
      'COMMAND_KEY_REUSED',
    );
    const again = await post('/auth/redeem', { token, commandId: randomUUID(), client: 'web' }, { origin: baseUrl });
    expect(again.status).toBe(200);
    const second = /^ks_session=(kss_[A-Za-z0-9_-]{43});/.exec(again.headers.getSetCookie()[0] ?? '')?.[1];
    if (second !== undefined) secrets.add(second);
  });

  /** Runs the release's operator command with a clean environment; stdout and stderr apart. */
  async function operator(env: Record<string, string>, args: readonly string[]) {
    const child = spawn(process.execPath, [join('dist', 'operator.js'), ...args], {
      cwd: join(releaseDirectory(), 'api'),
      env: { PATH: process.env['PATH'] ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    extraOutputs.push(stderr);
    // Diagnostic records are JSON lines; the usage text (exit 2) is the only other stderr output.
    const records = stderr
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as { event: string; outcome?: string; reasonCode?: string });
    return { code, stdout, records };
  }

  it('issues operator links only in allow-listed worlds, for the world pattern, audited, and the API then signs in (review m2, m3, m9)', async () => {
    const address = freshAddress('operator.test');
    const env = {
      KS_WORLD: 'ci',
      DATABASE_URL: database.url,
      KS_PUBLIC_ORIGIN: baseUrl,
      KS_ALLOW_OPERATOR_SIGN_IN: '1',
      KS_OPERATOR_SIGN_IN_PATTERN: '*@operator.test',
    };
    const args = ['issue-sign-in', '--email', address];

    for (const [overrides, reasonCode] of [
      [{ KS_WORLD: 'live' }, 'refused_in_this_world'],
      [{ KS_WORLD: 'prod' }, 'refused_in_this_world'],
      [{ KS_WORLD: 'production' }, 'refused_in_this_world'],
      [{ KS_ALLOW_OPERATOR_SIGN_IN: '' }, 'not_enabled'],
      [{ KS_ALLOW_OPERATOR_SIGN_IN: 'true' }, 'not_enabled'],
      [{ KS_OPERATOR_SIGN_IN_PATTERN: '' }, 'pattern_invalid'],
      [{ KS_OPERATOR_SIGN_IN_PATTERN: '*@*' }, 'pattern_invalid'],
    ] as const) {
      const refused = await operator({ ...env, ...overrides }, args);
      expect({ code: refused.code, stdout: refused.stdout }).toEqual({ code: 1, stdout: '' });
      expect(refused.records.at(-1)).toMatchObject({
        event: 'identity.operator_sign_in',
        outcome: 'refused',
        reasonCode,
      });
    }
    // An address the pattern does not match: refused, nothing created.
    const outside = freshAddress();
    const notAllowed = await operator(env, ['issue-sign-in', '--email', outside]);
    expect({ code: notAllowed.code, stdout: notAllowed.stdout }).toEqual({ code: 1, stdout: '' });
    expect(notAllowed.records.at(-1)).toMatchObject({ reasonCode: 'address_not_allowed' });
    for (const candidate of [address, outside])
      expect(
        await handle.db
          .selectFrom('identity.email_addresses')
          .select('account_id')
          .where('address', '=', candidate)
          .execute(),
      ).toEqual([]);
    expect((await operator(env, ['issue-sign-in'])).code).toBe(2);

    const issued = await operator(env, args);
    expect(issued.code).toBe(0);
    expect(issued.records.map((record) => [record.event, record.outcome, record.reasonCode])).toEqual([
      ['identity.operator_sign_in', 'issued', 'account_created'],
    ]);
    const link = issued.stdout.trim();
    expect(issued.stdout).toBe(`${link}\n`);
    secrets.add(link);
    const token = tokenOf(link);
    const redeemed = await post('/auth/redeem', { token, commandId: randomUUID(), client: 'web' }, { origin: baseUrl });
    expect(redeemed.status).toBe(200);
    const redeemedBody = (await redeemed.json()) as { account: SignedIn };
    const cookie = /^ks_session=(kss_[A-Za-z0-9_-]{43});/.exec(redeemed.headers.getSetCookie()[0] ?? '')?.[1];
    if (cookie !== undefined) secrets.add(cookie);
    const disposable = await handle.db
      .selectFrom('identity.email_addresses')
      .select('disposable')
      .where('address', '=', address)
      .executeTakeFirst();
    expect(disposable).toEqual({ disposable: true });
    // The durable audit row (review m9): world, time, who ran it, the account.
    const audit = await handle.db
      .selectFrom('ops.operator_sign_ins')
      .select(['world', 'operator_source', 'account_id', 'account_created', 'issued_at'])
      .where('account_id', '=', redeemedBody.account.accountId)
      .execute();
    expect(audit).toEqual([
      {
        world: 'ci',
        operator_source: expect.stringMatching(/^cli:[a-z_][a-z0-9_.-]{0,31}$/) as unknown,
        account_id: redeemedBody.account.accountId,
        account_created: true,
        issued_at: expect.any(Date) as unknown,
      },
    ]);

    // An address that signed up by mail is never opened by the operator command.
    const real = freshAddress('operator.test');
    await webSignIn(real);
    const refused = await operator(env, ['issue-sign-in', '--email', real]);
    expect({ code: refused.code, stdout: refused.stdout }).toEqual({ code: 1, stdout: '' });
    expect(refused.records.at(-1)).toMatchObject({ reasonCode: 'not_disposable' });
  });

  it('never writes a token, link, cookie, address or database URL to its output', () => {
    const output = [api.rawOutput(), ...extraOutputs].join('\n');
    expect(secrets.size).toBeGreaterThan(10);
    for (const secret of secrets) expect(output.includes(secret)).toBe(false);
    expect(output).not.toMatch(/ksl_|kss_/);
    expect(output).not.toMatch(fixtureAddress);
    expect(output).not.toContain(database.url);
    expect(output.split('\n').filter((line) => line.includes('"identity.signed_in"')).length).toBeGreaterThan(5);
  });

  it('stops cleanly on SIGTERM', async () => {
    for (const socket of sockets) socket.close();
    expect(await api.stop('SIGTERM')).toBe(0);
  });
});

describe('sign-in mail through AgentMail (fake AgentMail on loopback)', () => {
  let database: Awaited<ReturnType<typeof createEmptyDatabase>>;
  let fake: Server;
  let received: { url: string; authorization: string | undefined; body: string }[];
  let respond: (response: ServerResponse) => void;

  beforeAll(async () => {
    database = await createEmptyDatabase('release_agentmail');
    const migrate = startReleaseProcess('api', 'migrate', { DATABASE_URL: database.url, KS_WORLD: 'ci' });
    expect(await migrate.exited()).toBe(0);
    received = [];
    fake = createServer((request: IncomingMessage, response: ServerResponse) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      request.on('end', () => {
        received.push({ url: request.url ?? '', authorization: request.headers.authorization, body });
        respond(response);
      });
    });
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    fake.closeAllConnections();
    await new Promise<void>((resolve) => fake.close(() => resolve()));
    await database.drop();
  });

  it('sends one request per link, and answers the same whether delivery succeeds or fails', async () => {
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const api = startReleaseProcess('api', 'main', {
      NODE_ENV: 'test',
      KS_WORLD: 'ci',
      DATABASE_URL: database.url,
      PORT: String(port),
      AGENTMAIL_API_KEY: agentMailCanaryKey,
      AGENTMAIL_INBOX_ID: 'knowscroll@agentmail.to',
      AGENTMAIL_BASE_URL: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`,
      AGENTMAIL_TIMEOUT_MS: '2000',
    });
    await api.waitForEvent('process.started');
    await waitForHttp(`${baseUrl}/health`);
    const signIn = (email: string) =>
      fetch(`${baseUrl}/auth/sign-in`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });

    respond = (response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message_id: '<fixture@agentmail>', thread_id: 'fixture' }));
    };
    const delivered = await signIn('delivered@identity.test');
    expect({ status: delivered.status, body: (await delivered.json()) as unknown }).toEqual({
      status: 202,
      body: { status: 'requested' },
    });
    await expect.poll(() => received.length, { timeout: 10_000 }).toBe(1);
    expect(received[0]).toMatchObject({
      url: '/v0/inboxes/knowscroll%40agentmail.to/messages/send',
      authorization: `Bearer ${agentMailCanaryKey}`,
    });
    expect(JSON.parse(received[0]?.body ?? '{}')).toMatchObject({ to: 'delivered@identity.test' });
    await api.waitForEvent('identity.sign_in_mail');

    respond = (response) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'fixture failure' }));
    };
    const failed = await signIn('undelivered@identity.test');
    expect({ status: failed.status, body: (await failed.json()) as unknown }).toEqual({
      status: 202,
      body: { status: 'requested' },
    });
    await expect.poll(() => received.length, { timeout: 10_000 }).toBe(2);
    await expect
      .poll(() => api.records.filter((record) => record.event === 'identity.sign_in_mail').length, { timeout: 10_000 })
      .toBe(2);
    // No retry: the failed send was attempted exactly once.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(received).toHaveLength(2);
    const mailRecords = api.records.filter((record) => record.event === 'identity.sign_in_mail');
    expect(mailRecords.map((record) => [record['outcome'], record['reasonCode'], record['status']])).toEqual([
      ['sent', undefined, undefined],
      ['failed', 'http_error', 500],
    ]);
    expect(await api.stop('SIGTERM')).toBe(0);
    const output = api.rawOutput();
    expect(output).not.toContain(agentMailCanaryKey);
    expect(output).not.toContain('@identity.test');
    expect(output).not.toMatch(/ksl_/);
  });
});

describe('the production configuration of sign-in', () => {
  const release = {
    NODE_ENV: 'production',
    KS_WORLD: 'ci',
    KS_COMMIT: '0'.repeat(40),
    KS_ARTIFACT_SHA256: 'b'.repeat(64),
  };

  async function refusal(env: Record<string, string>): Promise<readonly string[]> {
    const database = await createEmptyDatabase('release_identity_refuse');
    try {
      const port = await freePort();
      const api = startReleaseProcess('api', 'main', {
        ...release,
        DATABASE_URL: database.url,
        PORT: String(port),
        KS_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
        ...env,
      });
      expect(await api.exited()).toBe(1);
      const [record] = api.records;
      expect(record?.event).toBe('config.invalid');
      return (record?.['problems'] as string[] | undefined) ?? [];
    } finally {
      await database.drop();
    }
  }

  it('refuses to start without AgentMail fully configured', async () => {
    expect(await refusal({})).toEqual([
      'AGENTMAIL_API_KEY: missing_or_wrong_type',
      'AGENTMAIL_INBOX_ID: missing_or_wrong_type',
    ]);
    expect(await refusal({ ...fixtureAgentMail, AGENTMAIL_BASE_URL: 'http://127.0.0.1:9' })).toEqual([
      'AGENTMAIL_BASE_URL: refused_in_production',
    ]);
  });

  it('refuses the fixture mail sender and the fixture caller adapter', async () => {
    expect(await refusal({ KS_MAIL_SENDER: 'fixture' })).toEqual(['KS_MAIL_SENDER: refused_outside_test']);
    expect(await refusal({ ...fixtureAgentMail, KS_AUTH_ADAPTER: 'test-bearer' })).toEqual([
      'KS_AUTH_ADAPTER: refused_outside_test',
    ]);
  });

  it('refuses operator sign-in outside dev, stage, ci and local, whatever the production world is called (review m3)', async () => {
    for (const world of ['live', 'prod', 'live-2'])
      expect(
        await refusal({
          ...fixtureAgentMail,
          KS_WORLD: world,
          KS_ALLOW_OPERATOR_SIGN_IN: '1',
          KS_OPERATOR_SIGN_IN_PATTERN: '*@test.knowscroll.space',
        }),
        world,
      ).toEqual(['KS_ALLOW_OPERATOR_SIGN_IN: refused_in_this_world']);
    expect(await refusal({ ...fixtureAgentMail, KS_ALLOW_OPERATOR_SIGN_IN: '1' })).toEqual([
      'KS_OPERATOR_SIGN_IN_PATTERN: missing_or_wrong_type',
    ]);
  });
});
