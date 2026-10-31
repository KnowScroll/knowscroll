import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { DisplayProvider } from '@knowscroll/ui';
import stageDocument from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import type { ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { EncounterOverlay } from '../encounter/encounter-overlay';
import type { OpenedStageScroll } from '../scroll/scroll-session';
import { RequestPanel } from './request-panel';
import { requestHarness } from './request-session.fixture';

/** The labelled CI fixture, opened as the encounter opens a v2 Scroll (never product content). */
const scroll: OpenedStageScroll = {
  exposureId: 'fixture-exposure',
  assetId: 'fixture-asset',
  assetRevision: 2,
  document: stageDocument as unknown as ScrollDocumentV2,
  degradedEssential: [],
};
const questions = (stageDocument as unknown as ScrollDocumentV2).askSuggestions;

function sheet(h: ReturnType<typeof requestHarness>, close: () => void = jest.fn()) {
  h.session.show('ask', { stopId: 'call-delhi' });
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 800 },
        insets: { top: 0, bottom: 0, left: 0, right: 0 },
      }}
    >
      <DisplayProvider value={{ width: 390, textScale: 1 }}>
        <EncounterOverlay label="Ask for something" presentation="sheet" onClose={close}>
          <RequestPanel session={h.session} onClose={close} ask={{ scroll }} />
        </EncounterOverlay>
      </DisplayProvider>
    </SafeAreaProvider>
  );
}
const posts = (h: ReturnType<typeof requestHarness>) => h.calls.filter((call) => call.method === 'POST');

