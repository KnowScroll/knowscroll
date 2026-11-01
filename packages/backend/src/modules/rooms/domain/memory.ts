/**
 * What the room's residents remember (v3 R-8, D-247): one short text of what members have discussed, derived from the newest
 * retained messages and written again, never added to. Pure rules: when a text is due, and what it may say.
 */
import { textProblem, type ContributionProblem } from './contribution.js';
import { voiceProblem, type VoiceProblem } from './feed.js';

export const MEMORY_RULES = {
  /** The longest memory, in characters: a few short lines. */
  maxChars: 600,
  /** The newest retained messages one rewrite reads, so the text is bounded by what the room said lately and never grows. */
  windowMessages: 60,
  /** The most characters of one message a rewrite reads. */
  messageChars: 400,
  /** Fewer readable messages than this are not enough to remember anything. */
  minReadable: 8,
  /** A text that stands is written again once this many readable messages have followed what it read. */
  grownBy: 20,
} as const;

export type MemoryTrigger = 'first' | 'stale' | 'grown';

export interface MemoryFacts {
  readonly state: 'none' | 'ready' | 'stale';
  /** Who wrote the text that stands; none when there is no text. */
  readonly source: 'derived' | 'moderator' | undefined;
  /** Retained messages of members who do not keep theirs out, within the window a rewrite would read. */
  readonly readable: number;
  /** Of those, how many were written after the text's last rewrite. */
  readonly newSince: number;
}

/**
 * Whether the memory is written again now, and why. A moderator's text stands until a moderator ends it: nothing derived
 * replaces it. Otherwise: the first text once there is enough to remember; again after something it read was removed, kept
 * out or deleted (`stale`); and again after enough new messages (`grown`). Too few readable messages means nothing, which is
 * also what keeps a quiet room from making a call.
 */
export function memoryDue(facts: MemoryFacts): MemoryTrigger | undefined {
  if (facts.source === 'moderator' && facts.state === 'ready') return undefined;
  if (facts.readable < MEMORY_RULES.minReadable) return undefined;
  if (facts.state === 'none') return 'first';
  if (facts.state === 'stale') return 'stale';
  return facts.newSince >= MEMORY_RULES.grownBy ? 'grown' : undefined;
}

export type MemoryProblem = ContributionProblem | VoiceProblem | 'names_a_member' | 'control';

/** A speaker number in the words would read as a name nobody knows. */
const SPEAKER_NUMBER = /\bMember \d+\b/u;
/** Plain text and line breaks only: any other control character is refused. */
const hasControl = (text: string): boolean =>
  [...text].some((character) => {
    const point = character.codePointAt(0)!;
    return (point < 32 && point !== 10) || (point >= 127 && point <= 159);
  });

/**
 * What is wrong with a memory text, if anything. Whoever wrote it: bounded, plain text, no link. Written by a resident it
 * also never claims to be a person or to have lived anything (the same voice guard as a find's note) and names no one
 * (speakers are numbers in what it reads). A moderator's own words are theirs to choose, so only the bounds and the link apply.
 */
export function memoryProblem(text: string, by: 'residents' | 'moderator'): MemoryProblem | undefined {
  if (hasControl(text)) return 'control';
  if (by === 'moderator') {
    const trimmed = text.trim();
    if (trimmed === '') return 'empty';
    if ([...trimmed].length > MEMORY_RULES.maxChars) return 'too_long';
    return /https?:\/\/|www\./iu.test(trimmed) ? 'has_link' : undefined;
  }
  return (
    textProblem(text, MEMORY_RULES.maxChars) ??
    voiceProblem(text) ??
    (SPEAKER_NUMBER.test(text) ? 'names_a_member' : undefined)
  );
}
