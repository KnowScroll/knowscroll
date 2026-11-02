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

/**
 * T3 "new since you were here": on opening a thread or a conversation, what others said after the person's own
 * stored read position sits under a marked line. `readThrough` is the position the server held when the person
 * opened it (their own, never shown to anyone else). Returns the sequence the line follows, or `undefined` when
 * the person has never read here (then everything would be "new") or nothing from anyone else came after it.
 */
export function newSinceAfter<T extends { readonly sequence: number }>(
  readThrough: number,
  messages: readonly T[],
  isOwn: (message: T) => boolean,
): number | undefined {
  return readThrough > 0 && messages.some((message) => message.sequence > readThrough && !isOwn(message))
    ? readThrough
    : undefined;
}
