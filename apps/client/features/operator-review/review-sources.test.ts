import { fixtureDocument, fixtureShow } from './review-fixtures';
import { sourcesIndexOf } from './review-sources';

describe('where the cited passages go on the page', () => {
  const index = sourcesIndexOf(fixtureDocument, fixtureShow().parts);

  it('puts a beat’s own passages under it, named by its place and first words', () => {
    const [part] = index.under('b1');
    expect(part?.label).toBe('Beat 1: On the last night of August…');
    expect(part?.passages).toEqual([
      { quote: 'The first cases came on the last night of August.', source: 'A labelled fixture page' },
    ]);
  });

  it('puts an aside’s passages under the beat it is anchored to, after the beat’s own', () => {
    expect(index.under('b5').map((part) => part.label)).toEqual(['Aside: A drawn plan, not the map']);
    expect(index.under('b5')[0]?.passages[0]?.quote).toBe('The plan was drawn by hand.');
  });

  it('leaves a beat that cites nothing with no sources, and an unknown id with none', () => {
    expect(index.under('b3')).toEqual([]);
    expect(index.under('not-a-beat')).toEqual([]);
  });

  it('keeps what no beat carries (a picture, the end summary) for the end, in the order given', () => {
    expect(index.rest.map((part) => part.label)).toEqual(['Picture: Soho, 31 August to 9 September 1854', 'To sum up']);
  });

  it('names any part, for a sentence the support check points at', () => {
    expect(index.labelOf('takeaway')).toBe('To sum up');
    expect(index.labelOf('b2')).toMatch(/^Beat 2: /);
    expect(index.labelOf('somewhere-else')).toBe('somewhere-else');
  });
});
