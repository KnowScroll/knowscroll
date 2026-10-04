/** One JSON object per line: stdout for events, stderr for errors. Callers pass ids and outcome
 * kinds only, never a question, a claim, a reply or a key. */
export function logLine(line: object): void {
  console.log(JSON.stringify(line));
}

export function logError(line: object): void {
  console.error(JSON.stringify(line));
}
