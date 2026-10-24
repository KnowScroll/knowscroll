import { QueryClient } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { createApiClient, type AccountScope, type FeedbackTarget } from '@knowscroll/client-core';
import { problemDetails, type ProblemCode } from '@knowscroll/contracts';
import { DisplayProvider } from '@knowscroll/ui';
import { FeedbackContent } from './feedback-content';

jest.mock('../../platform/command-id', () => ({
  newCommandId: () => jest.requireActual<{ randomUUID: () => string }>('node:crypto').randomUUID(),
}));

const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const reel: FeedbackTarget = {
  kind: 'asset',
  assetId: id(1),
  assetRevision: 2,
  title: 'Attention, explained with a crowded sentence',
  format: 'reel',
  anchor: { kind: 'reel', positionMs: 31_000 },
};
const kiran = { personId: id(5), displayName: 'Kiran', handle: 'kiran.dev' };
const receipt = (commandId: string) => ({
  commandId,
  reportId: id(7),
  receivedAt: new Date().toISOString(),
  replayed: false,
});
/** What the API client throws for a problem answer: the real error, made by answering a request with it. */
async function refusal(code: ProblemCode): Promise<unknown> {
  const details = problemDetails(code);
  const api = createApiClient({
    baseUrl: 'https://app.fixture.test',
    fetch: () =>
      Promise.resolve(
        new Response(JSON.stringify(details), {
          status: details.status,
          headers: { 'content-type': 'application/problem+json' },
        }),
      ),
  });
  return api.feedback
    .reportAbuse({ commandId: id(0), category: 'spam', target: { kind: 'person', personId: id(5) } })
    .then(
      () => {
        throw new Error('the fixture answer was not a problem');
      },
      (error: unknown) => error,
    );
}

/** The scopes a test made, ended after it so a report kept for a connection stops retrying. */
const ending: (() => void)[] = [];
afterEach(() => {
  for (const end of ending.splice(0)) end();
});

function setup(api: Partial<Record<'reportAbuse' | 'reportContentError', jest.Mock>> = {}) {
  const feedback = {
    reportAbuse: jest.fn((input: { commandId: string }) => Promise.resolve(receipt(input.commandId))),
    reportContentError: jest.fn((input: { commandId: string }) => Promise.resolve(receipt(input.commandId))),
    ...api,
  };
  const stored = new Map<string, string>();
  const listeners: (() => void)[] = [];
  const scope = {
    active: true,
    api: {
      feedback,
      sharing: {
        pair: jest.fn(() => Promise.resolve({ status: 'available', pair: { pairRevision: 1 } })),
        block: jest.fn(() => Promise.resolve({})),
      },
    },
    storage: {
      get: (key: string) => stored.get(key),
      set: (key: string, value: string) => void stored.set(key, value),
      remove: (key: string) => void stored.delete(key),
    },
    queryClient: new QueryClient(),
    queryKey: (...parts: readonly (string | number)[]) => ['scope', 'test', ...parts],
    onEnd: (listener: () => void) => {
      listeners.push(listener);
      return () => undefined;
    },
  } as unknown as AccountScope;
  ending.push(() => {
    (scope as { active: boolean }).active = false;
    for (const listener of listeners) listener();
    // A cached query holds a garbage-collection timer that would keep the test process alive.
    scope.queryClient.clear();
  });
  return { scope, feedback, stored };
}

async function show(
  scope: AccountScope,
  target: FeedbackTarget,
  start: 'menu' | 'content_error' | 'abuse',
  extra: { onNotInterested?: () => Promise<boolean> } = {},
) {
  const onClose = jest.fn();
  await render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <FeedbackContent scope={scope} target={target} start={start} onClose={onClose} {...extra} />
    </DisplayProvider>,
  );
  return { onClose };
}

