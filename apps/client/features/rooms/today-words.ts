/** The date line of Today, in capitals' words: "Tue 27 Oct". The day is a UTC day, so it is read in UTC. */
export function dayHeading(day: string): string {
  return new Date(`${day}T12:00:00.000Z`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/** When a vote closes, in the reader's own clock: "Fri 31 Oct, 14:00". */
export function closesWords(iso: string): string {
  const at = new Date(iso);
  return `${at.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}, ${at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

/** "1 message in Today so far": what the number counts (messages people wrote in Today since UTC midnight), shown only when there is one. */
export const messagesWords = (count: number): string =>
  `${String(count)} ${count === 1 ? 'message' : 'messages'} in Today so far`;
