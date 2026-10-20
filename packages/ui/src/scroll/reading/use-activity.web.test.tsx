/**
 * Web: the article is active while the tab is visible and no overlay holds the reader
 * (jest-expo/web, jsdom).
 */
import { act } from 'react';
import { createRoot, type Root } from 'test-renderer';
import type { ScrollReadingObserver } from '../observer';
import { useArticleActivity } from './use-activity';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const anyNumber = expect.any(Number) as number;

function Probe({ observer, paused }: { observer?: ScrollReadingObserver; paused: boolean }) {
  useArticleActivity(observer, paused);
  return null;
}

function observerDouble() {
  return {
    onBlockVisibility: jest.fn(),
    onBlockInteraction: jest.fn(),
    onActivity: jest.fn(),
  } satisfies ScrollReadingObserver;
}

let visibility: 'visible' | 'hidden' = 'visible';
let root: Root;

beforeEach(() => {
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  root = createRoot();
});

afterEach(() => {
  act(() => root.unmount());
});

function changeVisibility(next: 'visible' | 'hidden') {
  visibility = next;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

describe('the web article activity', () => {
  it('is active when it mounts, inactive when the tab is hidden, active when it comes back', () => {
    const watcher = observerDouble();
    act(() => root.render(<Probe observer={watcher} paused={false} />));
    expect(watcher.onActivity).toHaveBeenLastCalledWith({ active: true, at: anyNumber });

    changeVisibility('hidden');
    expect(watcher.onActivity).toHaveBeenLastCalledWith({ active: false, at: anyNumber });

    changeVisibility('visible');
    expect(watcher.onActivity).toHaveBeenLastCalledWith({ active: true, at: anyNumber });
    expect(watcher.onActivity).toHaveBeenCalledTimes(3);
  });

  it('is inactive while an overlay holds the reader, even in a visible tab', () => {
    const watcher = observerDouble();
    act(() => root.render(<Probe observer={watcher} paused={false} />));

    act(() => root.render(<Probe observer={watcher} paused />));
    expect(watcher.onActivity).toHaveBeenLastCalledWith({ active: false, at: anyNumber });

    act(() => root.render(<Probe observer={watcher} paused={false} />));
    expect(watcher.onActivity).toHaveBeenLastCalledWith({ active: true, at: anyNumber });
  });

  it('says nothing twice: a visibility change that changes nothing is not reported', () => {
    const watcher = observerDouble();
    act(() => root.render(<Probe observer={watcher} paused={false} />));

    changeVisibility('visible');

    expect(watcher.onActivity).toHaveBeenCalledTimes(1);
  });

  it('starts a late observer and ends the old observer when replaced', () => {
    const first = observerDouble();
    const next = observerDouble();
    act(() => root.render(<Probe paused={false} />));
    act(() => root.render(<Probe observer={first} paused={false} />));
    expect(first.onActivity).toHaveBeenLastCalledWith({ active: true, at: anyNumber });
    act(() => root.render(<Probe observer={next} paused={false} />));
    expect(first.onActivity).toHaveBeenLastCalledWith({ active: false, at: anyNumber });
    expect(next.onActivity).toHaveBeenLastCalledWith({ active: true, at: anyNumber });
  });

  it('reports inactive when the article unmounts', () => {
    const watcher = observerDouble();
    act(() => root.render(<Probe observer={watcher} paused={false} />));

    act(() => root.unmount());

    expect(watcher.onActivity).toHaveBeenLastCalledWith({ active: false, at: anyNumber });
    root = createRoot();
  });
});
