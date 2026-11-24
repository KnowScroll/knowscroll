import { describe, expect, it } from 'vitest';
import { bannedNames, readerStrings } from './banned-names.js';

const sources = (...urls: string[]) => ({ sources: urls.map((url) => ({ url })) });
const matches = (text: string, code: string, provenance: ReturnType<typeof sources>) =>
  bannedNames(provenance).some((name) => name.code === code && name.pattern.test(text));

describe('the names a reader must not see', () => {
  const nasa = sources('https://science.nasa.gov/earth/facts');

  it('bans the source’s organisation and its address, each with a code of its own', () => {
    expect(matches('NASA explains this in detail elsewhere.', 'source_name_nasa', nasa)).toBe(true);
    expect(
      matches(
        'The National Aeronautics and Space Administration keeps a fine record.',
        'source_name_national_aeronautics_and_space_administration',
        nasa,
      ),
    ).toBe(true);
    expect(
      matches('More is written at science.nasa.gov for anyone curious.', 'source_name_science_nasa_gov', nasa),
    ).toBe(true);
    expect(matches('What nasa says about lamps', 'source_name_nasa', nasa)).toBe(true);
  });

  it('writes the word to remove into the hint, from a fixed list and not from the answer', () => {
    const hints = Object.fromEntries(bannedNames(nasa).map((name) => [name.code, name.hint]));
    expect(hints['source_name_nasa']).toBe(
      'Remove the name "NASA" from this text. Never name the source or its publisher.',
    );
    expect(hints['source_name_science_nasa_gov']).toBe('Remove the web address "science.nasa.gov" from this text.');
    // A publisher that none of the offered sources belongs to has no entry: it is an ordinary name there.
    expect(hints).not.toHaveProperty('source_name_wikipedia');
  });

  it('allows ordinary words that happen to be part of a host name, and names of other organisations', () => {
    const text =
      'The science of lamps is old, and an ocean service for ships once relied on a developer of better glass. Wikipedia and the Python Software Foundation are not discussed here.';
    expect(bannedNames(nasa).filter((name) => name.pattern.test(text))).toEqual([]);
  });
});

describe('readerStrings', () => {
  it('yields every string of a value, depth first, and never a citation handle', () => {
    expect([
      ...readerStrings({ title: 'A', cites: ['e1'], blocks: [{ text: 'B', cites: ['e2'] }, { items: ['C', 'D'] }] }),
    ]).toEqual(['A', 'B', 'C', 'D']);
  });
});
