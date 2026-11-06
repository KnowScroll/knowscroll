/** One actual, currently visible recipient. Picking one edits a draft; it never sends. */
export interface MentionOption {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly status?: string;
  readonly disabled?: boolean;
}

export interface MentionQuery {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

/** The @token at the caret, excluding email addresses. Replacing it preserves text on both sides. */
export function mentionQuery(text: string, caret: number): MentionQuery | undefined {
  const prefix = text.slice(0, caret);
  const found = /(?:^|\s)@([^\s@]*)$/u.exec(prefix);
  if (found === null) return undefined;
  let end = caret;
  while (end < text.length && /[^\s@]/u.test(text[end]!)) end++;
  return { start: caret - found[1]!.length - 1, end, query: found[1]! };
}

/** The same whole-name boundary as the room's authoritative router; the first named resident receives the turn. */
export function mentionedOption(text: string, options: readonly MentionOption[]): MentionOption | undefined {
  const escape = (name: string) => name.replaceAll(/[\\^$.*+?()[\]{}|]/gu, '\\$&');
  const names = options.map((option) => escape(option.name)).join('|');
  if (names === '') return undefined;
  const match = new RegExp(`(?<![\\p{L}\\p{N}_.])@(${names})(?![\\p{L}\\p{N}_])`, 'iu').exec(text);
  return match === null ? undefined : options.find((option) => option.name.toLowerCase() === match[1]!.toLowerCase());
}

export function insertMention(text: string, query: MentionQuery, name: string): { text: string; caret: number } {
  const mention = `@${name} `;
  return {
    text: text.slice(0, query.start) + mention + text.slice(query.end).replace(/^ /u, ''),
    caret: query.start + mention.length,
  };
}
