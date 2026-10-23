/** "Try again in about N minutes" for a sign-in link the address or device asked for too often. */
export function rateLimitMessage(retryAfterSeconds: number | undefined): string {
  if (retryAfterSeconds === undefined) return "You've asked for several links. Wait a few minutes, then try again.";
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `You've asked for several links. Try again in ${minutes === 1 ? 'a minute' : `about ${minutes} minutes`}.`;
}
