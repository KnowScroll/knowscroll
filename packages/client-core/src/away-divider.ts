/** The newest message sequence the person has confirmed; the point a "While you were away" divider falls after. */
export function newestSequence(messages: readonly { readonly sequence: number }[]): number {
  return messages.at(-1)?.sequence ?? 0;
}

/**
 * C02 and C04: after a lost connection returns, messages that arrived meanwhile sit under a "While
 * you were away" divider. Returns the sequence the divider follows, or `undefined` when nothing
 * arrived while the person could not read (then no divider is drawn). The view only inserts the
 * divider; it never scrolls, so a reader who stayed higher up keeps their place.
 */
export function awayAfter(
  lostAfter: number | undefined,
  messages: readonly { readonly sequence: number }[],
): number | undefined {
  return lostAfter !== undefined && messages.some((message) => message.sequence > lostAfter) ? lostAfter : undefined;
}
