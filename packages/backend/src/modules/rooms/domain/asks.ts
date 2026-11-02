/**
 * What a member can ask of a resident, and which resident it asks for (D-167). No database, clock or model.
 * An asked turn has its own bounds (`contribution.ts`); it never counts against the unprompted caps (`router.ts`).
 */
import type { CastMember } from './cast.js';
import type { InhabitantId } from './contribution.js';
import { opensWithInterrogative } from './triggers.js';

/** The plain ask of a discussion, a pointed one, or an @name in a message. */
export type AskKind = 'ask' | 'challenge' | 'other_side' | 'about' | 'mention';
/** The asks that point at one message. */
export type TargetedAskKind = 'challenge' | 'other_side' | 'about';

/** The Skeptic tests or argues against a message; the Explainer answers it. */
export function residentForAsk(kind: TargetedAskKind): InhabitantId {
  return kind === 'about' ? 'explainer' : 'skeptic';
}

/** The ask kinds that point at a message the turn is about: every kind but the plain ask. */
export type PointedAskKind = Exclude<AskKind, 'ask'>;

/** The pointed kind of a turn's ask, or none for a plain ask and for a turn that was not asked. */
export const pointedKind = (kind: AskKind | null): PointedAskKind | undefined =>
  kind === null || kind === 'ask' ? undefined : kind;

const escape = (name: string): string => name.replaceAll(/[\\^$.*+?()[\]{}|]/gu, '\\$&');

/**
 * The resident a message addresses by name ("@Nova", "@halley"), if any: the first one named, so a message asks once.
 * A name is matched whole, in any case, and only where an @ begins a word: an address such as `a@nova.example` names
 * no one. Names are the room's own cast, never a model's.
 */
export function mentionedResident(text: string, cast: readonly CastMember[]): InhabitantId | undefined {
  if (!text.includes('@') || cast.length === 0) return undefined;
  const names = cast.map((member) => escape(member.name)).join('|');
  const found = new RegExp(`(?<![\\p{L}\\p{N}_.])@(${names})(?![\\p{L}\\p{N}_])`, 'iu').exec(text);
  if (found === null) return undefined;
  const name = found[1]!.toLowerCase();
  return cast.find((member) => member.name.toLowerCase() === name)?.inhabitant;
}

const MENTION = /(?<![\p{L}\p{N}_.])@[\p{L}\p{N}_]+/gu;
/** Words that greet or soften a request and ask nothing themselves, at the start of a message. */
const SOFTENER = /^(?:(?:hi|hello|hey|yo|ok|okay|so|and|please|thanks|thank you)\b[\s,.:;!-]*)+/iu;
/** Verbs that open a request to a resident ("explain tides", "tell me about the Moon"). */
const REQUEST_OPENING = /^(?:explain|tell|show|describe|define|give|help|teach|compare|summari[sz]e|clarify|walk)\b/iu;

/**
 * Whether a message that names a resident asks it something: it has a question mark, or, once the @names and a greeting
 * are set aside, it opens with an interrogative word or a request verb. "@Nova thanks, that helps" and "hi @Halley" ask
 * nothing, so the resident they name has nothing to answer and stays quiet (D-301). Lexical and blunt, like the router's own
 * filters (`triggers.ts`): it decides whether a resident is asked to look, not whether it has anything to say.
 */
export function asksSomething(text: string): boolean {
  const body = text.replaceAll(MENTION, ' ').replaceAll(/\s+/gu, ' ').trim();
  if (body.includes('?')) return true;
  const opening = body.replace(SOFTENER, '').replace(/^[\s,.:;!-]+/u, '');
  return opensWithInterrogative(opening) || REQUEST_OPENING.test(opening);
}
