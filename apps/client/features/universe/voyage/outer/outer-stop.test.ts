import { createOuterStop } from './outer-stop';

describe('the outer stop flag', () => {
  it('starts away, enters and leaves, and says nothing when nothing changed', () => {
    const outer = createOuterStop();
    const heard = jest.fn();
    outer.subscribe(heard);
    expect(outer.getState()).toEqual({ on: false, listOpen: false });
    outer.leave();
    outer.closeList();
    expect(heard).not.toHaveBeenCalled();
    outer.enter();
    outer.enter();
    expect(outer.getState()).toEqual({ on: true, listOpen: false });
    expect(heard).toHaveBeenCalledTimes(1);
    outer.leave();
    expect(outer.getState().on).toBe(false);
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('keeps the same state object until something changes', () => {
    const outer = createOuterStop();
    const first = outer.getState();
    outer.leave();
    expect(outer.getState()).toBe(first);
    outer.enter();
    const entered = outer.getState();
    outer.enter();
    expect(outer.getState()).toBe(entered);
  });

  it('opens the list only at the stop, and leaving closes it', () => {
    const outer = createOuterStop();
    outer.openList();
    expect(outer.getState().listOpen).toBe(false);
    outer.enter();
    outer.openList();
    expect(outer.getState()).toEqual({ on: true, listOpen: true });
    outer.closeList();
    expect(outer.getState()).toEqual({ on: true, listOpen: false });
    outer.openList();
    outer.leave();
    expect(outer.getState()).toEqual({ on: false, listOpen: false });
    outer.enter();
    expect(outer.getState().listOpen).toBe(false);
  });

  it('stops telling a listener that unsubscribed', () => {
    const outer = createOuterStop();
    const heard = jest.fn();
    const stop = outer.subscribe(heard);
    stop();
    outer.enter();
    expect(heard).not.toHaveBeenCalled();
  });
});
