import { render, screen } from '@testing-library/react-native';
import type { ThreadSummary } from '@knowscroll/contracts';
import { DisplayProvider } from '@knowscroll/ui';
import { ThreadRow } from './thread-row';

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));

const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const asha = { kind: 'person' as const, personId: id(10), handle: 'ci.asha', displayName: 'Asha' };
const summary = (patch: Partial<ThreadSummary> = {}): ThreadSummary => ({
  thread: { threadId: id(1), membershipId: id(2), membershipRevision: 1 },
  root: {
    status: 'available',
    target: { assetId: id(30), assetRevision: 1 },
    metadata: { kind: 'scroll', title: 'Tides', summary: '', language: 'en' },
  },
  state: 'joined',
  ownPersonId: id(11),
  people: [asha],
  latestMessageSequence: 0,
  own: { readThroughSequence: 0, muted: false },
  lastActivityAt: '2026-10-24T08:00:00.000Z',
  ...patch,
});
const show = (item: ThreadSummary) =>
  render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <ThreadRow item={item} />
    </DisplayProvider>,
  );

describe('a thread row in Talk', () => {
  it('carries the part chip when the thread was started on a part of a series, and says it in its name', async () => {
    await show(summary({ series: { part: 2, total: 3 } }));
    expect(screen.getByTestId(`talk-thread-part-${id(1)}`)).toBeOnTheScreen();
    expect(screen.getByText('Part 2 of 3')).toBeOnTheScreen();
    expect(screen.getByTestId(`talk-thread-${id(1)}`).props.accessibilityLabel).toContain('part 2 of 3');
  });

  it('has no chip for a thread on a single Scroll or Reel', async () => {
    await show(summary());
    expect(screen.queryByTestId(`talk-thread-part-${id(1)}`)).toBeNull();
  });
});
