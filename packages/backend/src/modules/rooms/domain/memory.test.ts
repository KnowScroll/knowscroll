import { describe, expect, it } from 'vitest';
import { MEMORY_RULES, memoryDue, memoryProblem, type MemoryFacts } from './memory.js';

const facts = (over: Partial<MemoryFacts> = {}): MemoryFacts => ({
  state: 'none',
  source: undefined,
  readable: 12,
  newSince: 0,
  ...over,
});

describe('when the room’s memory is written (D-247)', () => {
  it('writes the first text once there is enough to remember, and not before', () => {
    expect(memoryDue(facts())).toBe('first');
    expect(memoryDue(facts({ readable: MEMORY_RULES.minReadable }))).toBe('first');
    expect(memoryDue(facts({ readable: MEMORY_RULES.minReadable - 1 }))).toBeUndefined();
    expect(memoryDue(facts({ readable: 0 }))).toBeUndefined();
  });

  it('writes again after something it read was removed, kept out or deleted (stale)', () => {
    expect(memoryDue(facts({ state: 'stale', source: undefined }))).toBe('stale');
    // ...but not from what is left when too little is left.
    expect(memoryDue(facts({ state: 'stale', readable: 3 }))).toBeUndefined();
  });

  it('writes again after enough new messages, and not for a few', () => {
    expect(memoryDue(facts({ state: 'ready', source: 'derived', newSince: MEMORY_RULES.grownBy - 1 }))).toBeUndefined();
    expect(memoryDue(facts({ state: 'ready', source: 'derived', newSince: MEMORY_RULES.grownBy }))).toBe('grown');
  });

  it('never replaces what a moderator wrote', () => {
    expect(memoryDue(facts({ state: 'ready', source: 'moderator', newSince: 500 }))).toBeUndefined();
  });

  it('is bounded: the window is a fixed number of messages and the text a fixed number of characters', () => {
    expect(MEMORY_RULES.windowMessages).toBeLessThanOrEqual(60);
    expect(MEMORY_RULES.maxChars).toBeLessThanOrEqual(600);
  });
});

describe('what a memory may say', () => {
  it('is plain, bounded text without a link', () => {
    expect(
      memoryProblem('People compared tides.\nOne question about spring tides is open.', 'residents'),
    ).toBeUndefined();
    expect(memoryProblem('', 'residents')).toBe('empty');
    expect(memoryProblem('x'.repeat(MEMORY_RULES.maxChars + 1), 'residents')).toBe('too_long');
    expect(memoryProblem('See https://example.org', 'residents')).toBe('has_link');
    expect(memoryProblem('Two lines\u0007 with a bell', 'residents')).toBe('control');
  });

  it('names no one when a resident wrote it, and claims to be no person', () => {
    expect(memoryProblem('Member 2 asked about tides.', 'residents')).toBe('names_a_member');
    expect(memoryProblem('I am a student and I like tides.', 'residents')).toBe('claims_to_be_a_person');
  });

  it('leaves a moderator’s own words theirs, within the bounds', () => {
    expect(memoryProblem('Member 2 asked about tides. We ask newcomers to say hello.', 'moderator')).toBeUndefined();
    expect(memoryProblem('   ', 'moderator')).toBe('empty');
    expect(memoryProblem('x'.repeat(MEMORY_RULES.maxChars + 1), 'moderator')).toBe('too_long');
    expect(memoryProblem('Read www.example.org', 'moderator')).toBe('has_link');
  });
});
