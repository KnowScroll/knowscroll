/** Web (jest-expo/web, jsdom): navigation after a sheet's own Back, never before it. */
import { afterPendingBack, notePendingBack } from './after-pending-back';

describe('afterPendingBack (web)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('waits for the pending Back to land, then runs once', () => {
    const run = jest.fn();
    notePendingBack();
    afterPendingBack(run);
    expect(run).not.toHaveBeenCalled();
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(run).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new PopStateEvent('popstate'));
    jest.advanceTimersByTime(1000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs at once when no Back is pending', () => {
    const run = jest.fn();
    afterPendingBack(run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs after a short delay when a Back never reports', () => {
    const run = jest.fn();
    notePendingBack();
    afterPendingBack(run);
    jest.advanceTimersByTime(399);
    expect(run).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
});
