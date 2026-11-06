import type { InhabitantStatus } from '@knowscroll/client-core';
import type { RoomYou } from '@knowscroll/contracts';
import type { MentionOption } from '../conversations/mention-input';

/** Off mutes ambient replies, not explicit asks. Keep-out prevents the resident reading this member's words. */
export function residentMentionOptions(
  inhabitants: readonly InhabitantStatus[],
  you: Pick<RoomYou, 'aiLevel' | 'keepOut'> | undefined,
): readonly MentionOption[] {
  return inhabitants.map((entry) => {
    const unavailable =
      you?.keepOut === true
        ? 'Your messages are kept out of AI'
        : entry.ask === 'preparing'
          ? 'Reply in progress'
          : entry.ask === 'resting'
            ? 'Resting for now'
            : entry.ask === 'paused'
              ? 'Room is paused'
              : undefined;
    return {
      id: entry.inhabitant,
      name: entry.name,
      label: entry.label,
      disabled: unavailable !== undefined,
      status: unavailable ?? (you?.aiLevel === 'off' ? 'AI is Off; direct asks still work' : undefined),
    };
  });
}
