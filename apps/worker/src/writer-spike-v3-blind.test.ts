import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readBlindInputs,
  renderBlindPage,
  shuffleSeeded,
  writerSpikeV3BlindCommand,
  type BlindInput,
} from './writer-spike-v3-blind.js';

// CI fixtures only: invented essays about an invented pond, never product content.

/** The words of a fixture document, so a test can put markup in any of them. */
interface Words {
  readonly title: string;
  readonly dek?: string;
  readonly section?: string;
  readonly beat?: string;
  readonly quote?: string;
  readonly who?: string;
  readonly work?: string;
  readonly year?: string;
  readonly picture?: string;
  readonly aside?: string;
  readonly takeaway?: string;
}

/** A small valid document as plain data: two sections of two beats, a quotation, a picture one beat shows, an aside, a takeaway. */
function documentJson(words: Words): Record<string, unknown> {
  return {
    schemaVersion: 'scroll-document.v3',
    assetId: 'ci-asset',
    revision: 1,
    language: 'en',
    explanationUnitId: 'ci-unit',
    theme: { family: 'worlds' },
    kicker: 'A closer look',
    title: words.title,
    dek: words.dek ?? `The pond freezes from the top, and ${words.title} says why.`,
    shape: 'argument',
    framing: { kind: 'factual' },
    misconception: { kind: 'none' },
    pictures: [
      {
        id: 'p1',
        kind: 'statement',
        title: words.picture ?? 'Ice on the pond',
        statement: { form: 'number', value: '4°', label: 'Where the pond is densest' },
      },
    ],
    sections: [
      {
        id: 's1',
        title: words.section ?? 'Why the top freezes',
        beats: [
          {
            id: 'b1',
            kind: 'plain',
            text: words.beat ?? `Water is densest at a little above freezing in ${words.title}.`,
            simple: 'Water is heaviest when it is cool, not cold.',
            links: [],
            show: { picture: 'p1', state: {} },
          },
          {
            id: 'b2',
            kind: 'quote',
            text: words.quote ?? 'The coldest water floats.',
            simple: 'The coldest water floats.',
            links: [],
            cite: {
              who: words.who ?? 'An invented pond keeper',
              work: words.work ?? 'Notes from the Pond',
              year: words.year ?? '1999',
            },
          },
        ],
      },
      {
        id: 's2',
        title: 'What lives below',
        beats: [
          { id: 'b3', kind: 'plain', text: 'Fish stay in the deeper water.', simple: 'Fish stay deep.', links: [] },
          { id: 'b4', kind: 'plain', text: 'They wait for spring.', simple: 'They wait.', links: [] },
        ],
      },
    ],
    asides: [
      {
        id: 'a1',
        kind: 'limits',
        title: words.aside ?? 'Where this stops',
        text: words.aside ?? 'Small ponds behave differently.',
        anchorBeat: 'b2',
        collapsed: true,
      },
    ],
    takeaway: words.takeaway ?? 'Cold water floats, so a pond freezes from the top and stays liquid below.',
    askSuggestions: ['Why does ice float on water?'],
    limitsVersion: 'scroll-limits.v3',
    measures: {
      version: 'scroll-measures.v3',
      readingSeconds: 150,
      readingMinutes: 2.5,
      mainWords: 30,
      totalWeight: 40,
      beats: [
        { beatId: 'b1', weight: 10 },
        { beatId: 'b2', weight: 10 },
        { beatId: 'b3', weight: 10 },
        { beatId: 'b4', weight: 10 },
      ],
    },
    integrity: { method: 'canonical-json-sha256.v1', sha256: 'a'.repeat(64) },
  };
}

/** The line `writer-spike-v3 --out` writes for an accepted job. */
const outLine = (key: string, arm: string, document: unknown): string =>
  `${JSON.stringify({ key, arm, spikeId: 'ci', document, citations: {} })}\n`;

/** A document as the blind page reads it: through the same schema as a line of an `--out` file. */
function blindInput(key: string, arm: string, words: Words): BlindInput {
  const [input] = readBlindInputs(outLine(key, arm, documentJson(words))).inputs;
  if (input === undefined) throw new Error('the fixture document must be valid');
  return input;
}

const inputs = (): BlindInput[] => [
  blindInput('seasons', 'a', { title: 'The first pond essay' }),
  blindInput('seasons', 'b', { title: 'The second pond essay' }),
  blindInput('dns-lookup', 'a', { title: 'The third pond essay' }),
  blindInput('dns-lookup', 'b', { title: 'The fourth pond essay' }),
];

const lettersInOrder = (html: string): string[] =>
  [...html.matchAll(/Essay ([A-Z])<\/p>/gu)].map((match) => match[1] ?? '');
const titlesInOrder = (html: string): string[] =>
  [...html.matchAll(/<h2>([^<]*)<\/h2>/gu)].map((match) => match[1] ?? '');

