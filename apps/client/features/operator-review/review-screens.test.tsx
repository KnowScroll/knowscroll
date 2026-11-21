import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { createAccountScope, memoryStore, type AccountScope } from '@knowscroll/client-core';
import { DisplayProvider } from '@knowscroll/ui';
import { FIXTURE_ASSET, OTHER_ASSET, fixtureListItem, fixtureShow } from './review-fixtures';
import { ReviewList } from './review-list-screen';
import { ReviewScroll } from './review-scroll-screen';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => false) };
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockParams,
}));

/**
 * The review screens over a labelled fixture `fetch`: no network, no API. The answers are authored examples of what the contract
 * allows, built from the CI Broad Street document, not records of any system.
 */
const account = {
  accountId: '0199a000-0000-7000-8000-00000000000a',
  universeId: '0199a000-0000-7000-8000-0000000000aa',
  privacyEpoch: 1,
  email: 'a@operator.test',
};
const problem = (code: string, status: number) => ({
  type: `tag:knowscroll,2026:problem:${code}`,
  title: code,
  status,
  code,
});

function json(status: number, body: unknown, type = 'application/json'): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });
}
const notFound = () => json(404, problem('NOT_FOUND', 404), 'application/problem+json');

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

async function mount(
  answer: (request: Sent) => Response,
  screen: (scope: AccountScope) => React.ReactNode,
): Promise<{ readonly sent: Sent[] }> {
  const sent: Sent[] = [];
  const scope: AccountScope = createAccountScope({
    account,
    baseUrl: 'https://app.operator.test',
    fetch: async (request: Request) => {
      const text = request.method === 'GET' ? '' : await request.clone().text();
      const entry = {
        method: request.method,
        path: new URL(request.url).pathname,
        body: text === '' ? undefined : (JSON.parse(text) as unknown),
      };
      sent.push(entry);
      return answer(entry);
    },
    authorization: () => undefined,
    store: memoryStore(),
  });
  await render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <QueryClientProvider client={scope.queryClient}>{screen(scope)}</QueryClientProvider>
    </DisplayProvider>,
  );
  return { sent };
}

const listPath = '/v1/operator/review';
const showPath = `/v1/operator/review/${FIXTURE_ASSET}/1`;

beforeEach(() => {
  mockRouter.push.mockClear();
  mockRouter.replace.mockClear();
  mockParams = { assetId: FIXTURE_ASSET, revision: '1' };
});

