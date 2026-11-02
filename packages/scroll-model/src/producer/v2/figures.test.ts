import { describe, expect, it } from 'vitest';
import { unstatedFigures } from './figures.js';

/** CI fixtures: invented passages, never library text. */
const DRIFT = 'The satellite drifts away from its planet by about 3.8 centimetres every year.';
const DISTANCE =
  'At its closest the satellite is 361,000 kilometres from the planet, and 8.3 million people watch it rise.';

describe('the figures of a text that the passages do not state (D-208)', () => {
  it('finds nothing when every figure is a passage’s own', () => {
    expect(unstatedFigures('It moves away about 3.8 centimetres a year.', [DRIFT])).toEqual([]);
    expect(unstatedFigures('Words only, with no number at all.', [DRIFT])).toEqual([]);
  });

  it('finds a figure that no passage holds', () => {
    expect(unstatedFigures('The satellite moves away by 1.25 million metres each second.', [DRIFT, DISTANCE])).toEqual([
      '1.25',
    ]);
  });

  it('reads a figure the way a person does: thousands separators are dropped on both sides', () => {
    expect(unstatedFigures('It can be 361000 kilometres away.', [DISTANCE])).toEqual([]);
    expect(unstatedFigures('It can be 361,000 kilometres away.', ['The gap is 361000 kilometres.'])).toEqual([]);
    expect(unstatedFigures('It can be 361,001 kilometres away.', [DISTANCE])).toEqual(['361001']);
  });

  it('holds a figure to the word the passage writes after it', () => {
    // The passage has "8.3 million", so a bare 8.3 is a million times too small, and 8.3 million is its own.
    expect(unstatedFigures('About 8.3 million people watch it.', [DISTANCE])).toEqual([]);
    expect(unstatedFigures('About 8.3 people watch it.', [DISTANCE])).toEqual(['8.3']);
    // The word is a figure too: no passage writes "billion".
    expect(unstatedFigures('About 8.3 billion people watch it.', [DISTANCE])).toEqual(['8.3', 'billion']);
  });

  it('refuses a scaler the passage did not write, and a range whose other end differs', () => {
    expect(unstatedFigures('About 8.3m people watch it.', [DISTANCE])).toEqual(['8.3']);
    expect(unstatedFigures('Between 8 to 10 million people.', ['Between 8 to 10 million people.'])).toEqual([]);
    expect(unstatedFigures('Between 8 to 12 million people.', ['Between 8 to 10 million people.'])).toEqual([
      '8',
      '12',
    ]);
  });

  it('lists each unstated figure once, in the order of the text', () => {
    expect(unstatedFigures('It is 7 and 9 and 7 again.', [DRIFT])).toEqual(['7', '9']);
  });

  it('does not let a numeral the matcher cannot read slip past as a word', () => {
    expect(unstatedFigures('It moves ½ a metre.', [DRIFT])).toEqual(['½']);
    expect(unstatedFigures('It moves ½ a metre.', ['The passage says ½ a metre.'])).toEqual([]);
    expect(unstatedFigures('An area of 3²', ['An area of 3 squared.'])).toEqual(['²']);
  });
});

describe('the sign of a figure (D-302)', () => {
  const COLD =
    'The night side of the satellite falls to -3.8 degrees, and the day side rises to 3.8 degrees above that.';

  it('keeps a minus sign: "-3.8" is not "3.8"', () => {
    expect(unstatedFigures('It falls to -3.8 degrees.', [COLD])).toEqual([]);
    expect(unstatedFigures('It rises to 3.8 degrees.', [COLD])).toEqual([]);
    expect(unstatedFigures('It falls to -3.8 degrees.', [DRIFT])).toEqual(['-3.8']);
    expect(unstatedFigures('It falls to −3.8 degrees.', ['It rises to 3.8 degrees.'])).toEqual(['-3.8']);
    expect(unstatedFigures('It rises to 3.8 degrees.', ['It falls to −3.8 degrees.'])).toEqual(['3.8']);
  });

  it('reads the minus sign in any of its spellings the same way', () => {
    expect(unstatedFigures('It falls to −3.8 degrees.', ['It falls to -3.8 degrees.'])).toEqual([]);
  });

  it('does not take the dash of a range, or the hyphen of a word, for a sign', () => {
    expect(unstatedFigures('Between 8-10 million people.', ['Between 8-10 million people.'])).toEqual([]);
    expect(unstatedFigures('The 8–10 million people.', ['The 8-10 million people.'])).toEqual([]);
    expect(unstatedFigures('A type-3 event.', ['A type 3 event.'])).toEqual([]);
  });
});

describe('numbers written in words (D-302)', () => {
  const PASSAGE =
    'The satellite is a long way off. Light takes about one second to cross twenty centimetres of the old glass, and there are two bulges on the water.';

  it('finds a magnitude word that no passage uses', () => {
    expect(unstatedFigures('It moves away a million times a year.', [DRIFT])).toEqual(['million', 'a million']);
    expect(unstatedFigures('It has lasted a thousand years.', [DRIFT])).toEqual(['thousand', 'a thousand']);
    expect(unstatedFigures('Hundreds of satellites do this.', [DRIFT])).toEqual(['hundred']);
  });

  it('finds a number in words with a unit that no passage holds in those words', () => {
    expect(
      unstatedFigures('It moves away by one point two five million metres each second.', [DRIFT, DISTANCE]),
    ).toEqual(['one point two five million']);
    expect(unstatedFigures('It crosses forty centimetres.', [PASSAGE])).toEqual(['forty']);
  });

  it('states what a passage holds in the same words, and a magnitude word it uses itself', () => {
    expect(unstatedFigures('Light takes one second to cross twenty centimetres.', [PASSAGE])).toEqual([]);
    expect(unstatedFigures('It takes about one second.', [PASSAGE])).toEqual([]);
    // "million" is in the passage, so the word is stated; the digits are checked as always.
    expect(unstatedFigures('About eight million people watch it.', [DISTANCE])).toEqual([]);
  });

  it('holds a number in words to the passage even when the passage writes it in digits', () => {
    expect(unstatedFigures('It drifts three point eight centimetres a year.', [DRIFT])).toEqual(['three point eight']);
  });

  it('leaves alone a number word that is not a measurement', () => {
    expect(unstatedFigures('One clear example is the tide.', [DRIFT])).toEqual([]);
    expect(unstatedFigures('There are two bulges.', [DRIFT])).toEqual([]);
    expect(unstatedFigures('Neither of the three of them knew.', [DRIFT])).toEqual([]);
  });

  it('reads a plural magnitude word as its singular, and a hyphenated number as its words', () => {
    expect(unstatedFigures('Millions watch it.', ['A million watch it.'])).toEqual([]);
    expect(unstatedFigures('It is twenty-one metres wide.', ['It is twenty-one metres wide.'])).toEqual([]);
    expect(unstatedFigures('It is twenty-two metres wide.', ['It is twenty-one metres wide.'])).toEqual(['twenty two']);
  });
});
