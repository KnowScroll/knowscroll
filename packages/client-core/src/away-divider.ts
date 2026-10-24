/** The newest message sequence the person has confirmed; the point a "While you were away" divider falls after. */
export function newestSequence(messages: readonly { readonly sequence: number }[]): number {
  return messages.at(-1)?.sequence ?? 0;
}

/**
 * C02 and C04: after a lost connection returns, messages that arrived meanwhile sit under a "While
 * you were away" divider. Returns the sequence the divider follows, or `undefined` when nothing
 * arrived while the person could not read (then no divider is drawn). The person's own messages do
 * not count: one of theirs that only settled after the reconnect is not something they missed. The
 * view only inserts the divider; it never scrolls, so a reader who stayed higher up keeps their place.
 */
export function awayAfter<T extends { readonly sequence: number }>(
  lostAfter: number | undefined,
  messages: readonly T[],
  isOwn: (message: T) => boolean,
): number | undefined {
  return lostAfter !== undefined && messages.some((message) => message.sequence > lostAfter && !isOwn(message))
    ? lostAfter
    : undefined;
}
