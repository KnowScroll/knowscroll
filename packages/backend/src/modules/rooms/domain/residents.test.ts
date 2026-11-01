import { ROOM_INTRODUCTION_MAX_CHARS } from '@knowscroll/contracts';
import { describe, expect, it } from 'vitest';
import { FEED_RULES } from './feed.js';
import { INTRODUCTION_MAX_CHARS, RESIDENT_CHARACTERS, introductionTitle, nextPostAfter } from './residents.js';
import { textProblem } from './contribution.js';

const HOUR = 3_600_000;
const NOW = new Date('2026-11-04T12:00:00.000Z');

describe('a resident’s character (D-275, D-277)', () => {
  it('has two or three interests, each short, and an introduction that names the resident and what it does', () => {
    for (const [inhabitant, character] of Object.entries(RESIDENT_CHARACTERS)) {
      expect(character.interests.length, inhabitant).toBeGreaterThanOrEqual(2);
      expect(character.interests.length, inhabitant).toBeLessThanOrEqual(4);
      for (const interest of character.interests) expect([...interest].length).toBeLessThanOrEqual(40);
      const words = character.introduction('Nova');
      expect(words).toContain("I'm Nova.");
      expect([...words].length).toBeLessThanOrEqual(INTRODUCTION_MAX_CHARS);
    }
  });

  it('is the contract’s length, and carries no link and no claim to be a person, like any words of a resident', () => {
    expect(INTRODUCTION_MAX_CHARS).toBe(ROOM_INTRODUCTION_MAX_CHARS);
    for (const character of Object.values(RESIDENT_CHARACTERS))
      expect(textProblem(character.introduction('Halley'), INTRODUCTION_MAX_CHARS)).toBeUndefined();
  });

  it('claims no experience: nothing watched, read, remembered or felt', () => {
    for (const character of Object.values(RESIDENT_CHARACTERS))
      expect(character.introduction('Nova')).not.toMatch(
        /\b(?:remember|watched|binge|changed how|blew my mind|years ago|growing up)\b/iu,
      );
  });

  it('titles an introduction with the resident’s own name', () => {
    expect(introductionTitle('Nova')).toBe('Meet Nova');
  });
});

describe('when a resident may next post (D-277)', () => {
  it('is its last find plus the rest, and only while that is still ahead', () => {
    const last = new Date(NOW.getTime() - 2 * HOUR);
    expect(nextPostAfter(last, NOW)?.toISOString()).toBe(
      new Date(last.getTime() + FEED_RULES.residentRestMs).toISOString(),
    );
    expect(nextPostAfter(new Date(NOW.getTime() - FEED_RULES.residentRestMs), NOW)).toBeUndefined();
    expect(nextPostAfter(new Date(NOW.getTime() - 7 * HOUR), NOW)).toBeUndefined();
  });

  it('is nothing for a resident that has not posted', () => {
    expect(nextPostAfter(undefined, NOW)).toBeUndefined();
  });
});
