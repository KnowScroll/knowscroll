import { createApiClient, ScopeEndedError } from '@knowscroll/client-core';
import document from '@knowscroll/scroll-model/fixtures/spring-neap-tides.json';
import { SCROLL_CAPABILITIES } from './capabilities';
import { createScrollSession, type ScrollSessionState } from './scroll-session';

/**
 * Opening a Scroll (open → document → activate) over a labelled fixture `fetch`: no network, no API.
 * The assets, exposures and documents are fixtures (the document is scroll-model's labelled
 * `spring-neap-tides` consumer fixture).
 */
const ASSET = '0199a000-0000-7000-8000-0000000000a1';
const EXPOSURE = '0199a000-0000-7000-8000-0000000000e1';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const PROBLEM_STATUS = {
  ASSET_NOT_FOUND: 404,
  UNIVERSE_UNAVAILABLE: 403,
  UNPROCESSABLE_REQUEST: 422,
  INTERNAL: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;

/** An RFC 9457 problem as the API sends it (`application/problem+json`). */
function problem(code: keyof typeof PROBLEM_STATUS): Response {
  const status = PROBLEM_STATUS[code];
  return new Response(
    JSON.stringify({
      type: `tag:knowscroll.space,2026:problem:${code.toLowerCase()}`,
      title: 'Fixture problem.',
      status,
      code,
    }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

type Handler = (request: Request) => Response | Promise<Response>;

/** The fixture server: one handler per step, each recording the body it was sent. */
function fixture(handlers: { open?: Handler; document?: Handler; activate?: Handler }) {
  const calls: { path: string; body: unknown }[] = [];
  const fetch = jest.fn(async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    const body: unknown = request.method === 'POST' ? await request.clone().json() : undefined;
    calls.push({ path, body });
    if (path === '/v1/experience/open')
      return (
        handlers.open?.(request) ??
        json(200, {
          commandId: (body as { commandId: string }).commandId,
          exposureId: EXPOSURE,
          assetId: ASSET,
          assetRevision: 2,
          kind: 'scroll',
          revision: 0,
          replayed: false,
        })
      );
    if (path === `/v1/experience/exposures/${EXPOSURE}/document`)
      return (
        handlers.document?.(request) ??
        json(200, { exposureId: EXPOSURE, assetId: ASSET, assetRevision: 2, document, degradedEssential: [] })
      );
    if (path === '/v1/experience/activate')
      return (
        handlers.activate?.(request) ??
        json(200, {
          commandId: (body as { commandId: string }).commandId,
          exposureId: EXPOSURE,
          activatedAt: '2026-10-20T10:00:00.000Z',
          revision: 0,
          replayed: false,
        })
      );
    return json(404, {});
  });
  return { fetch, calls };
}

function sessionOver(server: ReturnType<typeof fixture>) {
  const api = createApiClient({ baseUrl: 'https://app.session.test', fetch: server.fetch });
  let counter = 0;
  const newId = () => `0199a000-0000-7000-8000-${String(++counter).padStart(12, '0')}`;
  const session = createScrollSession({ scope: { api, active: true }, assetId: ASSET, newId });
  const states: ScrollSessionState['status'][] = [];
  session.subscribe(() => states.push(session.getState().status));
  return { session, states };
}

const settled = (session: ReturnType<typeof createScrollSession>, ...statuses: ScrollSessionState['status'][]) =>
  new Promise<ScrollSessionState>((resolve) => {
    const check = () => {
      const state = session.getState();
      if (statuses.includes(state.status)) resolve(state);
    };
    session.subscribe(check);
    check();
  });

describe('opening a Scroll for the signed-in scope', () => {
  it('opens the exposure, reads the document negotiated for this build, activates, and only then is ready', async () => {
    const server = fixture({});
    const { session, states } = sessionOver(server);
    session.start();
    const state = await settled(session, 'ready');
    expect(states).toEqual(['opening', 'loading', 'activating', 'ready']);
    expect(server.calls.map((call) => call.path)).toEqual([
      '/v1/experience/open',
      `/v1/experience/exposures/${EXPOSURE}/document`,
      '/v1/experience/activate',
    ]);
    expect(server.calls[0]?.body).toMatchObject({
      target: { kind: 'scroll', assetId: ASSET },
      origin: { kind: 'direct' },
      capabilities: SCROLL_CAPABILITIES,
    });
    expect(server.calls[2]?.body).toMatchObject({ exposureId: EXPOSURE });
    if (state.status === 'ready') {
      expect(state.scroll).toMatchObject({ exposureId: EXPOSURE, assetId: ASSET, assetRevision: 2 });
      expect(state.scroll.document.title).toBe(document.title);
    }
  });

  it('retries from the step that failed, with the same command IDs: no second exposure, no second activation', async () => {
    let documentCalls = 0;
    const server = fixture({
      document: () => {
        documentCalls += 1;
        return documentCalls === 1
          ? problem('SERVICE_UNAVAILABLE')
          : json(200, { exposureId: EXPOSURE, assetId: ASSET, assetRevision: 2, document, degradedEssential: [] });
      },
    });
    const { session } = sessionOver(server);
    session.start();
    expect((await settled(session, 'ready', 'error', 'offline')).status).toBe('error');
    session.start();
    expect((await settled(session, 'ready')).status).toBe('ready');
    const opens = server.calls.filter((call) => call.path === '/v1/experience/open');
    expect(opens).toHaveLength(1);
    expect(server.calls.filter((call) => call.path === '/v1/experience/activate')).toHaveLength(1);
    expect(documentCalls).toBe(2);
  });

  it('retries the open command with the same ID when it failed before answering', async () => {
    let first = true;
    const server = fixture({
      open: (request) => {
        if (first) {
          first = false;
          return problem('SERVICE_UNAVAILABLE');
        }
        return request
          .clone()
          .json()
          .then((body: { commandId: string }) =>
            json(200, {
              commandId: body.commandId,
              exposureId: EXPOSURE,
              assetId: ASSET,
              assetRevision: 2,
              kind: 'scroll',
              revision: 0,
              replayed: true,
            }),
          );
      },
    });
    const { session } = sessionOver(server);
    session.start();
    await settled(session, 'error');
    session.start();
    await settled(session, 'ready');
    const ids = server.calls
      .filter((call) => call.path === '/v1/experience/open')
      .map((call) => (call.body as { commandId: string }).commandId);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
  });

  it.each([
    ['ASSET_NOT_FOUND', 'unavailable'],
    ['UNIVERSE_UNAVAILABLE', 'unavailable'],
    ['UNPROCESSABLE_REQUEST', 'needs_update'],
    ['INTERNAL', 'error'],
  ] as const)('shows a %s answer as the %s state', async (code, expected) => {
    const server = fixture({ open: () => problem(code) });
    const { session } = sessionOver(server);
    session.start();
    expect((await settled(session, expected)).status).toBe(expected);
  });

  it('shows an unreachable API as offline, never as an error of ours', async () => {
    const api = createApiClient({
      baseUrl: 'https://app.session.test',
      fetch: () => Promise.reject(new TypeError('Network request failed')),
    });
    const session = createScrollSession({
      scope: { api, active: true },
      assetId: ASSET,
      newId: () => '0199a000-0000-7000-8000-000000000001',
    });
    session.start();
    expect((await settled(session, 'offline')).status).toBe('offline');
  });

  it('shows a document the client cannot parse as an error rather than rendering it', async () => {
    const server = fixture({
      document: () =>
        json(200, {
          exposureId: EXPOSURE,
          assetId: ASSET,
          assetRevision: 2,
          document: { ...document, schemaVersion: 'scroll-document.v9' },
          degradedEssential: [],
        }),
    });
    const { session } = sessionOver(server);
    session.start();
    expect((await settled(session, 'error')).status).toBe('error');
    expect(server.calls.some((call) => call.path === '/v1/experience/activate')).toBe(false);
  });

  it('drops the answer of an ended scope: no state changes after the scope ended or the session was disposed', async () => {
    const gate: { release?: () => void } = {};
    const server = fixture({
      open: () =>
        new Promise<Response>((resolve) => {
          gate.release = () => resolve(json(200, {}));
        }),
    });
    const { session, states } = sessionOver(server);
    session.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    session.dispose();
    gate.release?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(states).toEqual(['opening']);
    expect(new ScopeEndedError().code).toBe('SCOPE_ENDED');
  });
});
