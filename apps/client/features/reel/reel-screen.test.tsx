import type * as React from 'react';
import type * as Ui from '@knowscroll/ui';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { createAccountScopeManager, memoryStore } from '@knowscroll/client-core';
import type { OpenExposureResponse, ReelDocument } from '@knowscroll/contracts';
import { DisplayProvider, ReelPlayer } from '@knowscroll/ui';
import { AccountScopeProvider } from '../../providers/account-scope';
import { ReelScreen } from './reel-screen';

// Real screen, AccountScope and oRPC response parsing over labelled HTTP fixtures. Only the
// video decoder, command UUIDs and router focus/parameters are stand-ins; no playback or backend is claimed.
jest.mock('expo-video', () => ({ VideoView: 'VideoView', useVideoPlayer: jest.fn() }));
jest.mock('../../platform/command-id', () => ({
  newCommandId: () => '0199a000-0000-7000-8000-0000000000a1',
}));
jest.mock('@knowscroll/ui', () => ({
  ...jest.requireActual<typeof Ui>('@knowscroll/ui'),
  ReelPlayer: jest.fn(() => null),
}));
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof React>('react');
  return {
    useLocalSearchParams: () => ({ assetId: '0199a000-0000-7000-8000-0000000000a1' }),
    useRouter: () => ({ canGoBack: () => false, back: jest.fn(), replace: jest.fn() }),
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
  };
});

const ID = '0199a000-0000-7000-8000-0000000000a1';
const EXPOSURE = '0199a000-0000-7000-8000-0000000000e1';
const account = { accountId: ID, universeId: EXPOSURE, privacyEpoch: 1, email: 'reel@screen.test' };
const direct = {
  commandId: ID,
  exposureId: EXPOSURE,
  assetId: ID,
  assetRevision: 1,
  kind: 'reel' as const,
  revision: 0,
  replayed: false,
};
const document: ReelDocument = {
  schemaVersion: 'reel-document.v1',
  assetId: ID,
  revision: 1,
  title: 'Fixture Reel',
  summary: 'HTTP component fixture, not real media.',
  language: 'en',
  truthLabel: 'generated',
  fixture: true,
  captions: 'burned_in',
  mediaKey: `sha256/aa/${'a'.repeat(64)}.mp4`,
  durationMs: 20000,
  width: 1080,
  height: 1920,
};
const grant = { document, path: '/media/fixture', expiresAt: '2026-10-20T18:00:00.000Z' };
const action = {
  commandId: ID,
  actionId: EXPOSURE,
  assetId: ID,
  assetRevision: 1,
  changed: true,
  revision: 1,
  replayed: false,
};
const outcome = { commandId: ID, sessionId: ID, intentRevision: 1, revision: 0, decisionId: ID, replayed: false };
const discovery: readonly OpenExposureResponse[] = [
  {
    ...outcome,
    status: 'ready',
    offer: {
      offerId: ID,
      decisionId: ID,
      assetId: ID,
      assetRevision: 1,
      explanationUnitId: 'fixture-explanation',
      metadata: { kind: 'reel', title: 'Fixture offer', summary: 'Prepared supply only.', language: 'en' },
      relation: { kind: 'discovery' },
      variants: [],
    },
    bufferedOffers: [],
  },
  { ...outcome, status: 'pending', reason: 'buffer_preparing' },
  { ...outcome, status: 'exhausted', reason: 'no_eligible_content' },
];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}
function deferredResponse() {
  let release: (body: unknown) => void = () => {
    throw new Error('Fixture has no pending response');
  };
  const response = new Promise<Response>((resolve) => {
    release = (body) => resolve(json(body));
  });
  return { response, release: (body: unknown) => release(body) };
}
async function mount(
  options: {
    open?: () => Promise<Response>;
    grant?: () => Promise<Response>;
    action?: () => Promise<Response>;
    saved?: boolean;
  } = {},
) {
  const paths: string[] = [];
  const requests: Request[] = [];
  const manager = createAccountScopeManager({
    baseUrl: 'https://app.reel-screen.test',
    platform: 'web',
    store: memoryStore(),
    newQueryClient: () => new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } }),
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      requests.push(request);
      if (path === '/auth/session')
        return Promise.resolve(json({ account, client: 'web', expiresAt: '2026-11-18T00:00:00.000Z' }));
      if (path === '/v1/experience/open') return options.open?.() ?? Promise.resolve(json(direct));
      if (path === '/v1/media/grants') return options.grant?.() ?? Promise.resolve(json(grant));
      if (path === '/v1/experience/activate')
        return Promise.resolve(
          json({
            commandId: ID,
            exposureId: EXPOSURE,
            activatedAt: '2026-10-20T10:00:00.000Z',
            revision: 0,
            replayed: false,
          }),
        );
      if (path === '/v1/saved')
        return Promise.resolve(
          json({
            revision: 0,
            items: options.saved ? [{ assetId: ID, assetRevision: 1, savedAt: '2026-10-20T10:00:00.000Z' }] : [],
          }),
        );
      if (path === '/v1/actions')
        return options.action?.() ?? Promise.resolve(json({ ...action, kind: 'save', saved: true }));
      if (path === '/health')
        return Promise.resolve(
          json({
            status: 'ok',
            world: 'live',
            commit: 'unknown',
            artifact: 'unknown',
            migration: '0014',
            relay: 'listening',
          }),
        );
      return Promise.reject(new Error('Unexpected fixture route'));
    },
  });
  const rendered = await render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <AccountScopeProvider manager={manager}>
        <ReelScreen />
      </AccountScopeProvider>
    </DisplayProvider>,
  );
  return {
    ...rendered,
    paths,
    requests,
    manager,
    endScope() {
      const state = manager.getState();
      if (state.status !== 'signed_in') throw new Error('Fixture scope is not signed in');
      state.scope.end();
    },
  };
}

