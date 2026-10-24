import { fireEvent, render, screen } from '@testing-library/react-native';
import { DisplayProvider } from '@knowscroll/ui';
import { unavailableCopy } from '../requests/request-copy';
import type { RequestState } from '../requests/request-session';
import { EncounterNotices } from './encounter-notices';
import type { EncounterEntry } from './encounter-history';
import type { EncounterSession, EncounterState } from './encounter-session';

// The notice over a stand-in request store: what each request state says, and that putting a notice
// away is kept with the request, so a remount of the encounter never brings it back.
const EXPOSURE = '0199a000-0000-7000-8000-0000000000e1';
const REQUEST = '0199a000-0000-7000-8000-0000000000f1';

function fixture(patch: Partial<RequestState>) {
  const state: RequestState = {
    phase: 'accepted',
    mode: 'scroll',
    text: '',
    format: 'either',
    about: false,
    source: { exposureId: EXPOSURE, assetId: REQUEST, assetRevision: 1 },
    receipt: { requestId: REQUEST } as RequestState['receipt'],
    ...patch,
  };
  const dismissNotice = jest.fn();
  const requests = { subscribe: () => () => undefined, getState: () => state, dismissNotice, cancel: jest.fn() };
  // Nothing was marked "Not interested": that notice has its own tests.
  const idle = { notInterested: { status: 'idle' }, queued: 0 };
  const feedback = { subscribe: () => () => undefined, getState: () => idle };
  const session = {
    requests,
    feedback,
    openReadyRequest: jest.fn(),
    undoNotInterested: jest.fn(),
    retryNotInterested: jest.fn(),
  } as unknown as EncounterSession;
  const entry = { exposureId: EXPOSURE, kind: 'reel' } as unknown as EncounterEntry;
  return { session, entry, dismissNotice };
}
const show = (f: ReturnType<typeof fixture>) =>
  render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <EncounterNotices entry={f.entry} state={{ phase: 'active' } as EncounterState} session={f.session} />
    </DisplayProvider>,
  );

describe('request notices over an encounter', () => {
  it('says plainly when a request is closed as unavailable, and lets the person put it away', async () => {
    const f = fixture({ status: { status: 'unavailable', reason: 'no_compatible_supply' } as RequestState['status'] });
    await show(f);
    expect(screen.getByText(unavailableCopy.no_compatible_supply)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Dismiss' }));
    expect(f.dismissNotice).toHaveBeenCalledTimes(1);
  });

  it('keeps a dismissed unavailable or ready notice away after the encounter remounts', async () => {
    const closed = fixture({
      status: { status: 'unavailable', reason: 'no_compatible_supply' } as RequestState['status'],
      dismissedRequestId: REQUEST,
    });
    const view = await show(closed);
    expect(screen.queryByText(unavailableCopy.no_compatible_supply)).toBeNull();
    await view.unmount();
    const ready = fixture({
      status: {
        status: 'ready',
        content: { metadata: { title: 'Why long prompts cost more' } },
      } as RequestState['status'],
      dismissedRequestId: REQUEST,
    });
    await show(ready);
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
  });

  it('offers Later and Open for a ready request, and Later is kept with the request', async () => {
    const f = fixture({
      status: {
        status: 'ready',
        content: { metadata: { title: 'Why long prompts cost more' } },
      } as RequestState['status'],
    });
    await show(f);
    expect(screen.getByText(/Ready: your Scroll of “Why long prompts cost more”/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Later' }));
    expect(f.dismissNotice).toHaveBeenCalledTimes(1);
  });

  it('says the Scroll is the one that was asked for, only on that encounter', async () => {
    const f = fixture({ status: undefined });
    const entry = { ...f.entry, offer: { assetId: REQUEST } } as unknown as EncounterEntry;
    const state = { phase: 'active', askedFor: { assetId: REQUEST, kind: 'scroll' } } as EncounterState;
    const view = await render(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <EncounterNotices entry={entry} state={state} session={f.session} />
      </DisplayProvider>,
    );
    expect(screen.getByText('Ready — the Scroll you asked for')).toBeOnTheScreen();
    await view.unmount();
    const other = { ...f.entry, offer: { assetId: 'another-asset' } } as unknown as EncounterEntry;
    await render(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <EncounterNotices entry={other} state={state} session={f.session} />
      </DisplayProvider>,
    );
    expect(screen.queryByText('Ready — the Scroll you asked for')).toBeNull();
  });
});
