/**
 * Browser Back with an overlay open closes the overlay only (N01, ruling on #255), in jsdom
 * (jest-expo/web). Real-browser behaviour is also covered by the Playwright smoke.
 */
import { act } from 'react';
import { createRoot, type Root } from 'test-renderer';
import { useOverlayHistory } from './overlay-history';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  useOverlayHistory(visible, onClose);
  return null;
}

/** jsdom dispatches `popstate` after a task, like browsers. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

let root: Root;

beforeEach(() => {
  root = createRoot();
  window.history.replaceState({ route: 'gallery' }, '', '/gallery');
});

afterEach(async () => {
  act(() => root.unmount());
  await act(settle);
});

describe('useOverlayHistory (web)', () => {
  it('adds one transient entry for the same address while the overlay is open', () => {
    const before = window.history.length;
    act(() => root.render(<Probe visible onClose={() => undefined} />));
    expect(window.history.length).toBe(before + 1);
    expect(window.location.pathname).toBe('/gallery');
    expect(window.history.state).toMatchObject({ route: 'gallery' });
  });

  it('closes the overlay on browser Back and stays on the same address', async () => {
    const onClose = jest.fn();
    act(() => root.render(<Probe visible onClose={onClose} />));

    window.history.back();
    await act(settle);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe('/gallery');
    expect(window.history.state).toEqual({ route: 'gallery' });
  });

  it('removes its entry when the overlay closes another way (Esc, Close, scrim)', async () => {
    const onClose = jest.fn();
    act(() => root.render(<Probe visible onClose={onClose} />));
    act(() => root.render(<Probe visible={false} onClose={onClose} />));
    await act(settle);

    expect(window.history.state).toEqual({ route: 'gallery' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
