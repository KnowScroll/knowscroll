import { observeMediaVisibility } from './visibility.web';

/** A recording stand-in: jsdom has no IntersectionObserver, and the test chooses what it reports. */
function installObserver() {
  const instances: { report: (ratio: number) => void }[] = [];
  class FakeObserver {
    private readonly callback: (entries: Partial<IntersectionObserverEntry>[]) => void;
    constructor(callback: (entries: Partial<IntersectionObserverEntry>[]) => void) {
      this.callback = callback;
      instances.push({
        report: (ratio) => this.callback([{ isIntersecting: ratio > 0, intersectionRatio: ratio }]),
      });
    }
    observe() {}
    disconnect() {}
  }
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeObserver;
  return instances;
}

describe('observeMediaVisibility on the web', () => {
  it('says nothing until the browser has measured the stage, so a resume owed from a closed sheet is not cancelled', () => {
    const observers = installObserver();
    const changed = jest.fn();
    const stage = document.createElement('div');
    const stop = observeMediaVisibility(stage, changed);
    // The player treats "not visible" as leaving; before any measurement the stage has not left.
    expect(changed).not.toHaveBeenCalled();
    observers[0]!.report(1);
    expect(changed).toHaveBeenLastCalledWith(true);
    observers[0]!.report(0);
    expect(changed).toHaveBeenLastCalledWith(false);
    stop();
  });
});
