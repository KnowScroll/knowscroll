const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * How long ago something happened, in the plain words Account uses ("Last used 2 days ago"). Coarse
 * on purpose: sessions record use to the nearest few minutes. Beyond a month it names the date.
 */
export function ago(iso: string, now: number): string {
  const elapsed = Math.max(0, now - Date.parse(iso));
  if (elapsed < 10 * MINUTE) return 'just now';
  if (elapsed < HOUR) return `${String(Math.floor(elapsed / MINUTE))} minutes ago`;
  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR);
    return hours === 1 ? '1 hour ago' : `${String(hours)} hours ago`;
  }
  if (elapsed < 30 * DAY) {
    const days = Math.floor(elapsed / DAY);
    return days === 1 ? 'yesterday' : `${String(days)} days ago`;
  }
  const date = new Date(iso);
  return `on ${String(date.getUTCDate())} ${months[date.getUTCMonth()] ?? ''} ${String(date.getUTCFullYear())}`;
}
