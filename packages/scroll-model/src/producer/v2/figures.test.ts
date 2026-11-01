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
    expect(unstatedFigures('About 8.3 billion people watch it.', [DISTANCE])).toEqual(['8.3']);
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
