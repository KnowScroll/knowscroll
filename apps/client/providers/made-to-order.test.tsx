import { QueryClient } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { createAccountScopeManager, memoryStore } from '@knowscroll/client-core';
import { AccountScopeProvider } from './account-scope';
import { MadeToOrderContext, useMadeToOrder, useMadeToOrderState } from './made-to-order';

/**
 * The made-to-order switch as the app learns it (D-436): one read of `GET /v1/account/features` per scope, made by the first
 * screen that can show a way in (never at app start), over a labelled fixture `fetch`. Only the API's own "on" shows a way in; waiting, "off", a failure and being signed out all show none.
 */
const account = {
  accountId: '0199a000-0000-7000-8000-00000000000a',
  universeId: '0199a000-0000-7000-8000-0000000000aa',
  privacyEpoch: 1,
  email: 'a@scope.test',
};

const newQueryClient = () => new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Features = { status: number; body: unknown } | 'never';

function server(features: Features, signedIn = true) {
  const paths: string[] = [];
  const fetch = jest.fn((request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    paths.push(path);
    if (path === '/auth/session')
      return Promise.resolve(
        signedIn ? json(200, { account, client: 'web', expiresAt: '2026-11-30T00:00:00.000Z' }) : json(401, {}),
      );
    if (path === '/v1/account/features')
      return features === 'never'
        ? new Promise(() => undefined)
        : Promise.resolve(json(features.status, features.body));
    return Promise.resolve(json(404, {}));
  });
  return { fetch, paths };
}

function Probe() {
  return <Text>{`${useMadeToOrderState()} ${String(useMadeToOrder())}`}</Text>;
}

function Elsewhere() {
  return <Text>nothing made to order here</Text>;
}

async function mounted(s: ReturnType<typeof server>, child = <Probe />) {
  const manager = createAccountScopeManager({
    baseUrl: 'https://app.scope.test',
    platform: 'web',
    fetch: s.fetch,
    store: memoryStore(),
    newQueryClient,
  });
  await render(<AccountScopeProvider manager={manager}>{child}</AccountScopeProvider>);
}

describe('the made-to-order switch in the app', () => {
  it('shows a way in only when the API says the features are on', async () => {
    const s = server({ status: 200, body: { version: 'account-features.v1', madeToOrder: true } });
    await mounted(s);
    expect(await screen.findByText('on true')).toBeOnTheScreen();
    expect(s.paths.filter((path) => path === '/v1/account/features')).toHaveLength(1);
  });

  it('shows none when the API says they are off', async () => {
    await mounted(server({ status: 200, body: { version: 'account-features.v1', madeToOrder: false } }));
    expect(await screen.findByText('off false')).toBeOnTheScreen();
  });

  it('shows none while the answer has not arrived, and says it is not known yet', async () => {
    await mounted(server('never'));
    expect(await screen.findByText('unknown false')).toBeOnTheScreen();
  });

  it('treats a failed read and an answer that is not the contract as off', async () => {
    await mounted(server({ status: 500, body: {} }));
    expect(await screen.findByText('off false')).toBeOnTheScreen();
  });

  it('treats an old API with no such route as off', async () => {
    await mounted(server({ status: 404, body: {} }));
    expect(await screen.findByText('off false')).toBeOnTheScreen();
  });

  it('is off when nobody is signed in, and asks nothing', async () => {
    const s = server({ status: 200, body: { version: 'account-features.v1', madeToOrder: true } }, false);
    await mounted(s);
    expect(await screen.findByText('off false')).toBeOnTheScreen();
    expect(s.paths).not.toContain('/v1/account/features');
  });

  it('makes no read at all for a screen that has no way in: the read belongs to the screens that can show one', async () => {
    const s = server({ status: 200, body: { version: 'account-features.v1', madeToOrder: true } });
    await mounted(s, <Elsewhere />);
    expect(await screen.findByText('nothing made to order here')).toBeOnTheScreen();
    expect(s.paths).toContain('/auth/session');
    expect(s.paths).not.toContain('/v1/account/features');
  });

  it('makes one read for two screens under the same scope', async () => {
    const s = server({ status: 200, body: { version: 'account-features.v1', madeToOrder: true } });
    await mounted(
      s,
      <>
        <Probe />
        <Text>second</Text>
        <Probe />
      </>,
    );
    expect(await screen.findAllByText('on true')).toHaveLength(2);
    expect(s.paths.filter((path) => path === '/v1/account/features')).toHaveLength(1);
  });

  it('is off, and does not throw, for a screen rendered alone with no account scope and no query client', async () => {
    await render(<Probe />);
    expect(screen.getByText('off false')).toBeOnTheScreen();
  });

  it('is on for a test that says so through the context, whatever the API would say', async () => {
    await render(
      <MadeToOrderContext.Provider value="on">
        <Probe />
      </MadeToOrderContext.Provider>,
    );
    expect(screen.getByText('on true')).toBeOnTheScreen();
  });

  it('is unknown for a test that says so, and off for one that says off', async () => {
    await render(
      <MadeToOrderContext.Provider value="unknown">
        <Probe />
      </MadeToOrderContext.Provider>,
    );
    expect(screen.getByText('unknown false')).toBeOnTheScreen();
  });
});
