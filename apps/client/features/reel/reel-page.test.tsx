import { AppState, type AppStateStatus } from 'react-native';
import { harness } from '../encounter/encounter-session.fixture';
import { createReelViewport, observeReelPageStage } from './reel-page';

type Measurement = (x: number, y: number, width: number, height: number) => void;
const page = { left: 0, top: 100, right: 355, bottom: 500 }; // Already excludes header/safe/tab regions.
function geometry() {
  const h = harness(),
    store = createReelViewport(),
    pause = jest.fn(),
    changed = jest.fn();
  const pending: Measurement[] = [];
  const observer = observeReelPageStage(
    store,
    h.scope,
    true,
    pause,
    (callback) => {
      pending.push(callback);
    },
    changed,
  );
  const finish = (y: number, height = 300) => {
    const callback = pending.at(-1);
    if (!callback) throw new Error('Native stage measurement required');
    callback(0, y, 355, height);
  };
  const layout = () => {
    const revision = store.invalidate();
    store.measured(revision, page);
  };
  return { ...h, store, pause, changed, pending, observer, finish, layout };
}

describe('actual native Reel viewport authority (labelled geometry callbacks, not native pixels)', () => {
  const changes: ((state: AppStateStatus) => void)[] = [];
  const original = Object.getOwnPropertyDescriptor(AppState, 'currentState');
  beforeEach(() => {
    Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
    changes.length = 0;
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
      changes.push(listener);
      return { remove: jest.fn() };
    });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (original) Object.defineProperty(AppState, 'currentState', original);
  });
  it('requires a measured stage intersection, revokes synchronously on scroll and rejects stale stage/page callbacks', () => {
    const h = geometry();
    try {
      expect(h.changed).toHaveBeenLastCalledWith(false);
      h.layout();
      h.finish(120);
      expect(h.changed).toHaveBeenLastCalledWith(true);
      h.observer.layout();
      const oldStage = h.pending.at(-1)!;
      const oldPageRevision = h.store.invalidate();
      expect(h.changed).toHaveBeenLastCalledWith(false);
      expect(h.pause).toHaveBeenCalled();
      const newPageRevision = h.store.invalidate();
      h.store.measured(oldPageRevision, page);
      expect(h.store.read().bounds).toBeNull();
      oldStage(0, 120, 355, 300);
      expect(h.changed).toHaveBeenLastCalledWith(false);
      h.store.measured(newPageRevision, page);
      h.finish(501);
      expect(h.changed).toHaveBeenLastCalledWith(false);
      h.observer.layout();
      h.finish(-51);
      expect(h.changed).toHaveBeenLastCalledWith(false); // Less than half of the stage below the header.
      h.observer.layout();
      h.finish(350);
      expect(h.changed).toHaveBeenLastCalledWith(true); // Exactly half is inside the real viewport.
      h.observer.layout();
      h.finish(Number.NaN);
      expect(h.changed).toHaveBeenLastCalledWith(false);
    } finally {
      h.observer.stop();
      h.scope.end();
    }
  });
  it('fences resize, background, route park, scope disposal and unmount without restoring old callbacks', () => {
    const h = geometry();
    try {
      h.layout();
      h.finish(120);
      h.observer.layout();
      const beforeBackground = h.pending.at(-1)!;
      changes.at(-1)!('background');
      expect(h.changed).toHaveBeenLastCalledWith(false);
      beforeBackground(0, 120, 355, 300);
      expect(h.changed).toHaveBeenLastCalledWith(false);
      changes.at(-1)!('active');
      h.finish(120);
      expect(h.changed).toHaveBeenLastCalledWith(true);
      h.observer.layout();
      const beforeResize = h.pending.at(-1)!;
      const revision = h.store.invalidate();
      h.store.measured(revision, { ...page, bottom: 200 });
      beforeResize(0, 120, 355, 300);
      expect(h.changed).toHaveBeenLastCalledWith(false);
      h.finish(120);
      expect(h.changed).toHaveBeenLastCalledWith(false); // Only80px of300 visible after the resize.
      h.observer.layout();
      const beforeDisposal = h.pending.at(-1)!;
      h.scope.end();
      expect(h.changed).toHaveBeenLastCalledWith(false);
      const calls = h.changed.mock.calls.length;
      beforeDisposal(0, 100, 355, 50);
      expect(h.changed).toHaveBeenCalledTimes(calls);
      h.observer.stop();
      beforeDisposal(0, 100, 355, 50);
      expect(h.changed).toHaveBeenCalledTimes(calls);
    } finally {
      h.observer.stop();
      h.scope.end();
    }
  });
  it('never transfers a previous stage permission to a new scope object, or grants a parked route', () => {
    const h = geometry(),
      other = harness();
    try {
      h.layout();
      h.finish(120);
      h.observer.layout();
      const previous = h.pending.at(-1)!;
      h.observer.stop();
      const calls = h.changed.mock.calls.length;
      const pending: Measurement[] = [],
        changed = jest.fn(),
        pause = jest.fn();
      const parked = observeReelPageStage(
        h.store,
        other.scope,
        false,
        pause,
        (callback) => {
          pending.push(callback);
        },
        changed,
      );
      previous(0, 120, 355, 300);
      expect(h.changed).toHaveBeenCalledTimes(calls);
      expect(other.scope).not.toBe(h.scope);
      expect(other.scope.id).toBe(h.scope.id); // Textual scope identity cannot substitute for mounted authority.
      expect(changed).toHaveBeenLastCalledWith(false);
      expect(pending).toHaveLength(0);
      parked.stop();
      const current = observeReelPageStage(
        h.store,
        other.scope,
        true,
        pause,
        (callback) => {
          pending.push(callback);
        },
        changed,
      );
      expect(changed).toHaveBeenLastCalledWith(false);
      pending.at(-1)!(0, 120, 355, 300);
      expect(changed).toHaveBeenLastCalledWith(true);
      current.stop();
    } finally {
      h.observer.stop();
      h.scope.end();
      other.scope.end();
    }
  });
});
