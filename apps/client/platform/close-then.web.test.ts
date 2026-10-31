/** Web (jest-expo/web, jsdom): a sheet closes first, and what the person chose in it opens after its Back, never before. */
import { closeThen } from './close-then';

describe('closeThen (web)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('closes the sheet at once and opens the screen only once the sheet’s Back has landed', () => {
    const order: string[] = [];
    closeThen(
      () => order.push('close'),
      () => order.push('open'),
    );
    // The sheet is closed, the screen is not opened yet: opening now would be popped by the sheet's Back.
    expect(order).toEqual(['close']);
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(order).toEqual(['close', 'open']);
  });

  it('opens the screen after a short delay when the Back never reports', () => {
    const run = jest.fn();
    closeThen(() => undefined, run);
    expect(run).not.toHaveBeenCalled();
    jest.advanceTimersByTime(400);
    expect(run).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
});