describe('the blind-read page', () => {
  it('labels the essays A, B, C and D and puts nothing about the arm, the recipe, a run or a model on the page', () => {
    const { html } = renderBlindPage(inputs(), 7);
    expect(lettersInOrder(html)).toEqual(['A', 'B', 'C', 'D']);
    for (const word of ['seasons', 'dns-lookup', 'minimax', 'prose', 'staging', 'spike', 'run id'])
      expect(html.toLowerCase(), word).not.toContain(word);
    expect(html).not.toMatch(/\b(?:arm|recipe|model|seed)\b/iu);
    expect(html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/u);
  });

  it('maps each letter to a recipe and an arm in a key apart from the page, a shuffle of the input', () => {
    const { key, html } = renderBlindPage(inputs(), 7);
    expect(Object.keys(key)).toEqual(['A', 'B', 'C', 'D']);
    expect(
      Object.values(key)
        .map((entry) => `${entry.key}.${entry.arm}`)
        .sort(),
    ).toEqual(['dns-lookup.a', 'dns-lookup.b', 'seasons.a', 'seasons.b']);
    // The letter's essay is the document the key says it is.
    const byTitle = new Map(inputs().map((input) => [input.document.title, `${input.key}.${input.arm}`]));
    titlesInOrder(html).forEach((title, index) =>
      expect(byTitle.get(title)).toBe(`${Object.values(key)[index]?.key}.${Object.values(key)[index]?.arm}`),
    );
  });

  it('is shuffled by the seed: the same seed gives the same order, and the seeds give more than one order', () => {
    const orders = new Set<string>();
    for (let seed = 0; seed < 12; seed += 1) {
      const first = renderBlindPage(inputs(), seed);
      expect(renderBlindPage(inputs(), seed)).toEqual(first);
      orders.add(JSON.stringify(first.key));
    }
    expect(orders.size).toBeGreaterThan(3);
    expect(shuffleSeeded([1, 2, 3, 4, 5, 6], 3)).toEqual(shuffleSeeded([1, 2, 3, 4, 5, 6], 3));
    expect([...shuffleSeeded([1, 2, 3, 4, 5, 6], 3)].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('shows the title, dek, section titles, each beat in order, a quotation with who, work and year, an aside, the takeaway', () => {
    const { html } = renderBlindPage([inputs()[0] as BlindInput], 1);
    const order = [
      '<h2>The first pond essay</h2>',
      'The pond freezes from the top',
      '<h3>Why the top freezes</h3>',
      'Water is densest at a little above freezing',
      '<blockquote>',
      'The coldest water floats.',
      'An invented pond keeper, <cite>Notes from the Pond</cite>, 1999',
      'Aside',
      'Small ponds behave differently.',
      '<h3>What lives below</h3>',
      'Fish stay in the deeper water.',
      'They wait for spring.',
      '<h3>To sum up</h3>',
      'Cold water floats, so a pond freezes from the top',
    ];
    let at = -1;
    for (const part of order) {
      const found = html.indexOf(part, at + 1);
      expect(found, part).toBeGreaterThan(at);
      at = found;
    }
    // The aside sits right after the beat it belongs to, before the next section.
    expect(html.indexOf('Small ponds behave differently.')).toBeLessThan(html.indexOf('What lives below'));
  });

  it('draws a picture a beat shows as a boxed line of its title and its words', () => {
    const { html } = renderBlindPage([inputs()[0] as BlindInput], 1);
    expect(html).toContain('<p class="picture"><strong>Picture: Ice on the pond</strong>');
    // The words are what a screen reader hears: the figure and what it is.
    expect(html).toMatch(/<strong>Picture: Ice on the pond<\/strong> [^<]*4°/u);
    expect(html).toContain('Where the pond is densest');
    // Once: only the beat that shows it has the box.
    expect(html.match(/class="picture"/gu)).toHaveLength(1);
  });

  it('escapes every string of a document, so a title or a beat can carry no markup', () => {
    const evil = '<script>alert("x")</script> & <img src=x onerror=alert(1)>';
    const { html } = renderBlindPage(
      [
        blindInput('seasons', 'a', {
          title: evil,
          dek: `${evil} dek`,
          section: evil,
          beat: evil,
          quote: evil,
          who: evil,
          work: evil,
          year: '<b>1</b>',
          picture: evil,
          aside: evil,
          takeaway: `Takeaway ${evil} takeaway.`,
        }),
      ],
      1,
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).toContain(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &lt;img src=x onerror=alert(1)&gt;',
    );
  });

  it('is one self-contained file: no network, no script, system fonts, a phone viewport and a dark mode', () => {
    const { html } = renderBlindPage(inputs(), 1);
    expect(html).toMatch(/^<!doctype html>/u);
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).toContain('system-ui');
    for (const outside of ['http:', 'https:', '<script', '<link', ' src=', '@import', 'url(', '<iframe'])
      expect(html, outside).not.toContain(outside);
  });

  it('holds at most twenty-six essays, one letter each', () => {
    const many = Array.from({ length: 27 }, () => inputs()[0] as BlindInput);
    expect(() => renderBlindPage(many, 1)).toThrow(/26/u);
    expect(lettersInOrder(renderBlindPage(many.slice(0, 26), 1).html)).toHaveLength(26);
  });
});

describe('the accepted documents of an --out file', () => {
  const line = (record: unknown): string => `${JSON.stringify(record)}\n`;
  const accepted = (key: string, arm: string, title: string) => outLine(key, arm, documentJson({ title }));

  it('read one JSON line each, and count the lines that are not a document of an arm', () => {
    const text = [
      accepted('seasons', 'a', 'The first pond essay'),
      'not json\n',
      line({ key: 'seasons', arm: 'a', document: { schemaVersion: 'scroll-document.v3' } }),
      outLine('seasons', 'c', documentJson({ title: 'The first pond essay' })),
      '\n',
      accepted('dns-lookup', 'b', 'The second pond essay'),
    ].join('');
    const { inputs: read, skipped } = readBlindInputs(text);
    expect(read.map((input) => `${input.key}.${input.arm}`)).toEqual(['seasons.a', 'dns-lookup.b']);
    expect(skipped).toBe(3);
  });
});

describe('content writer-spike-v3-blind', () => {
  let folder: string;
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'ks-blind-'));
  });
  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });
  const refuse = () => {
    throw new Error('CI: this command logs nothing when it succeeds or refuses');
  };

  it('writes the page and the key, prints the seed and no arm, and gives the same page for the same seed', async () => {
    const source = join(folder, 'out.jsonl');
    await writeFile(
      source,
      inputs()
        .map(
          (input) =>
            `${JSON.stringify({ key: input.key, arm: input.arm, spikeId: 'ci', document: input.document, citations: {} })}\n`,
        )
        .join(''),
    );
    const printed: Record<string, unknown>[] = [];
    const run = (page: string, key: string) =>
      writerSpikeV3BlindCommand(
        { in: source, page: join(folder, page), key: join(folder, key), seed: '11' },
        (line) => void printed.push(line),
        refuse,
      );
    expect(await run('page.html', 'key.json')).toBe(0);
    expect(await run('page2.html', 'key2.json')).toBe(0);
    expect(printed[0]).toEqual({
      command: 'content writer-spike-v3-blind',
      result: 'written',
      essays: 4,
      skipped: 0,
      seed: 11,
    });
    expect(JSON.stringify(printed)).not.toContain('seasons');
    const html = await readFile(join(folder, 'page.html'), 'utf8');
    expect(html).toBe(await readFile(join(folder, 'page2.html'), 'utf8'));
    const key = JSON.parse(await readFile(join(folder, 'key.json'), 'utf8')) as Record<
      string,
      { key: string; arm: string }
    >;
    expect(Object.keys(key)).toEqual(['A', 'B', 'C', 'D']);
    expect(Object.values(key).every((entry) => ['seasons', 'dns-lookup'].includes(entry.key))).toBe(true);
    expect(html).not.toContain('seasons');
  });

  it('prints the usage and exits 2 without a file, with the same file twice, or with a seed that is not a number', async () => {
    const printed: Record<string, unknown>[] = [];
    const print = (line: Record<string, unknown>) => void printed.push(line);
    const same = join(folder, 'same');
    for (const options of [
      { in: undefined, page: join(folder, 'p'), key: join(folder, 'k'), seed: undefined },
      { in: join(folder, 'in'), page: undefined, key: join(folder, 'k'), seed: undefined },
      { in: join(folder, 'in'), page: same, key: same, seed: undefined },
      { in: join(folder, 'in'), page: join(folder, 'p'), key: join(folder, 'k'), seed: 'abc' },
      { in: join(folder, 'in'), page: join(folder, 'p'), key: join(folder, 'k'), seed: '-1' },
      { in: join(folder, 'p'), page: join(folder, 'p'), key: join(folder, 'k'), seed: undefined },
    ])
      expect(await writerSpikeV3BlindCommand(options, print, refuse)).toBe(2);
    expect(printed.every((line) => line.result === 'usage')).toBe(true);
  });

  it('refuses a file with no usable essay and writes neither file', async () => {
    const source = join(folder, 'empty.jsonl');
    await writeFile(source, 'not json\n');
    const printed: Record<string, unknown>[] = [];
    const code = await writerSpikeV3BlindCommand(
      { in: source, page: join(folder, 'page.html'), key: join(folder, 'key.json'), seed: undefined },
      (line) => void printed.push(line),
      refuse,
    );
    expect(code).toBe(2);
    expect(printed[0]).toMatchObject({ result: 'no_usable_essays', skipped: 1, found: 0 });
    await expect(readFile(join(folder, 'page.html'))).rejects.toThrow();
    await expect(readFile(join(folder, 'key.json'))).rejects.toThrow();
  });
});