describe('the menu', () => {
  it('names what it is about and offers Not interested, a content error and abuse, with Cancel', async () => {
    const { scope } = setup();
    const onNotInterested = jest.fn(() => Promise.resolve(true));
    const { onClose } = await show(scope, reel, 'menu', { onNotInterested });
    expect(screen.getByText('Attention, explained with a crowded sentence')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Not interested. Fewer like this one' }));
    expect(onNotInterested).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole('button', { name: 'Report a content error. Something here seems wrong' }),
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Report abuse' })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('leaves Not interested out where the screen cannot move on to the next subject', async () => {
    const { scope } = setup();
    await show(scope, reel, 'menu');
    expect(screen.queryByTestId('feedback-not-interested')).toBeNull();
  });

  it('keeps a failed save in the menu with a Retry, and nothing seems saved', async () => {
    const { scope } = setup();
    const onNotInterested = jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await show(scope, reel, 'menu', { onNotInterested });
    await fireEvent.press(screen.getByTestId('feedback-not-interested'));
    expect(await screen.findByLabelText('Couldn’t save that. Nothing changed. Try again.')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(onNotInterested).toHaveBeenCalledTimes(2));
    expect(screen.queryByLabelText('Couldn’t save that. Nothing changed. Try again.')).toBeNull();
  });
});

describe('the content error form', () => {
  it('starts on "Something’s wrong", shows the moment, and sends with the optional note', async () => {
    const { scope, feedback } = setup();
    await show(scope, reel, 'menu');
    await fireEvent.press(screen.getByTestId('feedback-content-error'));
    expect(screen.getByText('Report an error')).toBeOnTheScreen();
    expect(screen.getByRole('radio', { name: 'Something’s wrong' })).toBeChecked();
    expect(screen.getByText('At 0:31')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('radio', { name: 'Misleading' }));
    await fireEvent.changeText(screen.getByTestId('feedback-note'), '“it” could also mean the street here?');
    await fireEvent.press(screen.getByTestId('feedback-send'));
    await waitFor(() => expect(feedback.reportContentError).toHaveBeenCalledTimes(1));
    expect(feedback.reportContentError.mock.calls[0]![0]).toMatchObject({
      target: { assetId: id(1), assetRevision: 2 },
      category: 'misleading',
      anchor: { kind: 'reel', positionMs: 31_000 },
      note: '“it” could also mean the street here?',
    });
    expect(await screen.findByText('Report received')).toBeOnTheScreen();
    expect(screen.getByText('Thanks — if we correct it you’ll see a Corrected tag.')).toBeOnTheScreen();
  });

  it('lets the person leave the moment out, and goes back to the menu', async () => {
    const { scope, feedback } = setup();
    await show(scope, reel, 'menu');
    await fireEvent.press(screen.getByTestId('feedback-content-error'));
    await fireEvent.press(screen.getByRole('button', { name: 'Leave out the moment' }));
    expect(screen.getByText('The whole thing')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('feedback-send'));
    await waitFor(() => expect(feedback.reportContentError).toHaveBeenCalledTimes(1));
    expect(feedback.reportContentError.mock.calls[0]![0]).not.toHaveProperty('anchor');
  });

  it('goes back from a form to the menu', async () => {
    const { scope } = setup();
    await show(scope, reel, 'menu');
    await fireEvent.press(screen.getByTestId('feedback-abuse'));
    await fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByTestId('feedback-content-error')).toBeOnTheScreen();
  });
});

