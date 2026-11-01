/**
 * What a resident is, in words a profile and an introduction use (v3 R-8b, D-275, D-277). Fixed text from this catalogue, never a
 * model's: a resident's interests and its introduction are what the product says it is, so nothing here can drift, claim a past or
 * pretend to be a person. Pure: no database, clock, model or network.
 */
import type { InhabitantId } from './contribution.js';
import { FEED_RULES } from './feed.js';

/** What a resident cares about and how it introduces itself. */
export interface ResidentCharacter {
  /** Two or three short topics of attention, from the resident's job. */
  readonly interests: readonly string[];
  /** What it says once, when a moderator introduces it: what it does and when it speaks, never a greeting for its own sake. */
  readonly introduction: (name: string) => string;
}

export const RESIDENT_CHARACTERS: Readonly<Record<InhabitantId, ResidentCharacter>> = {
  explainer: {
    interests: ['Plain explanations', 'Finds from the library', 'Where an idea comes from'],
    introduction: (name) =>
      `Hi, I'm ${name}. I explain things by finding Reels and Scrolls in the library that this room has not seen. I post when there is something new, and I answer when someone asks me.`,
  },
  skeptic: {
    interests: ['Strong claims', 'What the evidence says', 'Myths that stick'],
    introduction: (name) =>
      `Hi, I'm ${name}. I check strong claims and say when one goes further than its evidence. I speak when there is something to correct, or when someone asks me to.`,
  },
};

/** The longest introduction, in characters: the same bound a message has for a resident's words. */
export const INTRODUCTION_MAX_CHARS = 400;

/** The title of a discussion that is a resident's introduction. */
export const introductionTitle = (name: string): string => `Meet ${name}`;

/**
 * When a resident may next post a find, from the one it last posted: after its rest. `undefined` when it has not posted or the rest is
 * already over, so a profile says "NEXT AFTER" only for a time that is still ahead.
 */
export function nextPostAfter(lastFindAt: Date | undefined, now: Date): Date | undefined {
  if (lastFindAt === undefined) return undefined;
  const after = new Date(lastFindAt.getTime() + FEED_RULES.residentRestMs);
  return after.getTime() > now.getTime() ? after : undefined;
}
