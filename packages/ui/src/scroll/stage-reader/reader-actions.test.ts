import type { ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { actOnKey, type KeyTargets } from './reader-actions';

// Two hand-made stops, enough for the keys: not product content.
const stops = [
  { kind: 'read', id: 'read-1' },
  { kind: 'call_it', id: 'call-1', options: ['a', 'b', 'c'] },
] as unknown as ScrollDocumentV2['stops'];

function targets(heading: number): { at: KeyTargets; pick: jest.Mock; lock: jest.Mock } {
  const pick = jest.fn();
  const lock = jest.fn(() => true);
  const at: KeyTargets = {
    stops,
    hasTextVersion: true,
    commands: {},
    jump: jest.fn(),
    heading: () => heading,
    toggleTextVersion: jest.fn(),
    pick,
    lock,
  };
  return { at, pick, lock };
}

describe('the keys of a call', () => {
  it('act on the stop the reader is heading to, which may not be the one the scroll has reported yet', () => {
    const { at, pick, lock } = targets(1);
    expect(actOnKey({ action: 'pick', option: 2 }, at)).toBe(true);
    expect(pick).toHaveBeenCalledWith('call-1', 1, 3);
    expect(actOnKey({ action: 'lock-in' }, at)).toBe(true);
    expect(lock).toHaveBeenCalledWith('call-1');
  });

  it('are not used on a read stop', () => {
    const { at, pick, lock } = targets(0);
    expect(actOnKey({ action: 'pick', option: 1 }, at)).toBe(false);
    expect(actOnKey({ action: 'lock-in' }, at)).toBe(false);
    expect(pick).not.toHaveBeenCalled();
    expect(lock).not.toHaveBeenCalled();
  });
});