describe('the held Scrolls list', () => {
  it('shows each held revision with what the checks said in words, and opens one at its address', async () => {
    const items = [
      fixtureListItem(),
      fixtureListItem({
        assetId: OTHER_ASSET,
        title: 'A second Scroll',
        supportCheck: null,
        coverage: 'unmapped',
        topic: null,
      }),
    ];
    await mount(
      (request) => (request.path === listPath ? json(200, { revisions: items }) : notFound()),
      (scope) => <ReviewList scope={scope} />,
    );
    expect(await screen.findByText('The pump on Broad Street')).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Held Scrolls' })).toBeOnTheScreen();
    expect(screen.getByText('Support: flagged')).toBeOnTheScreen();
    expect(screen.getByText('Support: not run')).toBeOnTheScreen();
    expect(screen.getByText('Coverage: not mapped')).toBeOnTheScreen();
    expect(
      screen.getByText(/revision 1 · 3 min · earth.cholera · broad-street · held 2026-11-21 09:30 UTC/),
    ).toBeOnTheScreen();
    expect(screen.getByText(/no topic yet/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId(`review-row-${OTHER_ASSET}`));
    expect(mockRouter.push).toHaveBeenCalledWith(`/operator/review/${OTHER_ASSET}/1`);
  });

  it('says plainly that nothing is waiting', async () => {
    await mount(
      () => json(200, { revisions: [] }),
      (scope) => <ReviewList scope={scope} />,
    );
    expect(await screen.findByText('Nothing is waiting')).toBeOnTheScreen();
  });

  it('says it could not read the list, changes nothing, and reads again on request', async () => {
    let fail = true;
    const { sent } = await mount(
      () =>
        fail
          ? json(503, problem('SERVICE_UNAVAILABLE', 503), 'application/problem+json')
          : json(200, { revisions: [] }),
      (scope) => <ReviewList scope={scope} />,
    );
    expect(await screen.findByText('Could not read the list', undefined, { timeout: 12_000 })).toBeOnTheScreen();
    fail = false;
    const before = sent.length;
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Nothing is waiting')).toBeOnTheScreen();
    expect(sent.length).toBeGreaterThan(before);
  }, 20_000);

  it('shows an account that is not an operator the same page as an unknown address', async () => {
    await mount(
      () => notFound(),
      (scope) => <ReviewList scope={scope} />,
    );
    expect(await screen.findByText("This page isn't here")).toBeOnTheScreen();
    expect(screen.queryByText('Held Scrolls')).toBeNull();
  });
});

describe('one held Scroll', () => {
  const answers =
    (overrides: { show?: () => Response; onPost?: (request: Sent) => Response } = {}) =>
    (request: Sent) => {
      if (request.path === listPath)
        return json(200, {
          revisions: [fixtureListItem(), fixtureListItem({ assetId: OTHER_ASSET, title: 'A second Scroll' })],
        });
      if (request.path === showPath && request.method === 'GET') return overrides.show?.() ?? json(200, fixtureShow());
      if (request.method === 'POST' && overrides.onPost !== undefined) return overrides.onPost(request);
      return notFound();
    };
  const open = (override?: Parameters<typeof answers>[0]) =>
    mount(answers(override), (scope) => <ReviewScroll scope={scope} />);
  /** A test renderer has no layout: gives the stage the room a phone's screen leaves it. */
  const layOut = async () => {
    await fireEvent(await screen.findByTestId('review-stage'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 600 } },
    });
  };

  it('draws the cover first, with the checks in words above it and its place in the hand of held Scrolls', async () => {
    await open();
    await layOut();
    expect(await screen.findByTestId('essay-cover')).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'The pump on Broad Street' })).toBeOnTheScreen();
    expect(screen.getByText('1 OF 2')).toBeOnTheScreen();
    // Folded to chips on a phone, so the cover keeps its picture; unfolded they are in words.
    expect(screen.getByText('Support: flagged')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('review-findings-toggle'));
    expect(screen.getByText(/Support check: flagged\. 40 sentences/)).toBeOnTheScreen();
    expect(screen.getByText('Sentences to read first')).toBeOnTheScreen();
    expect(
      screen.getByText(/Five hundred people died in ten days\. — The passages give a smaller count\./),
    ).toBeOnTheScreen();
    expect(screen.getByText(/NEXT/)).toBeOnTheScreen();
  });

  it('opens the essay on Read, folds the checks to a line and shows no sources until asked', async () => {
    await open();
    await layOut();
    await fireEvent.press(await screen.findByTestId('essay-cover-read'));
    expect(await screen.findByTestId('folio-scroller')).toBeOnTheScreen();
    expect(screen.queryByTestId('essay-cover')).toBeNull();
    expect(screen.queryByText('Sentences to read first')).toBeNull();
    expect(screen.queryByTestId('review-sources-b1')).toBeNull();
    await fireEvent.press(screen.getByTestId('review-sources-toggle'));
    expect(await screen.findByTestId('review-sources-b1')).toBeOnTheScreen();
    expect(screen.getByText(/The first cases came on the last night of August\./)).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('review-sources-toggle'));
    await waitFor(() => expect(screen.queryByTestId('review-sources-b1')).toBeNull());
  });

  it('shows an account that is not an operator, or a revision that is not held, the unknown-page screen', async () => {
    await open({ show: notFound });
    expect(await screen.findByText("This page isn't here")).toBeOnTheScreen();
  });

  it('says it could not read the Scroll when the server fails, with a way to try again', async () => {
    await open({ show: () => json(503, problem('SERVICE_UNAVAILABLE', 503), 'application/problem+json') });
    expect(await screen.findByText('Could not read this Scroll', undefined, { timeout: 12_000 })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
  }, 20_000);

  it('says a stored document it cannot draw is unreadable instead of drawing part of it', async () => {
    await open({ show: () => json(200, fixtureShow({ document: { schemaVersion: 'scroll-document.v9' } as never })) });
    expect(await screen.findByText('This revision cannot be read')).toBeOnTheScreen();
  });

  it('shows an address that is not a held revision the unknown-page screen without asking the server', async () => {
    mockParams = { assetId: 'not-an-asset', revision: '1' };
    const { sent } = await open();
    expect(await screen.findByText("This page isn't here")).toBeOnTheScreen();
    expect(sent.filter((request) => request.path.startsWith(`${listPath}/`))).toEqual([]);
  });

  describe('deciding', () => {
    const released = { outcome: 'released', reason: null, replacedRevision: null };
    /** Opens the essay and finds the decision panel at its end. */
    const toDecision = async (override?: Parameters<typeof answers>[0]) => {
      const mounted = await open(override);
      await layOut();
      await fireEvent.press(await screen.findByTestId('essay-cover-read'));
      expect(await screen.findByTestId('review-decision')).toBeOnTheScreen();
      return mounted;
    };

    it('asks in the page before it releases, sends nothing until confirmed, then returns to the list', async () => {
      // A browser dialog would answer yes: it must never be asked.
      const confirm = jest.fn(() => true);
      Object.assign(globalThis, { confirm });
      const { sent } = await toDecision({ onPost: () => json(200, released) });
      await fireEvent.press(screen.getByTestId('review-release'));
      expect(screen.getByTestId('review-confirm-release')).toBeOnTheScreen();
      await fireEvent.press(screen.getByRole('button', { name: 'Not yet' }));
      expect(screen.queryByTestId('review-confirm-release')).toBeNull();
      expect(sent.filter((request) => request.method === 'POST')).toEqual([]);
      await fireEvent.press(screen.getByTestId('review-release'));
      await fireEvent.press(screen.getByTestId('review-release-confirm'));
      await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/operator/review'));
      expect(sent.filter((request) => request.method === 'POST').map((request) => request.path)).toEqual([
        `${showPath}/release`,
      ]);
      expect(confirm).not.toHaveBeenCalled();
      Reflect.deleteProperty(globalThis, 'confirm');
    });

    it('needs a reason to reject, sends it with the decision, then returns to the list', async () => {
      const { sent } = await toDecision({ onPost: () => json(200, { outcome: 'rejected', reason: null }) });
      await fireEvent.press(screen.getByTestId('review-reject'));
      expect(screen.getByTestId('review-reject-confirm')).toBeDisabled();
      await fireEvent.changeText(screen.getByTestId('review-reject-reason'), '   ');
      expect(screen.getByTestId('review-reject-confirm')).toBeDisabled();
      await fireEvent.changeText(screen.getByTestId('review-reject-reason'), 'The second picture says the opposite.');
      await fireEvent.press(screen.getByTestId('review-reject-confirm'));
      await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/operator/review'));
      const post = sent.find((request) => request.method === 'POST');
      expect(post).toMatchObject({
        path: `${showPath}/reject`,
        body: { reason: 'The second picture says the opposite.' },
      });
    });

    it('says why the gate refused a release, stays on the page and does not leave', async () => {
      await toDecision({
        onPost: () => json(200, { outcome: 'refused', reason: 'coverage_missing', replacedRevision: null }),
      });
      await fireEvent.press(screen.getByTestId('review-release'));
      await fireEvent.press(screen.getByTestId('review-release-confirm'));
      expect(await screen.findByTestId('review-refused')).toBeOnTheScreen();
      expect(screen.getByText(/its coverage is not mapped/)).toBeOnTheScreen();
      expect(mockRouter.replace).not.toHaveBeenCalledWith('/operator/review');
      expect(screen.getByTestId('review-release')).toBeOnTheScreen();
    });

    it('says a revision that was decided meanwhile is not held any more, and offers the list', async () => {
      await toDecision({ onPost: () => notFound() });
      await fireEvent.press(screen.getByTestId('review-release'));
      await fireEvent.press(screen.getByTestId('review-release-confirm'));
      expect(await screen.findByTestId('review-gone')).toBeOnTheScreen();
      await fireEvent.press(
        within(screen.getByTestId('review-gone')).getByRole('button', { name: 'Back to the list' }),
      );
      expect(mockRouter.replace).toHaveBeenCalledWith('/operator/review');
    });

    it('says it could not send a decision, changes nothing and keeps the buttons', async () => {
      await toDecision({ onPost: () => json(503, problem('SERVICE_UNAVAILABLE', 503), 'application/problem+json') });
      await fireEvent.press(screen.getByTestId('review-release'));
      await fireEvent.press(screen.getByTestId('review-release-confirm'));
      expect(await screen.findByTestId('review-failed')).toBeOnTheScreen();
      expect(screen.getByTestId('review-release')).toBeOnTheScreen();
      expect(mockRouter.replace).not.toHaveBeenCalledWith('/operator/review');
    });
  });
});