describe('the Ask sheet (D1)', () => {
  it('starts from what the person just read: the Scroll own questions, one editable line, no counter, Send waiting for words', async () => {
    const h = requestHarness();
    const screen = await render(sheet(h));
    try {
      expect(screen.getByRole('header', { name: 'Ask' })).toBeTruthy();
      expect(screen.getByText('FROM WHAT YOU JUST READ')).toBeTruthy();
      for (const question of questions) expect(screen.getByRole('button', { name: `Ask: ${question}` })).toBeTruthy();
      expect(screen.getByText(/A short Scroll · about /)).toBeTruthy();
      expect(screen.queryByText(/\/280/)).toBeNull();
      expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
      // Nothing is asked of the person before they type: no format, no topic, no source to choose.
      expect(screen.queryByRole('radio')).toBeNull();
      expect(posts(h)).toEqual([]);
    } finally {
      await screen.unmount();
      await act(() => h.scope.end());
    }
  });

  it('shows the counter only near the limit', async () => {
    const h = requestHarness();
    const screen = await render(sheet(h));
    try {
      const input = screen.getByLabelText('Ask a question');
      await fireEvent.changeText(input, 'x'.repeat(239));
      expect(screen.queryByText(/\/280/)).toBeNull();
      await fireEvent.changeText(input, 'x'.repeat(240));
      expect(screen.getByText('240/280')).toBeTruthy();
    } finally {
      await screen.unmount();
      await act(() => h.scope.end());
    }
  });

  it('sends a tapped question at once and then says plainly what happens: making it, a card to leave, the way out', async () => {
    const h = requestHarness();
    const close = jest.fn();
    const screen = await render(sheet(h, close));
    try {
      await fireEvent.press(screen.getByRole('button', { name: `Ask: ${questions[0]}` }));
      await waitFor(() => expect(h.session.getState().status?.status).toBe('preparing'));
      expect(posts(h)).toHaveLength(1);
      expect(screen.getByText('Making it now')).toBeTruthy();
      expect(screen.getByText(/ — a short Scroll\./)).toBeTruthy();
      // No time was measured, so none is said.
      expect(screen.queryByText(/usually/)).toBeNull();
      expect(screen.getByText(/you'll see a notice here/)).toBeTruthy();
      await fireEvent.press(screen.getByRole('button', { name: 'Keep reading' }));
      expect(close).toHaveBeenCalledTimes(1);
      // Leaving is not cancelling: the request stands.
      expect(h.calls.filter((call) => call.path.endsWith('/cancel'))).toEqual([]);
    } finally {
      await screen.unmount();
      await act(() => h.scope.end());
    }
  });

  it('says a time only when the server measured one', async () => {
    const h = requestHarness();
    const screen = await render(sheet(h));
    try {
      h.setStatus({ ...h.fields, status: 'preparing', phase: 'preparing', typicalSeconds: 130 });
      await fireEvent.press(screen.getByRole('button', { name: `Ask: ${questions[0]}` }));
      await waitFor(() => expect(h.session.getState().status?.status).toBe('preparing'));
      expect(screen.getByText(/ready, usually about 2 min\./)).toBeTruthy();
    } finally {
      await screen.unmount();
      await act(() => h.scope.end());
    }
  });

  it('shows the ready Scroll with its way in', async () => {
    const h = requestHarness();
    const screen = await render(sheet(h));
    try {
      await fireEvent.changeText(screen.getByLabelText('Ask a question'), 'Why is the far side cold?');
      await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(h.session.getState().status?.status).toBe('preparing'));
      h.setStatus({
        ...h.fields,
        requestRevision: 2,
        status: 'ready',
        content: {
          assetId: 'ask-order-asset',
          assetRevision: 1,
          explanationUnitId: 'fixture-only',
          metadata: { kind: 'scroll', title: 'Why the far side stays cold', summary: 'CI only', language: 'en' },
        },
      });
      await act(() => h.session.refresh());
      expect(screen.getByText('Why the far side stays cold')).toBeTruthy();
      expect(screen.getByText(/made for this question, for you alone/)).toBeTruthy();
      await fireEvent.press(screen.getByRole('button', { name: 'Open your Scroll' }));
      await waitFor(() => expect(h.opens).toEqual([{ kind: 'return', assetId: 'ask-order-asset', assetRevision: 1 }]));
    } finally {
      await screen.unmount();
      await act(() => h.scope.end());
    }
  });

  it('closes honestly: could not prepare offers Try again, and a cap says nothing can be tried', async () => {
    const h = requestHarness();
    const screen = await render(sheet(h));
    try {
      await fireEvent.changeText(screen.getByLabelText('Ask a question'), 'Why is the far side cold?');
      await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(h.session.getState().status?.status).toBe('preparing'));
      h.setStatus({ ...h.fields, requestRevision: 2, status: 'unavailable', reason: 'could_not_prepare' });
      await act(() => h.session.refresh());
      expect(screen.getByText("We couldn't prepare this one")).toBeTruthy();
      await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
      await waitFor(() => expect(screen.getByText('Making it now')).toBeTruthy());
      expect(h.calls.filter((call) => call.path.endsWith('/retry'))).toHaveLength(1);
      expect(posts(h).filter((call) => call.path === '/v1/content/requests')).toHaveLength(1);

      h.setStatus({ ...h.fields, requestRevision: 6, status: 'unavailable', reason: 'budget_unavailable' });
      await act(() => h.session.refresh());
      expect(screen.getByText(/We can't prepare new explanations right now/)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Ask something else' })).toBeTruthy();
    } finally {
      await screen.unmount();
      await act(() => h.scope.end());
    }
  });

  it('turns Change into "something new" and back, and words that are only blanks cannot be sent', async () => {
    const h = requestHarness();
    const screen = await render(sheet(h));
    try {
      await fireEvent.press(screen.getByRole('button', { name: 'Change: ask about something new' }));
      expect(screen.getByText('A short Scroll · about something new')).toBeTruthy();
      expect(screen.queryByText('FROM WHAT YOU JUST READ')).toBeNull();
      await fireEvent.press(screen.getByRole('button', { name: 'Change: ask about this Scroll' }));
      expect(screen.getByText('FROM WHAT YOU JUST READ')).toBeTruthy();
      await fireEvent.changeText(screen.getByLabelText('Ask a question'), '   ');
      expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    } finally {
      await screen.unmount();
      await act(() => h.scope.end());
    }
  });
});