describe('direct Reel response boundaries', () => {
  beforeEach(() => {
    jest.mocked(ReelPlayer).mockClear();
  });

  it.each(discovery)('refuses discovery $status without minting a grant or activating', async (reply) => {
    const app = await mount({ open: () => Promise.resolve(json(reply)) });
    expect(await screen.findByText("This Reel isn't available")).toBeOnTheScreen();
    expect(app.paths).not.toContain('/v1/media/grants');
    expect(app.paths).not.toContain('/v1/experience/activate');
    expect(ReelPlayer).not.toHaveBeenCalled();
    await app.unmount();
  });

  it('refuses direct Scroll lineage before granting or activating a Reel', async () => {
    const app = await mount({ open: () => Promise.resolve(json({ ...direct, kind: 'scroll' })) });
    expect(await screen.findByText("This Reel isn't available")).toBeOnTheScreen();
    expect(app.paths).not.toContain('/v1/media/grants');
    expect(app.paths).not.toContain('/v1/experience/activate');
    await app.unmount();
  });

  it.each([false, true])('continues valid direct Reel lineage and toggles initial saved=%s', async (saved) => {
    const app = await mount({
      saved,
      action: () => Promise.resolve(json({ ...action, kind: saved ? 'unsave' : 'save', saved: !saved })),
    });
    expect(await screen.findByText(document.title)).toBeOnTheScreen();
    expect(
      app.paths.filter((path) => ['/v1/experience/open', '/v1/media/grants', '/v1/experience/activate'].includes(path)),
    ).toEqual(['/v1/experience/open', '/v1/media/grants', '/v1/experience/activate']);
    const request = app.requests.find((entry) => new URL(entry.url).pathname === '/v1/experience/open');
    expect(await request?.clone().json()).toMatchObject({
      target: { kind: 'reel', assetId: ID },
      origin: { kind: 'direct' },
    });
    expect(ReelPlayer).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole('togglebutton', { name: 'Save' })).toHaveProp(
        'accessibilityState',
        expect.objectContaining({ checked: saved }),
      ),
    );
    await fireEvent.press(screen.getByRole('togglebutton', { name: 'Save' }));
    await waitFor(() =>
      expect(screen.getByRole('togglebutton', { name: 'Save' })).toHaveProp(
        'accessibilityState',
        expect.objectContaining({ checked: !saved }),
      ),
    );
    await app.unmount();
  });

  it('preserves Save state and shows a controlled failure for a Like outcome', async () => {
    const app = await mount({
      saved: true,
      action: () => Promise.resolve(json({ ...action, kind: 'like', liked: true, hidden: false })),
    });
    await screen.findByText(document.title);
    await waitFor(() =>
      expect(screen.getByRole('togglebutton', { name: 'Save' })).toHaveProp(
        'accessibilityState',
        expect.objectContaining({ checked: true }),
      ),
    );
    await fireEvent.press(screen.getByRole('togglebutton', { name: 'Save' }));
    expect(await screen.findByText("Couldn't save")).toBeOnTheScreen();
    expect(screen.getByRole('togglebutton', { name: 'Save' })).toHaveProp(
      'accessibilityState',
      expect.objectContaining({ checked: true }),
    );
    await app.unmount();
  });

  it.each(['open', 'grant'] as const)(
    'drops a late %s response after scope end before later effects',
    async (stage) => {
      const pending = deferredResponse();
      const app = await mount({ [stage]: () => pending.response });
      const path = stage === 'open' ? '/v1/experience/open' : '/v1/media/grants';
      await waitFor(() => expect(app.paths).toContain(path));
      await act(async () => {
        app.endScope();
        pending.release(stage === 'open' ? direct : grant);
        await Promise.resolve();
      });
      expect(app.paths).not.toContain('/v1/experience/activate');
      if (stage === 'open') expect(app.paths).not.toContain('/v1/media/grants');
      expect(ReelPlayer).not.toHaveBeenCalled();
      await app.unmount();
    },
  );

  it('drops a late action outcome after scope end without changing Save state', async () => {
    const pending = deferredResponse();
    const app = await mount({ action: () => pending.response });
    await screen.findByText(document.title);
    await fireEvent.press(screen.getByRole('togglebutton', { name: 'Save' }));
    await act(async () => {
      app.endScope();
      pending.release({ ...action, kind: 'save', saved: true });
      await Promise.resolve();
    });
    expect(screen.getByRole('togglebutton', { name: 'Save' })).toHaveProp(
      'accessibilityState',
      expect.objectContaining({ checked: false }),
    );
    expect(screen.queryByText("Couldn't save")).toBeNull();
    await app.unmount();
  });
});
