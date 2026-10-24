import type { ScenarioCard, ThreadMessage } from '@knowscroll/contracts';
import { timeline } from './thread-messages';

const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const person = { kind: 'person' as const, personId: id(90), handle: 'ci.asha', displayName: 'Asha' };
const message = (n: number, at: string): ThreadMessage => ({
  messageId: id(n),
  sequence: n,
  status: 'available',
  author: person,
  recordedAt: at,
  body: { kind: 'text', text: `message ${String(n)}` },
});
const card = (n: number, createdAt: string, patch: Partial<ScenarioCard> = {}): ScenarioCard => ({
  nodeId: id(100 + n),
  kind: 'what_if',
  origin: 'root',
  title: `branch ${String(n)}`,
  changes: [],
  kept: [],
  hypothetical: true,
  assumptions: [],
  status: 'ready',
  revision: 1,
  createdAt,
  ...patch,
});
const names = (entries: ReturnType<typeof timeline>) =>
  entries.map((entry) => (entry.kind === 'branch' ? entry.card.title : `message ${String(entry.message.sequence)}`));

describe('the thread timeline', () => {
  it('places a branch card where its time falls among the messages', () => {
    const entries = timeline(
      [message(1, '2026-10-24T10:00:00.000Z'), message(2, '2026-10-24T10:10:00.000Z')],
      [card(1, '2026-10-24T10:05:00.000Z')],
    );
    expect(names(entries)).toEqual(['message 1', 'branch 1', 'message 2']);
  });

  it('puts a branch made after the last message at the end, and keeps branches in the order they were made', () => {
    const entries = timeline(
      [message(1, '2026-10-24T10:00:00.000Z')],
      [card(2, '2026-10-24T11:00:00.000Z'), card(1, '2026-10-24T10:30:00.000Z')],
    );
    expect(names(entries)).toEqual(['message 1', 'branch 1', 'branch 2']);
  });

  it('keeps a removed branch where it was, as a note, and a removed message where it was', () => {
    const entries = timeline(
      [message(1, '2026-10-24T10:00:00.000Z'), { messageId: id(2), sequence: 2, status: 'unavailable' }],
      [card(1, '2026-10-24T09:00:00.000Z', { status: 'removed' }), card(2, '2026-10-24T10:30:00.000Z')],
    );
    expect(names(entries)).toEqual(['branch 1', 'message 1', 'message 2', 'branch 2']);
  });

  it('does not change a branch card when it is read again with new words in the thread', () => {
    const first = timeline([message(1, '2026-10-24T10:00:00.000Z')], [card(1, '2026-10-24T10:30:00.000Z')]);
    const later = timeline(
      [message(1, '2026-10-24T10:00:00.000Z'), message(2, '2026-10-24T10:40:00.000Z')],
      [card(1, '2026-10-24T10:30:00.000Z')],
    );
    expect(names(first)).toEqual(['message 1', 'branch 1']);
    expect(names(later)).toEqual(['message 1', 'branch 1', 'message 2']);
  });
});
