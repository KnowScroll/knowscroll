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

/** Await the real history task; elapsed wall time does not prove traversal completed. */
function afterPopState(action: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      window.removeEventListener('popstate', onPopState);
    };
    const onPopState = () => {
      cleanup();
      resolve();
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('History traversal did not dispatch popstate'));
    }, 2000);
    window.addEventListener('popstate', onPopState);
    try {
      action();
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error('History action failed'));
    }
  });
}

let root: Root;

beforeEach(() => {
  root = createRoot();
  window.history.replaceState({ route: 'gallery' }, '', '/gallery');
});

afterEach(async () => {
  const state: unknown = window.history.state;
  if (typeof state === 'object' && state !== null && '__ksOverlay' in state) {
    const popped = afterPopState(() => act(() => root.unmount()));
    await act(() => popped);
  } else {
    act(() => root.unmount());
  }
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

    await act(() => afterPopState(() => window.history.back()));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe('/gallery');
    expect(window.history.state).toEqual({ route: 'gallery' });
  });

  it('removes its entry when the overlay closes another way (Esc, Close, scrim)', async () => {
    const onClose = jest.fn();
    act(() => root.render(<Probe visible onClose={onClose} />));
    const popped = afterPopState(() => act(() => root.render(<Probe visible={false} onClose={onClose} />)));
    await act(() => popped);

    expect(window.history.state).toEqual({ route: 'gallery' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
