import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
 * Sign-in through the deployed release trees (S1.3 #226, D-018): email links (fixture mail
 * sender, and AgentMail against a local fake), web cookies with origin checks, native bearer
 * tokens, sockets, sign-out, the operator command and the production refusals.
 *
 * Evidence label: CI fixture + real database. Every address is a fixture under `.test`; the
 * AgentMail key is a canary for a fake server on loopback; no mail leaves the runner.
 */
const agentMailCanaryKey = 'canary-agentmail-key-Rt55';
const fixtureAgentMail = { AGENTMAIL_API_KEY: 'fixture-not-a-key', AGENTMAIL_INBOX_ID: 'fixture@agentmail.invalid' };
let addressCounter = 0;
const freshAddress = () => `release-${Date.now()}-${(addressCounter += 1)}@identity.test`;
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

  async function requestLink(address: string): Promise<string> {
    const response = await post('/auth/sign-in', { email: address });
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

  /** Signs in on the web; returns the `Cookie` header value. */
  async function webSignIn(
    address = freshAddress(),
  ): Promise<{ cookie: string; universeId: string; accountId: string }> {
    const response = await post(
      '/auth/redeem',
      { token: await requestLink(address), commandId: randomUUID(), client: 'web' },
      { origin: baseUrl },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { account: { universeId: string; accountId: string } };
    const setCookie = response.headers.getSetCookie();
    const value = /^ks_session=(kss_[A-Za-z0-9_-]{43});/.exec(setCookie[0] ?? '')?.[1];
    if (value === undefined) throw new Error('no session cookie');
    secrets.add(value);
    return { cookie: `ks_session=${value}`, ...body.account };
  }

  async function nativeSignIn(
    address = freshAddress(),
  ): Promise<{ token: string; universeId: string; accountId: string }> {
    const response = await post('/auth/redeem', {
      token: await requestLink(address),
      commandId: randomUUID(),
      client: 'native',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      session: { token: string };
      account: { universeId: string; accountId: string };
    };
    secrets.add(body.session.token);
    return { token: body.session.token, ...body.account };
  }

  function connect(options: { cookie?: string; origin?: string; token?: string }): Socket {
    const socket = io(baseUrl, {
      path: SOCKET_PATH,
      transports: ['websocket'],
      reconnection: false,
      ...(options.token === undefined ? {} : { auth: { token: options.token } }),
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
    await expectProblem(await post('/auth/sign-in', { email: 'not an address' }), 400, 'INVALID_REQUEST');
  });

  it('signs in on the web with an HttpOnly, SameSite=Lax cookie and no token in the body', async () => {
    const address = freshAddress();
    const token = await requestLink(address);
    const response = await post('/auth/redeem', { token, commandId: randomUUID(), client: 'web' }, { origin: baseUrl });
    expect(response.status).toBe(200);
    const [cookie] = response.headers.getSetCookie();
    expect(cookie).toMatch(/^ks_session=kss_[A-Za-z0-9_-]{43}; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax$/);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ accountCreated: true, replayed: false, session: { kind: 'cookie' } });
    expect(JSON.stringify(body)).not.toMatch(/kss_/);
    const value = cookie?.split(';')[0] ?? '';
    secrets.add(value.replace('ks_session=', ''));
    const session = await fetch(`${baseUrl}/auth/session`, { headers: { cookie: value } });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({
      account: (body as { account: unknown }).account,
      client: 'web',
    });
    const saved = await fetch(`${baseUrl}/v1/saved`, { headers: { cookie: value } });
    expect(saved.status).toBe(200);
  });

  it('refuses cookie-authenticated changes that do not come from this origin, and web redemption from elsewhere', async () => {
    const { cookie } = await webSignIn();
    const action = () => ({
      commandId: randomUUID(),
      kind: 'save',
      target: { assetId: asset.assetId, assetRevision: asset.revision },
    });
    await expectProblem(await post('/v1/actions', action(), { cookie }), 403, 'ORIGIN_NOT_ALLOWED');
    await expectProblem(
      await post('/v1/actions', action(), { cookie, origin: 'https://attacker.invalid' }),
      403,
      'ORIGIN_NOT_ALLOWED',
    );
    await expectProblem(await post('/auth/sign-out', {}, { cookie }), 403, 'ORIGIN_NOT_ALLOWED');
    const allowed = await post('/v1/actions', action(), { cookie, origin: baseUrl });
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
    expect((await fetch(`${baseUrl}/v1/saved`, { headers: { authorization: `Bearer ${native.token}` } })).status).toBe(
      200,
    );
    // A bearer request needs no Origin: no browser attaches it on its own.
    const saved = await post(
      '/v1/actions',
      { commandId: randomUUID(), kind: 'save', target: { assetId: asset.assetId, assetRevision: asset.revision } },
      { authorization: `Bearer ${native.token}` },
    );
    expect(saved.status).toBe(200);
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
    expect((await post('/auth/redeem', { token, commandId: randomUUID(), client: 'native' })).status).toBe(200);
  });

  it('replays a retried redemption with a fresh session and refuses the link to any other command', async () => {
    const token = await requestLink(freshAddress());
    const commandId = randomUUID();
    const first = (await (await post('/auth/redeem', { token, commandId, client: 'native' })).json()) as {
      account: unknown;
      session: { token: string };
    };
    const retry = await post('/auth/redeem', { token, commandId, client: 'native' });
    expect(retry.status).toBe(200);
    const replay = (await retry.json()) as { account: unknown; replayed: boolean; session: { token: string } };
    secrets.add(first.session.token);
    secrets.add(replay.session.token);
    expect(replay).toMatchObject({ account: first.account, replayed: true });
    expect(replay.session.token).not.toBe(first.session.token);
    await expectProblem(
      await post('/auth/redeem', { token, commandId: randomUUID(), client: 'native' }),
      400,
      'SIGN_IN_LINK_INVALID',
    );
  });

  it('authenticates sockets by cookie from this origin or by bearer token, and drops them at sign-out', async () => {
    const web = await webSignIn();
    const fromElsewhere = connect({ cookie: web.cookie, origin: 'https://attacker.invalid' });
    await expect(connected(fromElsewhere)).rejects.toThrow('ORIGIN_NOT_ALLOWED');
    const socket = connect({ cookie: web.cookie, origin: baseUrl });
    await connected(socket);
    expect(
      await socket.emitWithAck(socketEvents.subscribeScope, { scope: { kind: 'universe', id: web.universeId } }),
    ).toEqual({ ok: true, revision: 0 });

    const native = await nativeSignIn();
    const nativeSocket = connect({ token: native.token });
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
      await fetch(`${baseUrl}/v1/saved`, { headers: { cookie: web.cookie } }),
      401,
      'UNAUTHENTICATED',
    );
    await expect(connected(connect({ cookie: web.cookie, origin: baseUrl }))).rejects.toThrow('UNAUTHENTICATED');
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

  it('issues operator links only outside live with the flag set, for a disposable account the API then signs in', async () => {
    const address = freshAddress();
    const env = {
      KS_WORLD: 'ci',
      DATABASE_URL: database.url,
      KS_PUBLIC_ORIGIN: baseUrl,
      KS_ALLOW_OPERATOR_SIGN_IN: '1',
    };
    const args = ['issue-sign-in', '--email', address];

    for (const [overrides, reasonCode] of [
      [{ KS_WORLD: 'live' }, 'refused_in_live'],
      [{ KS_ALLOW_OPERATOR_SIGN_IN: '' }, 'not_enabled'],
      [{ KS_ALLOW_OPERATOR_SIGN_IN: 'true' }, 'not_enabled'],
    ] as const) {
      const refused = await operator({ ...env, ...overrides }, args);
      expect({ code: refused.code, stdout: refused.stdout }).toEqual({ code: 1, stdout: '' });
      expect(refused.records.at(-1)).toMatchObject({
        event: 'identity.operator_sign_in',
        outcome: 'refused',
        reasonCode,
      });
    }
    expect(
      await handle.db
        .selectFrom('identity.email_addresses')
        .select('account_id')
        .where('address', '=', address)
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
    const redeemed = await post('/auth/redeem', { token, commandId: randomUUID(), client: 'native' });
    expect(redeemed.status).toBe(200);
    secrets.add(((await redeemed.json()) as { session: { token: string } }).session.token);
    const disposable = await handle.db
      .selectFrom('identity.email_addresses')
      .select('disposable')
      .where('address', '=', address)
      .executeTakeFirst();
    expect(disposable).toEqual({ disposable: true });

    // An address that signed up by mail is never opened by the operator command.
    const real = freshAddress();
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
    expect(output).not.toContain('@identity.test');
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

  it('refuses operator sign-in in live', async () => {
    expect(await refusal({ ...fixtureAgentMail, KS_WORLD: 'live', KS_ALLOW_OPERATOR_SIGN_IN: '1' })).toEqual([
      'KS_ALLOW_OPERATOR_SIGN_IN: refused_in_live',
    ]);
  });
});
