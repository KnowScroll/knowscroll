/** Web geometry regression: own scroller, tall blocks, resized chrome, observer replacement. */
import { act } from 'react';
import { createRoot, type Root } from 'test-renderer';
import type { ScrollReadingObserver } from '../observer';
import { useBlockReading, useReadingViewport } from './reading-viewport';
import type { ReadingViewport, BlockReadingProps } from './types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly observed = new Set<Element>();
  constructor(
    readonly callback: (entries: IntersectionObserverEntry[]) => void,
    readonly options: IntersectionObserverInit,
  ) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe(element: Element) {
    this.observed.add(element);
  }
  disconnect() {
    this.observed.clear();
  }
  emit(element: Element, visible: number, height: number, reading = 800) {
    this.callback([
      {
        target: element,
        isIntersecting: visible > 0,
        intersectionRect: { height: visible },
        boundingClientRect: { height },
        rootBounds: { height: reading },
      } as IntersectionObserverEntry,
    ]);
  }
}
class FakeResizeObserver {
  static instance: FakeResizeObserver;
  constructor(readonly callback: (entries: ResizeObserverEntry[]) => void) {
    FakeResizeObserver.instance = this;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  emit(element: Element) {
    this.callback([{ target: element } as ResizeObserverEntry]);
  }
}
function Probe({
  observer,
  onProps,
  bottom = 20,
  onViewport,
}: {
  observer?: ScrollReadingObserver;
  onProps: (props: BlockReadingProps) => void;
  bottom?: number;
  onViewport?: (viewport: ReadingViewport) => void;
}) {
  const viewport = useReadingViewport(observer, { top: 0, bottom });
  onViewport?.(viewport);
  onProps(useBlockReading(viewport, 'chart-1'));
  return null;
}
const observerDouble = () => ({ onBlockVisibility: jest.fn(), onBlockInteraction: jest.fn(), onActivity: jest.fn() });
let root: Root;
let scroller: HTMLDivElement;
let element: HTMLDivElement;
let height: number;
beforeEach(() => {
  FakeIntersectionObserver.instances = [];
  Object.assign(globalThis, { IntersectionObserver: FakeIntersectionObserver, ResizeObserver: FakeResizeObserver });
  scroller = document.createElement('div');
  scroller.style.overflowY = 'auto';
  Object.defineProperty(scroller, 'clientHeight', { value: 820 });
  element = document.createElement('div');
  height = 100;
  element.getBoundingClientRect = () => ({ height }) as DOMRect;
  scroller.append(element);
  document.body.append(scroller);
  root = createRoot();
});
afterEach(() => {
  act(() => root.unmount());
  scroller.remove();
  delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
});
function mount(observer?: ScrollReadingObserver) {
  let props: BlockReadingProps = {};
  act(() => root.render(<Probe observer={observer} onProps={(next) => (props = next)} />));
  props.ref?.(element as never);
  return props;
}
describe('the web reading viewport', () => {
  it('roots the observer in the article and excludes its chrome', () => {
    mount(observerDouble());
    const io = FakeIntersectionObserver.instances[0];
    expect(io?.options.root).toBe(scroller);
    expect(io?.options.threshold).toEqual(Array.from({ length: 11 }, (_, i) => i / 10));
    expect(io?.options.rootMargin).toBe('0px 0px -20px 0px');
  });
  it('lets a 2300px block reach 1 in an 800px reading area and rebuilds on resize', () => {
    height = 2300;
    const watcher = observerDouble();
    mount(watcher);
    const io = FakeIntersectionObserver.instances[0];
    expect((io?.options.threshold as number[])[10]).toBeCloseTo(800 / 2300);
    io?.emit(element, 800, 2300);
    expect(watcher.onBlockVisibility).toHaveBeenLastCalledWith(expect.objectContaining({ visibleFraction: 1 }));
    height = 4000;
    FakeResizeObserver.instance.emit(element);
    expect((FakeIntersectionObserver.instances[1]?.options.threshold as number[])[10]).toBe(0.2);
    expect(io?.observed.size).toBe(0);
  });
  it('reports mount, meaningful changes and unmount without duplicate measurements', () => {
    const watcher = observerDouble();
    mount(watcher);
    const io = FakeIntersectionObserver.instances[0];
    io?.emit(element, 60, 100);
    io?.emit(element, 65, 100);
    io?.emit(element, 100, 100);
    act(() => root.unmount());
    expect(
      watcher.onBlockVisibility.mock.calls.map(([event]: [{ visibleFraction: number }]) => event.visibleFraction),
    ).toEqual([0, 0.6, 1, 0]);
    root = createRoot();
  });
  it('replays current visibility to a late observer and rebuilds when chrome changes', () => {
    mount();
    FakeIntersectionObserver.instances[0]?.emit(element, 60, 100);
    const watcher = observerDouble();
    act(() => root.render(<Probe observer={watcher} bottom={40} onProps={() => undefined} />));
    expect(watcher.onBlockVisibility).toHaveBeenLastCalledWith(expect.objectContaining({ visibleFraction: 0.6 }));
    expect(FakeIntersectionObserver.instances.at(-1)?.options.rootMargin).toBe('0px 0px -40px 0px');
  });
  it('stops observing a detached element', () => {
    const props = mount(observerDouble());
    props.ref?.(null);
    expect(FakeIntersectionObserver.instances[0]?.observed.size).toBe(0);
  });
  it('remains safe when IntersectionObserver is unavailable', () => {
    delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    const watcher = observerDouble();
    expect(() => mount(watcher)).not.toThrow();
    expect(watcher.onBlockVisibility).toHaveBeenCalledWith(expect.objectContaining({ visibleFraction: 0 }));
  });
});

describe('private web resume geometry', () => {
  it('captures a tall block at the reading edge, restores after font resize and clamps to the content end', () => {
    let viewport!: ReadingViewport;
    let props: BlockReadingProps = {};
    let blockTop = 300;
    height = 2400;
    Object.defineProperty(scroller, 'scrollHeight', { value: 4000, configurable: true });
    scroller.getBoundingClientRect = () => ({ top: 80 }) as DOMRect;
    element.getBoundingClientRect = () => ({ top: 80 + blockTop - scroller.scrollTop, height }) as DOMRect;
    act(() =>
      root.render(
        <Probe
          onProps={(next) => {
            props = next;
          }}
          onViewport={(next) => {
            viewport = next;
          }}
        />,
      ),
    );
    props.ref?.(element as never);
    scroller.scrollTop = 1400;
    expect(viewport.capturePosition()).toEqual({ blockId: 'chart-1', offsetWithinBlock: 1100 });
    const changed = jest.fn();
    const scrollTo = jest.fn((y: number) => {
      scroller.scrollTop = y;
    });
    viewport.bindPosition({ initial: { blockId: 'chart-1', offsetWithinBlock: 1100 }, changed, scrollTo });
    expect(scrollTo).toHaveBeenLastCalledWith(1400);
    scroller.dispatchEvent(new Event('scroll'));
    expect(changed).not.toHaveBeenCalled();
    // Text above the block grows, then this block shrinks below the stored offset.
    blockTop = 500;
    height = 700;
    FakeResizeObserver.instance.emit(element);
    expect(scrollTo).toHaveBeenLastCalledWith(1200);
    Object.defineProperty(scroller, 'scrollHeight', { value: 1700, configurable: true });
    FakeResizeObserver.instance.emit(scroller);
    expect(scrollTo).toHaveBeenLastCalledWith(880);
    scroller.dispatchEvent(new Event('wheel'));
    scroller.scrollTop = 600;
    scroller.dispatchEvent(new Event('scroll'));
    expect(changed).toHaveBeenCalledTimes(1);
    const calls = scrollTo.mock.calls.length;
    FakeResizeObserver.instance.emit(element);
    expect(scrollTo).toHaveBeenCalledTimes(calls);
    viewport.disposePosition();
    scroller.dispatchEvent(new Event('scroll'));
    expect(changed).toHaveBeenCalledTimes(1);
    props.ref?.(null);
    FakeResizeObserver.instance.emit(element);
    expect(scrollTo).toHaveBeenCalledTimes(calls);
  });
});
