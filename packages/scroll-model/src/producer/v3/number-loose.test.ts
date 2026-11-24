import { describe, expect, it } from 'vitest';
import { compileInputFor, HEAT, STEAM, validReply, type Mutable } from '../../test-support/written-v3-fixtures.js';
import type { IssueV3 } from '../../v3/issues.js';
import { looseNumberIssuesV3 } from './number-loose.js';
import type { PassageText } from './number-detail.js';
import { compileWrittenV3 } from './written.js';
import type { WrittenItemV3, WrittenScrollV3 } from './written-schema.js';

type Change = (reply: WrittenScrollV3, input: Mutable) => void;

const plain = (reply: WrittenScrollV3): Record<string, unknown> =>
  JSON.parse(JSON.stringify(reply)) as Record<string, unknown>;

function para(reply: WrittenScrollV3, index: number): Extract<WrittenItemV3, { type: 'para' }> {
  const item = reply.items[index];
  if (item?.type !== 'para') throw new Error(`item ${index} is not a paragraph`);
  return item;
}

/** The compile's own figure findings of the reply, and the offered passages the compile was given, as the writer cites them. */
function compiledFindings(change: Change): { issues: IssueV3[]; offered: PassageText[]; reply: WrittenScrollV3 } {
  const reply = validReply();
  const input = compileInputFor(reply, (mutable) => change(mutable.reply, mutable));
  const outcome = compileWrittenV3(input);
  if (outcome.kind !== 'refused') throw new Error('expected a refusal');
  const offered = [...input.evidence.claimIdOf].map(([handle, claimId]) => ({
    handle,
    text: input.evidence.quoteOf.get(claimId) ?? '',
  }));
  return {
    issues: outcome.issues.filter((issue) => issue.code === 'authoring_number_not_in_evidence'),
    offered,
    reply: input.reply,
  };
}

/** Every fault of figures the loose rule is asked about at once: a miscited figure, a range end, an absent figure, a chart with a value and a unit. */
const FAULTS: Change = (reply, input) => {
  input.passages['c-steam'] = `${STEAM} Typical elements draw 3 kilowatts.`;
  input.passages['c-heat'] = `${HEAT} The share went from 17% in 1801 to 54% in 1891.`;
  para(reply, 2).text = `${para(reply, 2).text.split(' ').slice(0, 40).join(' ')} Typical elements draw 3 kilowatts.`;
  para(reply, 3).text = `${para(reply, 3).text.split(' ').slice(0, 40).join(' ')} By 1891 it was 54%.`;
  para(reply, 11).text = `${para(reply, 11).text.split(' ').slice(0, 40).join(' ')} Kettles sold last year: 4821.`;
  reply.pictures[1] = {
    kind: 'chart',
    title: 'People near kettles',
    cites: ['e2'],
    form: 'bars',
    unit: 'light years',
    values: 'shown',
    points: [
      { label: 'Town', value: '8.3' },
      { label: 'City', value: '9.1' },
    ],
    marks: [],
  };
  para(reply, 9).show = { picture: 2, upTo: 1 };
  delete para(reply, 10).links;
};

const byPath = (issues: readonly IssueV3[]): readonly IssueV3[] =>
  [...issues].sort((first, second) => first.path.localeCompare(second.path));

describe('looseNumberIssuesV3 (D-444)', () => {
  it('finds, in a reply read as plain JSON, the figure findings the compile gives, at the same paths and with the same detail', () => {
    const { issues, offered, reply } = compiledFindings(FAULTS);
    expect(issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(['items.2', 'items.3', 'items.11', 'pictures.1.unit', 'pictures.1.points.0.value']),
    );
    expect(byPath(looseNumberIssuesV3(plain(reply), offered))).toEqual(byPath(issues));
  });

  it('reads a reply the shape refuses (a chart written without its marks), which the compile never reads', () => {
    const { offered, reply } = compiledFindings(FAULTS);
    const refusedShape = plain(reply) as { pictures: Record<string, unknown>[] };
    delete refusedShape.pictures[1]?.['marks'];
    const found = looseNumberIssuesV3(refusedShape, offered);
    expect(found.map((issue) => issue.path)).toContain('items.2');
    expect(found.find((issue) => issue.path === 'items.2')?.detail).toBe(
      'In the text, "3" is not in the passages this part cites, but e3 states it that way: cite e3.',
    );
  });

  it('has nothing to say about a reply whose figures are stated', () => {
    const offered: PassageText[] = [
      { handle: 'e1', text: HEAT },
      { handle: 'e2', text: 'Pure water boils at 100 degrees Celsius at standard sea level pressure.' },
      { handle: 'e3', text: STEAM },
    ];
    expect(looseNumberIssuesV3(plain(validReply()), offered)).toEqual([]);
  });

  it('judges only against the handles that are offered, and leaves a handle that is not offered to its own finding', () => {
    const { offered, reply } = compiledFindings(FAULTS);
    const edited = plain(reply) as { items: Record<string, unknown>[] };
    const item = edited.items[2];
    if (item === undefined) throw new Error('no item');
    item['cites'] = ['e1', 'e99'];
    const found = looseNumberIssuesV3(edited, offered).find((issue) => issue.path === 'items.2');
    expect(found?.detail).toContain('e3 states it that way');
  });

  it('is empty for anything that is not an object, and ignores items that are not objects', () => {
    expect(looseNumberIssuesV3('text', [])).toEqual([]);
    expect(looseNumberIssuesV3(null, [])).toEqual([]);
    expect(looseNumberIssuesV3({ items: [1, 'x', null], pictures: [3] }, [])).toEqual([]);
  });

  it('does not read a chart value that is not a figure, which the reply shape refuses', () => {
    const { offered } = compiledFindings(FAULTS);
    const odd = {
      pictures: [
        { kind: 'chart', title: 'Odd', cites: ['e2'], unit: 'degrees', points: [{ label: 'A', value: 'about eight' }] },
      ],
    };
    expect(looseNumberIssuesV3(odd, offered)).toEqual([]);
  });
});
