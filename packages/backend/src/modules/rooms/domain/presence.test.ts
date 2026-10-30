import { describe, expect, it } from 'vitest';
import { hereOf } from './presence.js';

const facts = (present: string[], blocked: string[] = []) => ({
  present,
  viewer: 'me',
  blocked: new Set(blocked),
  maxFaces: 12,
});

describe('who is here', () => {
  it('always includes the reader, first, even before their own lease is written', () => {
    expect(hereOf(facts([]))).toEqual({ faces: ['me'], count: undefined });
    expect(hereOf(facts(['a', 'me']))).toEqual({ faces: ['me', 'a'], count: undefined });
  });

  it('says no number below three people, so "0 here" and "1 here" cannot be said', () => {
    for (const present of [[], ['me'], ['a'], ['a', 'me']]) expect(hereOf(facts(present)).count).toBeUndefined();
  });

  it('says the number from three people', () => {
    expect(hereOf(facts(['a', 'b']))).toEqual({ faces: ['me', 'a', 'b'], count: 3 });
    expect(hereOf(facts(['a', 'b', 'c', 'd'])).count).toBe(5);
  });

  it('leaves a blocked person out of the faces and of the count, for the reader only', () => {
    expect(hereOf(facts(['a', 'b'], ['b']))).toEqual({ faces: ['me', 'a'], count: undefined });
    // Without the block the same room has three people here.
    expect(hereOf(facts(['a', 'b'])).count).toBe(3);
  });

  it('shows at most the face limit but counts everyone', () => {
    const many = Array.from({ length: 20 }, (_, index) => `p${String(index)}`);
    const here = hereOf({ ...facts(many), maxFaces: 12 });
    expect(here.faces).toHaveLength(12);
    expect(here.count).toBe(21);
  });
});
