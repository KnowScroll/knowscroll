import { describe, expect, it } from 'vitest';
import {
  NUMBER_DETAIL_FIGURES,
  NUMBER_DETAIL_PASSAGES,
  numberDetailOfTexts,
  numberDetailOfUnit,
  numberDetailOfValue,
  type PassageText,
} from './number-detail.js';

const passage = (handle: string, text: string): PassageText => ({ handle, text });
const text = (value: string) => [{ field: 'text', text: value }];

describe('numberDetailOfTexts (D-444)', () => {
  const E11 = passage(
    'e11',
    'In England and Wales, the proportion living in cities with more than 20,000 people jumped from 17% in 1801 to 54% in 1891.',
  );

  it('is undefined when every figure is stated by a cited passage', () => {
    expect(
      numberDetailOfTexts(text('The share jumped from 17% in 1801 to 54% in 1891.'), [E11], [E11]),
    ).toBeUndefined();
    expect(numberDetailOfTexts(text('No figures here at all.'), [E11], [E11])).toBeUndefined();
  });

  it('names the passages that state the figure, at most three, when the part does not cite them', () => {
    const offered = ['e1', 'e2', 'e3', 'e4', 'e5'].map((handle) =>
      passage(handle, `A kettle holds 2 litres, says ${handle}.`),
    );
    const cited = [passage('e9', 'Nothing numeric here, only words about boiling water.')];
    const detail = numberDetailOfTexts(text('A kettle holds 2 litres.'), cited, [...offered, ...cited]);
    expect(NUMBER_DETAIL_PASSAGES).toBe(3);
    expect(detail).toBe(
      'In the text, "2" is not in the passages this part cites, but e1, e2 or e3 states it that way: cite e1, e2 or e3.',
    );
  });

  it('says a figure is in none of the offered passages when none has the digits', () => {
    expect(numberDetailOfTexts(text('About 4821 kettles.'), [E11], [E11])).toBe(
      'In the text, "4821" is in none of the offered passages, so it is not in the research: take it out, or use a figure a passage states.',
    );
  });

  it('quotes the research’s words around a figure a cited passage writes another way, at most six words, and never the model’s', () => {
    const detail = numberDetailOfTexts(text('In 1801 the share was low, and it reached 54%.'), [E11], [E11]) ?? '';
    expect(detail).toBe(
      'In the text, "1801" is in e11, but only as one end of a range ("… from 17% in 1801 to 54% …"): a range counts only whole, so write both ends together, in the order the passage does, or say the figure in words. In the text, "54" is the other end of the same range: write the two together.',
    );
    expect(detail).not.toContain('low');
    expect(numberDetailOfTexts(text('By 1891 the share was 54%.'), [E11], [E11])).toContain(
      '"54" is in e11, but only as one end',
    );
  });

  it('names the part of each figure, groups one figure of two parts, and counts the figures beyond three', () => {
    const fields = [
      { field: 'caption', text: 'Roughly 5001 people, 5002 sheep and 5003 cows.' },
      { field: 'point 2 note', text: 'Also 5004 and 5001 again.' },
    ];
    const detail = numberDetailOfTexts(fields, [E11], [E11]) ?? '';
    expect(NUMBER_DETAIL_FIGURES).toBe(3);
    expect(detail.startsWith('In the caption and the point 2 note, "5001" is in none')).toBe(true);
    expect(detail).toContain('In the caption, "5002"');
    expect(detail).toContain('In the caption, "5003"');
    expect(detail.endsWith('(1 more figure not shown.)')).toBe(true);
    expect(detail).not.toContain('5004');
  });

  it('for a title or a dek, says which passage states the figure and that no part of the Scroll cites it', () => {
    const e1 = passage('e1', 'A typical element draws 3 kilowatts of power when it boils.');
    const detail = numberDetailOfTexts(text('An element that draws 3 kilowatts.'), [E11], [E11, e1], 'scroll');
    expect(detail).toBe(
      'In the text, "3" is in e1, which no part of the Scroll cites: cite e1 in a part of the Scroll, or take the figure out of this text.',
    );
  });

  it('does not put the model’s double quotes into a quotation of the research', () => {
    const quoted = passage('e2', 'It was called "the 8 to 9 million" by one writer of that age.');
    const detail = numberDetailOfTexts(text('Only 9 were there.'), [quoted], [quoted]) ?? '';
    expect(detail).toContain("'the 8 to 9 million'");
  });
});

describe('numberDetailOfValue and numberDetailOfUnit (D-444)', () => {
  const E11 = passage('e11', 'The proportion jumped from 17% in 1801 to 54% in 1891.');
  const point = (value: string, unit: 'million' | undefined, values: string[]) => ({
    value,
    magnitude: unit,
    values: new Set(values),
  });

  it('is undefined for a value a cited passage states the way the chart writes it, even as the end of a range the chart holds whole', () => {
    expect(numberDetailOfValue('point 1', point('17', undefined, ['17', '54']), [E11], [E11])).toBeUndefined();
    const range = passage('e1', 'It rose from 7 to 8.3 million people.');
    expect(numberDetailOfValue('point 2', point('8.3', 'million', ['7', '8.3']), [range], [range])).toBeUndefined();
  });

  it('tells the value that ends a range of a year, which no chart can hold whole, what the chart would need', () => {
    expect(numberDetailOfValue('point 2', point('54', undefined, ['17', '54']), [E11], [E11])).toBe(
      'The value of point 2, "54", is in e11, but only as one end of a range ("… in 1801 to 54% in 1891."): a chart value that ends a range passes only when the other end ("1801") is also one of the chart\'s values; if the other end is not something the chart plots (a year, a count), leave this point out and say the figure in words.',
    );
  });

  it('tells a value written without the magnitude word the unit opens with', () => {
    const bare = passage('e4', 'Some 8.3 people live there.');
    expect(numberDetailOfValue('point 1', point('8.3', 'million', ['8.3']), [bare], [bare])).toBe(
      'The value of point 1, "8.3", is in e4, but without the word "million" after it ("Some 8.3 people live …"): the unit must not open with "million".',
    );
  });

  it('names an unknown form the value cannot take', () => {
    const scaled = passage('e4', 'Some 8.3bn people live there.');
    expect(numberDetailOfValue('point 1', point('8.3', undefined, ['8.3']), [scaled], [scaled])).toBe(
      'The value of point 1, "8.3", is in e4, but written as "Some 8.3bn people live …", a form a chart value cannot take: leave the point out and say the figure in words.',
    );
  });

  it('names a unit word no cited passage writes, the sign the passages write, and a passage that does write the word', () => {
    expect(numberDetailOfUnit('percent', [E11], [E11])).toBe(
      'The unit "percent" has a word that no passage this chart cites writes: "percent". Use a unit made of the words of a cited passage (the passages write the sign "%"); the unit is not a figure and the values do not change.',
    );
    const other = passage('e7', 'About 12 percent of people moved.');
    expect(numberDetailOfUnit('percent', [E11], [E11, other])).toBe(
      'The unit "percent" has a word that no passage this chart cites writes: "percent". e7 writes it: cite it, or use a unit in the words of a cited passage (the passages write the sign "%").',
    );
    expect(numberDetailOfUnit('%', [E11], [E11])).toBeUndefined();
  });
});
