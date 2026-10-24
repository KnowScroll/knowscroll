import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { createAccountScope, memoryStore, type AccountScope } from '@knowscroll/client-core';
import { DisplayProvider } from '@knowscroll/ui';
import { OperatorEvidencePanel } from './operator-evidence-panel';

/**
 * The dev-only evidence panel over a labelled fixture `fetch`: no network, no API. It exists to show
 * the committed evidence watermark in worlds that have operator tools, and nowhere else.
 */
const account = {
  accountId: '0199a000-0000-7000-8000-00000000000a',
  universeId: '0199a000-0000-7000-8000-0000000000aa',
  privacyEpoch: 1,
  email: 'a@panel.test',
};
const EXPOSURE = '0199a000-0000-7000-8000-0000000000e1';

function json(status: number, body: unknown, type = 'application/json'): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });
}

const evidence = {
  revision: 5,
  exposureId: EXPOSURE,
  observations: { count: 14, lastReceivedAt: '2026-10-20T10:00:00.000Z' },
  evidence: {
    revision: 3,
    inputWatermark: 14,
    policyVersion: 'scroll-qualification.v0',
    qualification: 'qualified',
    q: 0.7312,
    coverage: 1,
    activeDwellMs: 105_000,
    estimatedReadingMs: 227_100,
    committedAt: '2026-10-20T10:00:01.000Z',
  },
};

async function mount(world: string, diagnostics: () => Response) {
  const paths: string[] = [];
  const scope: AccountScope = createAccountScope({
    account,
    baseUrl: 'https://app.panel.test',
    fetch: (request: Request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path === '/health')
        return Promise.resolve(
          json(200, {
            status: 'ok',
            world,
            commit: 'unknown',
            artifact: 'unknown',
            migration: '0012',
            relay: 'listening',
          }),
        );
      if (path === `/v1/diagnostics/exposures/${EXPOSURE}/evidence`) return Promise.resolve(diagnostics());
      return Promise.resolve(json(404, {}));
    },
    authorization: () => undefined,
    store: memoryStore(),
  });
  await render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <QueryClientProvider client={scope.queryClient}>
        <OperatorEvidencePanel scope={scope} exposureId={EXPOSURE} />
      </QueryClientProvider>
    </DisplayProvider>,
  );
  return { paths, scope };
}

describe('the dev evidence panel', () => {
  it('shows the committed evidence of the exposure in a world with operator tools, and expands to its watermark', async () => {
    const { scope } = await mount('local', () => json(200, evidence));
    expect(await screen.findByText('rev 3 · qualified · q 0.73')).toBeOnTheScreen();
    expect(screen.queryByTestId('ks-dev-qualification')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Developer diagnostics: evidence' }));
    expect(screen.getByTestId('ks-dev-universe-revision')).toHaveTextContent('5');
    expect(screen.getByTestId('ks-dev-observations')).toHaveTextContent('14');
    expect(screen.getByTestId('ks-dev-evidence-revision')).toHaveTextContent('3');
    expect(screen.getByTestId('ks-dev-qualification')).toHaveTextContent('qualified');
    scope.end();
  });

  it('says so when no evidence has been committed yet', async () => {
    const { scope } = await mount('dev', () =>
      json(200, { ...evidence, revision: 1, observations: { count: 2, lastReceivedAt: null }, evidence: null }),
    );
    expect(await screen.findByText('no evidence yet · 2 observations')).toBeOnTheScreen();
    scope.end();
  });

  it('renders nothing, and never asks for evidence, in a world without operator tools', async () => {
    const { paths, scope } = await mount('live', () => json(200, evidence));
    await waitFor(() => expect(paths).toContain('/health'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId('ks-dev-evidence')).toBeNull();
    expect(paths.some((path) => path.includes('/diagnostics/'))).toBe(false);
    scope.end();
  });

  it('shows the route as not available when the API answers 404 for it', async () => {
    const { scope } = await mount('stage', () =>
      json(
        404,
        { type: 'tag:knowscroll.space,2026:problem:not-found', title: 'Not found.', status: 404, code: 'NOT_FOUND' },
        'application/problem+json',
      ),
    );
    expect(await screen.findByText('not available here')).toBeOnTheScreen();
    scope.end();
  });
});
