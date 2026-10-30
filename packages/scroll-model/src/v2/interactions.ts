/**
 * Deliberate interactions a v2 reader reports, by kind and never by value (D-063). A call counts for
 * reading when the reader locked it in or saw its reveal. The option a reader picked, and whether it
 * was right, are not an interaction kind and never reach the server's evidence: there is no kind to
 * carry them.
 */
export const INTERACTION_KINDS_V2 = {
  call_it: ['locked', 'revealed'],
  final_call: ['locked', 'revealed'],
} as const satisfies Readonly<Record<string, readonly string[]>>;

/** The interactions that make a call count as read. */
export const CALL_READ_INTERACTIONS: readonly string[] = ['locked', 'revealed'];
