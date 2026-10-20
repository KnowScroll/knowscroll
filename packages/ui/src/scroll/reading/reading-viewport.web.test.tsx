/**
 * Web measurement of what the reader sees (jest-expo/web, jsdom): a block's element is observed
 * with IntersectionObserver and its ratio reaches the observer by the same rule as native. The
 * browser's own IntersectionObserver is covered by the Playwright smoke over the gallery export.
 */
import { act } from 'react';
import { createRoot, type Root } from 'test-renderer';
import type { ScrollReadingObserver } from '../observer';
import { useBlockReading, useReadingViewport } from './reading-viewport';
import type { BlockReadingProps } from './types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const anyNumber = expect.any(Number) as number;

interface Entry {
  target: unknown;
  intersectionRatio: number;
}

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly observed = new Set<unknown>();
  constructor(
    readonly callback: (entries: Entry[]) => void,
    readonly options: { threshold: number[]; rootMargin: string },
  ) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe(element: unknown) {
    this.observed.add(element);
  }
  unobserve(element: unknown) {
    this.observed.delete(element);
  }
  disconnect() {
    this.observed.clear();
  }
}

function Probe({
  observer,
  onProps,
}: {
  observer: ScrollReadingObserver;
  onProps: (props: BlockReadingProps) => void;
}) {
  const viewport = useReadingViewport(observer, { top: 0, bottom: 20 });
  onProps(useBlockReading(viewport, 'chart-1'));
  return null;
}

function observerDouble() {
  return {
    onBlockVisibility: jest.fn(),
    onBlockInteraction: jest.fn(),
    onActivity: jest.fn(),
  } satisfies ScrollReadingObserver;
}

let root: Root;

beforeEach(() => {
  FakeIntersectionObserver.instances = [];
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIntersectionObserver;
  root = createRoot();
});

afterEach(() => {
  act(() => root.unmount());
  delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
});

describe('the web reading viewport', () => {
  it('observes a block element in tenths, with the screen chrome taken off the reading area', () => {
    const watcher = observerDouble();
    let props: BlockReadingProps = {};
    act(() => root.render(<Probe observer={watcher} onProps={(next) => (props = next)} />));
    const element = {};

    props.ref?.(element as never);

    const [io] = FakeIntersectionObserver.instances;
    expect(FakeIntersectionObserver.instances).toHaveLength(1);
    expect(io?.observed.has(element)).toBe(true);
    expect(io?.options.threshold).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]);
    expect(io?.options.rootMargin).toBe('0px 0px -20px 0px');
  });

  it('reports mount as 0, then the ratio by the observer rule, and 0 again when the block unmounts', () => {
    const watcher = observerDouble();
    let props: BlockReadingProps = {};
    act(() => root.render(<Probe observer={watcher} onProps={(next) => (props = next)} />));
    const element = {};
    props.ref?.(element as never);
    const [io] = FakeIntersectionObserver.instances;

    io?.callback([{ target: element, intersectionRatio: 0.6 }]);
    io?.callback([{ target: element, intersectionRatio: 0.65 }]);
    io?.callback([{ target: element, intersectionRatio: 1 }]);
    act(() => root.unmount());

    const fractions = watcher.onBlockVisibility.mock.calls.map(
      ([event]: [{ visibleFraction: number }]) => event.visibleFraction,
    );
    expect(fractions).toEqual([0, 0.6, 1, 0]);
    expect(watcher.onBlockVisibility).toHaveBeenCalledWith({
      blockId: 'chart-1',
      visibleFraction: 1,
      at: anyNumber,
    });
    root = createRoot();
  });

  it('stops observing an element that is detached', () => {
    const watcher = observerDouble();
    let props: BlockReadingProps = {};
    act(() => root.render(<Probe observer={watcher} onProps={(next) => (props = next)} />));
    const element = {};
    props.ref?.(element as never);

    props.ref?.(null);

    expect(FakeIntersectionObserver.instances[0]?.observed.has(element)).toBe(false);
  });

  it('is silent, not broken, where IntersectionObserver does not exist', () => {
    delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    const watcher = observerDouble();
    let props: BlockReadingProps = {};
    act(() => root.render(<Probe observer={watcher} onProps={(next) => (props = next)} />));

    expect(() => props.ref?.({} as never)).not.toThrow();
    expect(watcher.onBlockVisibility).toHaveBeenCalledWith({
      blockId: 'chart-1',
      visibleFraction: 0,
      at: anyNumber,
    });
  });
});