describe('the abuse form', () => {
  const message: FeedbackTarget = { kind: 'message', messageId: id(3), author: kiran };

  it('cannot be sent until a reason is picked, then sends and shows the receipt with Also block', async () => {
    const { scope, feedback } = setup();
    await show(scope, message, 'abuse');
    expect(screen.getByText('Report abuse')).toBeOnTheScreen();
    expect(screen.getByText('About Kiran’s message. They won’t be told.')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Send report' })).toBeDisabled();
    await fireEvent.press(screen.getByRole('radio', { name: 'Harassment' }));
    await fireEvent.press(screen.getByTestId('feedback-send'));
    await waitFor(() => expect(feedback.reportAbuse).toHaveBeenCalledTimes(1));
    expect(feedback.reportAbuse.mock.calls[0]![0]).toMatchObject({
      target: { kind: 'message', messageId: id(3) },
      category: 'harassment',
    });
    expect(await screen.findByText('Report received')).toBeOnTheScreen();
    expect(screen.getByText('Our safety team will review it. You don’t need to do anything else.')).toBeOnTheScreen();
    // The receipt names the reason and the kind of thing, never the person.
    expect(screen.getByText(/^Reason: Harassment · a message · today \d\d:\d\d$/)).toBeOnTheScreen();
    expect(screen.queryByText(/Kiran/, { exact: false })).toBeNull();
    expect(screen.getByRole('button', { name: 'Also block @kiran.dev' })).toBeOnTheScreen();
  });

  it('blocks on request and says so, without telling anyone', async () => {
    const { scope } = setup();
    await show(scope, message, 'abuse');
    await fireEvent.press(screen.getByRole('radio', { name: 'Spam' }));
    await fireEvent.press(screen.getByTestId('feedback-send'));
    await fireEvent.press(await screen.findByTestId('feedback-block'));
    expect(await screen.findByText('You blocked Kiran. They aren’t told.')).toBeOnTheScreen();
  });

  it('tells the moderators of a room that they can see a room message report', async () => {
    const { scope } = setup();
    await show(scope, { kind: 'room_message', messageId: id(4) }, 'abuse');
    await fireEvent.press(screen.getByRole('radio', { name: 'Hate' }));
    await fireEvent.press(screen.getByTestId('feedback-send'));
    expect(
      await screen.findByText(
        'Our safety team will review it. The moderators of the room can see it too. You don’t need to do anything else.',
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByTestId('feedback-block')).toBeNull();
  });
});

describe('sending', () => {
  it('shows sending while the report is on its way', async () => {
    let finish: () => void = () => undefined;
    const { scope } = setup({
      reportAbuse: jest.fn(
        (input: { commandId: string }) => new Promise((resolve) => (finish = () => resolve(receipt(input.commandId)))),
      ),
    });
    await show(scope, { kind: 'person', person: kiran }, 'abuse');
    await fireEvent.press(screen.getByRole('radio', { name: 'Harassment' }));
    await fireEvent.press(screen.getByTestId('feedback-send'));
    expect(await screen.findByRole('button', { name: 'Sending…' })).toBeOnTheScreen();
    finish();
    expect(await screen.findByText('Report received')).toBeOnTheScreen();
  });

  it('says "Will send when online" when there is no answer, and keeps the report on the device', async () => {
    const { scope, stored } = setup({ reportAbuse: jest.fn(() => Promise.reject(new TypeError('Failed to fetch'))) });
    await show(scope, { kind: 'person', person: kiran }, 'abuse');
    await fireEvent.press(screen.getByRole('radio', { name: 'Harassment' }));
    await fireEvent.press(screen.getByTestId('feedback-send'));
    expect(await screen.findByLabelText(/^Will send when online\./)).toBeOnTheScreen();
    expect(stored.get('feedback.reports.v1')).toContain('harassment');
  });

  it('fails with a Retry that sends the same report again, and an edit starts a new one', async () => {
    const reportAbuse = jest
      .fn()
      .mockRejectedValueOnce(await refusal('SERVICE_UNAVAILABLE'))
      .mockRejectedValueOnce(await refusal('SERVICE_UNAVAILABLE'))
      .mockImplementation((input: { commandId: string }) => Promise.resolve(receipt(input.commandId)));
    const { scope } = setup({ reportAbuse });
    await show(scope, { kind: 'person', person: kiran }, 'abuse');
    await fireEvent.press(screen.getByRole('radio', { name: 'Harassment' }));
    await fireEvent.press(screen.getByTestId('feedback-send'));
    expect(await screen.findByLabelText('Couldn’t send. Nothing was lost. Try again.')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(reportAbuse).toHaveBeenCalledTimes(2));
    expect(reportAbuse.mock.calls[1]![0].commandId).toBe(reportAbuse.mock.calls[0]![0].commandId);
    // Changing the form after a failure is a different report.
    await fireEvent.changeText(await screen.findByTestId('feedback-note'), 'It happened again');
    await fireEvent.press(screen.getByTestId('feedback-send'));
    await waitFor(() => expect(reportAbuse).toHaveBeenCalledTimes(3));
    expect(reportAbuse.mock.calls[2]![0].commandId).not.toBe(reportAbuse.mock.calls[0]![0].commandId);
    expect(await screen.findByText('Report received')).toBeOnTheScreen();
  });

  it('says plainly when it is too much for today, or no longer available, with no Retry', async () => {
    for (const [code, words] of [
      ['TOO_MANY_REQUESTS', 'Too many reports today. Try again tomorrow.'],
      ['NOT_FOUND', 'Can’t report this. It isn’t available any more.'],
    ] as const) {
      const error = await refusal(code);
      const { scope } = setup({ reportAbuse: jest.fn(() => Promise.reject(error)) });
      const view = await render(
        <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
          <FeedbackContent scope={scope} target={{ kind: 'person', person: kiran }} start="abuse" onClose={jest.fn()} />
        </DisplayProvider>,
      );
      await fireEvent.press(screen.getByRole('radio', { name: 'Spam' }));
      await fireEvent.press(screen.getByTestId('feedback-send'));
      expect(await screen.findByLabelText(words)).toBeOnTheScreen();
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
      await view.unmount();
    }
  });
});
