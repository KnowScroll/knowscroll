import { describe, expect, it } from 'vitest';
import { compileInputFor, HEAT, BOIL, PAGE, STEAM, validReply } from '../../test-support/written-v3-fixtures.js';
import type { IssueV3 } from '../../v3/issues.js';
import { copyDetailV3 } from './copy-detail.js';
import { looseCopyIssuesV3 } from './copy-loose.js';
import { compileWrittenV3 } from './written.js';
import type { WrittenScrollV3 } from './written-schema.js';

const SOURCES = [HEAT, BOIL, STEAM, PAGE];
const HEAT_RUN = 'The element of a kettle turns the electric current that';
const STEAM_RUN = 'Many kettles switch themselves off when a bimetallic strip senses';
const PAGE_RUN = 'A long page about the history of the teapot and';

const plain = (reply: WrittenScrollV3): Record<string, unknown> =>
  JSON.parse(JSON.stringify(reply)) as Record<string, unknown>;

/** The reply with a copy in a paragraph, a simpler text, a picture caption and a step note, and one in the title. */
function copying(): WrittenScrollV3 {
  const reply = validReply();
  const text = reply.items[11];
  const simple = reply.items[12];
  const picture = reply.pictures[0];
  if (text?.type !== 'para' || simple?.type !== 'para' || picture?.kind !== 'flow') throw new Error('fixture layout');
  text.text = `${text.text} Note that ${HEAT_RUN} into the cold.`;
  simple.simple = `${simple.simple} Also ${STEAM_RUN} the steam.`;
  picture.caption = `${PAGE_RUN} the samovar`;
  const step = picture.steps[1];
  if (step === undefined) throw new Error('fixture layout');
  step.note = HEAT_RUN;
  reply.title = `A kettle: ${PAGE_RUN}`;
  return reply;
}

const byPath = (issues: readonly IssueV3[]) =>
  [...issues].filter((issue) => issue.code === 'copied_passage').sort((a, b) => a.path.localeCompare(b.path));

describe('looseCopyIssuesV3', () => {
  it('finds, at the same paths and with the same detail, what the compile finds in a valid reply', () => {
    const reply = copying();
    const outcome = compileWrittenV3(compileInputFor(reply));
    if (outcome.kind !== 'refused') throw new Error('expected a refusal');
    const strict = byPath(outcome.issues);
    expect(strict.map((issue) => issue.path)).toEqual(['items.11', 'items.12', 'pictures.0', 'title']);
    expect(byPath(looseCopyIssuesV3(plain(reply), SOURCES))).toEqual(strict);
  });

  it('finds the copy of a reply the shape refuses, which the compile never reads (a chart without its marks)', () => {
    const reply = plain(copying());
    const pictures = reply['pictures'] as Record<string, unknown>[];
    pictures[1] = {
      kind: 'chart',
      title: 'People near kettles',
      cites: ['e2'],
      form: 'bars',
      values: 'shown',
      points: [
        { label: 'Town', value: '8.3' },
        { label: 'City', value: '9.1' },
      ],
    };
    const found = looseCopyIssuesV3(reply, SOURCES);
    expect(found.map((issue) => issue.path).sort()).toEqual(['items.11', 'items.12', 'pictures.0', 'title']);
    expect(found.find((issue) => issue.path === 'items.12')?.detail).toBe(
      copyDetailV3([{ field: 'simpler text', run: STEAM_RUN.toLowerCase() }]),
    );
  });

  it('leaves a quotation, a chart value and the references of a picture alone', () => {
    const reply = plain(validReply());
    const items = reply['items'] as Record<string, unknown>[];
    items[2] = {
      type: 'quote',
      text: HEAT,
      simple: 'The hot part of a kettle makes heat.',
      who: 'A. Writer',
      cites: ['e1'],
    };
    (reply['pictures'] as Record<string, unknown>[])[1] = {
      kind: 'statement',
      title: 'One quotation',
      cites: ['e1'],
      statement: { form: 'quote', text: HEAT, who: 'A. Writer' },
    };
    expect(looseCopyIssuesV3(reply, SOURCES)).toEqual([]);
  });

  it('finds nothing in a valid reply without a copy, and nothing in what is not an object', () => {
    expect(looseCopyIssuesV3(plain(validReply()), SOURCES)).toEqual([]);
    for (const value of [null, undefined, 'text', 4, [], [{ items: [] }]])
      expect(looseCopyIssuesV3(value, SOURCES)).toEqual([]);
    expect(looseCopyIssuesV3({ items: [null, 3, { type: 'para', text: 4 }], pictures: [null, 'x'] }, SOURCES)).toEqual(
      [],
    );
  });
});
