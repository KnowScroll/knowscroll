import { siblingAvailability } from './use-format-siblings';

const assetId = '0199a000-0000-7000-8000-000000000044';

describe('what the format switch offers for the twin of a Scroll or Reel opened by its address (D-269)', () => {
  it('opens a twin that is ready and shows one that is being made as preparing', () => {
    expect(siblingAvailability([{ kind: 'reel', status: 'ready', assetId, assetRevision: 1 }], 'scroll', true)).toEqual(
      { scroll: 'ready', reel: 'ready' },
    );
    expect(
      siblingAvailability(
        [{ kind: 'reel', status: 'pending', requestId: '0199a000-0000-7000-8000-000000000010' }],
        'scroll',
        true,
      ),
    ).toEqual({ scroll: 'ready', reel: 'preparing' });
  });

  it('offers to ask for a twin that does not exist, whether the server lists it as unavailable or not at all', () => {
    expect(siblingAvailability([{ kind: 'reel', status: 'unavailable' }], 'scroll', true).reel).toBe('requestable');
    expect(siblingAvailability([], 'scroll', true).reel).toBe('requestable');
    expect(siblingAvailability([], 'reel', true).scroll).toBe('requestable');
  });

  it('leaves it unavailable on a route with no request to make, and until the read has arrived', () => {
    expect(siblingAvailability([{ kind: 'reel', status: 'unavailable' }], 'scroll', false).reel).toBe('unavailable');
    expect(siblingAvailability(undefined, 'scroll', true).reel).toBe('unavailable');
  });

  it('never marks the format on screen as anything but ready', () => {
    expect(siblingAvailability([{ kind: 'scroll', status: 'unavailable' }], 'scroll', true).scroll).toBe('ready');
  });
});
