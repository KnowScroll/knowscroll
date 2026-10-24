import { describe, expect, it } from 'vitest';
import { AuthoredScroll } from '@knowscroll/scroll-model/producer';
import { extractResearch } from '../../../infrastructure/research/public-pages.js';
import { evidencePassages } from './evidence.js';
import {
  compileGeneratedScroll,
  generatedProvenance,
  libraryIdentity,
  writerFormatOf,
  writerInstructions,
  writerRole,
  WRITER_PROMPT_VERSION,
  type WriterFormat,
} from './writer.js';

// Authored CI fixtures only: an invented lighthouse, never provider output or product content.
const SOURCE = [
  'The Skerry lighthouse keeper winds the lamp clockwork every four hours through the long winter nights.',
  'A prism ring around the flame gathers the light into a single beam that sweeps across the water.',
  'Sailors count the seconds between flashes to learn which lighthouse they are approaching on the coast.',
  'Fog signals complement the beam, because light cannot cross a thick bank of fog for any useful distance.',
  'Today the clockwork has been replaced by a small motor, though the prisms are still the original glass.',
];
const page = extractResearch(
  `<html><title>Fixture</title><main>${SOURCE.map((text) => `<p>${text}</p>`).join('')}</main></html>`,
  'https://science.nasa.gov/earth/earth-facts/',
  '2026-10-20T00:00:00.000Z',
);
const passages = evidencePassages([page]);
const provenance = generatedProvenance({
  identity: libraryIdentity('seasons'),
  runId: 'ci-writer-run',
  attemptIds: ['ci-attempt'],
  model: 'MiniMax-M3.1-Flash',
  passages,
  pages: [page],
});

const prose = (text: string, cites: string[]) => ({ type: 'paragraph' as const, cites, text });
const BODY = [
  prose(
    'Ships need a way to know where the land begins long before they can see it, and a tall lamp answers that need.',
    ['e1', 'e2'],
  ),
  prose(
    'Glass rings bend the glow into a narrow ribbon, and because the ribbon turns a watcher sees it only briefly.',
    ['e2', 'e3'],
  ),
  prose(
    'Someone had to keep that rotation going, and in earlier times a keeper climbed the stairs on a fixed schedule.',
    ['e1', 'e5'],
  ),
  prose(
    'Thick fog scatters light in every direction, so the beam dissolves after a short distance however clever its glass.',
    ['e4'],
  ),
  prose('Put together, a shaped beam, a signature rhythm and a backup for bad weather make one small coastal system.', [
    'e2',
    'e3',
    'e4',
  ]),
];
const comparison = {
  type: 'comparison' as const,
  cites: ['e2', 'e4'],
  title: 'Clear night and fog',
  columns: ['Clear', 'Fog'],
  rows: [
    ['The beam travels far', 'The beam fades early'],
    ['Flashes can be counted', 'Sound signals take over'],
  ],
};
const scroll = (blocks: AuthoredScroll['blocks'], title = 'How a lighthouse guides ships') =>
  AuthoredScroll.parse({
    title,
    dek: 'A shaped beam, a rhythm and a dependable rotation turn one lamp into a coastal signal.',
    blocks: [{ type: 'heading', text: 'The beam' }, ...blocks],
  });

describe('the writer instructions', () => {
  const formats: readonly [WriterFormat, string][] = [
    ['comparison', '"type":"comparison"'],
    ['diagram', '"type":"diagram"'],
    ['simulation', '"type":"simulation"'],
    ['chart', '"type":"bar-chart"'],
    ['timeline', '"type":"timeline"'],
    ['sequence', '"type":"sequence"'],
  ];

  it.each(formats)('describe the %s format and only the blocks it may use', (format, marker) => {
    const text = writerInstructions(format);
    expect(text).toContain(marker);
    expect(text).toContain('"type":"heading"');
    expect(text).toContain('THIS RECIPE.');
    for (const [other, otherMarker] of formats)
      if (other !== format && other !== 'chart') expect(text).not.toContain(otherMarker);
    expect(text.length).toBeLessThan(16_000);
  });

  it('give the writer the contract: flat blocks, citations, original wording, no numbers it cannot support', () => {
    const text = writerInstructions('diagram');
    for (const rule of [
      '"blocks":[block, block, …]',
      'Every block carries "cites"',
      'never use more than five words in a row from a passage',
      'Put technical definitions, counts and lists',
      'A number may appear only if a cited passage states it',
      'Never name the source',
    ])
      expect(text).toContain(rule);
  });

  it('pick the format a recipe names, else a diagram for interactive recipes and a comparison otherwise', () => {
    expect(writerFormatOf({ interactive: true })).toBe('diagram');
    expect(writerFormatOf({ interactive: false })).toBe('comparison');
    expect(writerFormatOf({ interactive: true, interactiveKind: 'simulation' })).toBe('simulation');
  });
});

describe('generated provenance', () => {
  it('offers every passage as a candidate claim and every page to the copy check', () => {
    expect(provenance.claims.map((claim) => claim.statement)).toEqual(passages.map((passage) => passage.text));
    expect(provenance.material).toEqual([SOURCE.join('\n')]);
    expect(provenance.sources[0]).toMatchObject({ sourceId: page.id, snapshotSha256: page.sha256 });
    expect(provenance.production).toMatchObject({ kind: 'model', promptVersion: WRITER_PROMPT_VERSION });
    expect(provenance.publication.targetMinutes).toEqual([2, 8]);
  });
});

describe('compileGeneratedScroll', () => {
  // About 190 words of prose is the least that reads in two minutes with a comparison block.
  const longProse = (text: string, cites: string[]) =>
    prose(`${text} ${'The same idea is worth saying twice in a different way. '.repeat(6)}`.trim(), cites);
  const full = (extra: AuthoredScroll['blocks'] = [comparison], title?: string) =>
    scroll([...BODY.map((block) => longProse(block.text, block.cites)), ...extra], title);

  it('requires the block the recipe asks for, at the document', () => {
    const outcome = compileGeneratedScroll(full([]), provenance, passages, 'comparison');
    expect(outcome).toMatchObject({ kind: 'refused' });
    expect(outcome.kind === 'refused' && outcome.issues).toContainEqual({ code: 'format_required', path: '$' });
  });

  const refusedAt = (blocks: AuthoredScroll['blocks'], title?: string) => {
    const outcome = compileGeneratedScroll(full(blocks, title), provenance, passages, 'comparison');
    return outcome.kind === 'refused' ? outcome.issues : [];
  };
  const lastIndex = full([comparison, prose('x', ['e1'])]).blocks.length - 1;

  it('never lets a reader see the source’s organisation or its address', () => {
    const named = (text: string) => refusedAt([comparison, prose(text, ['e1', 'e2'])]);
    expect(named('NASA explains this in detail elsewhere, and so does the usual coastal handbook.')).toContainEqual({
      code: 'source_name_nasa',
      path: `blocks.${lastIndex}`,
    });
    expect(
      named('The National Aeronautics and Space Administration keeps a fine record of such lamps.'),
    ).toContainEqual({
      code: 'source_name_national_aeronautics_and_space_administration',
      path: `blocks.${lastIndex}`,
    });
    expect(named('More is written at science.nasa.gov for anyone who is curious about lamps.')).toContainEqual({
      code: 'source_name_science_nasa_gov',
      path: `blocks.${lastIndex}`,
    });
    expect(refusedAt([comparison], 'What nasa says about lamps')).toContainEqual({
      code: 'source_name_nasa',
      path: 'title',
    });
  });

  it('writes the word to remove into the repair hint, from a fixed list and not from the answer', () => {
    const hints = writerRole({ provenance, passages, format: 'comparison' }).safeCustomIssues ?? {};
    expect(hints['source_name_nasa']).toBe(
      'Remove the name "NASA" from this text. Never name the source or its publisher.',
    );
    expect(hints['source_name_science_nasa_gov']).toBe('Remove the web address "science.nasa.gov" from this text.');
    // A publisher that none of the offered sources belongs to has no entry: it is an ordinary name there.
    expect(hints).not.toHaveProperty('source_name_wikipedia');
  });

  it('allows ordinary words that happen to be part of a host name, and names of other organisations', () => {
    const ordinary = refusedAt([
      comparison,
      prose(
        'The science of lamps is old, and an ocean service for ships once relied on a developer of better glass. Wikipedia and the Python Software Foundation are not discussed here.',
        ['e1', 'e2'],
      ),
    ]);
    expect(ordinary.filter((issue) => issue.code.startsWith('source_name_'))).toEqual([]);
  });

  it('refuses a block type the recipe does not allow, at the block, even when the document is otherwise sound', () => {
    const timeline = {
      type: 'timeline' as const,
      cites: ['e1', 'e3'],
      title: 'A short history of the lamp',
      events: [
        { when: 'Earlier', title: 'A keeper winds the clockwork', detail: 'Every few hours through the night.' },
        { when: 'Today', title: 'A small motor turns the lamp' },
      ],
    };
    const issues = refusedAt([comparison, timeline]);
    expect(issues).toContainEqual({ code: 'block_type_not_allowed', path: `blocks.${lastIndex}` });
    // The same block is allowed when the recipe asks for a timeline.
    const asked = compileGeneratedScroll(full([timeline]), provenance, passages, 'timeline');
    expect(asked.kind === 'refused' && asked.issues.map((issue) => issue.code)).not.toContain('block_type_not_allowed');
  });

  it('compiles, admits and describes a Scroll that follows the contract', () => {
    const outcome = compileGeneratedScroll(full(), provenance, passages, 'comparison');
    if (outcome.kind !== 'compiled') throw new Error(JSON.stringify(outcome));
    expect(outcome.explanationUnitId).toBe('legacy-cutroom-seasons-v5');
    expect(outcome.documentVersion).toBe('scroll-document.v1');
    expect(outcome.readingFacts.totalWeight).toBeGreaterThan(0);
    expect(outcome.document).not.toHaveProperty('claims');
  });
});

describe('the writer role', () => {
  const role = writerRole({ provenance, passages, format: 'comparison' });

  it('is the stable content.scroll-writer role with one call, thinking room and fixed repair hints', () => {
    expect(role).toMatchObject({
      id: 'content.scroll-writer',
      version: WRITER_PROMPT_VERSION,
      maxOutputTokens: 16_000,
    });
    expect(role.effort).toBe('medium');
    expect(Object.isFrozen(role.safeCustomIssues)).toBe(true);
    expect(role.safeCustomIssues?.['copied_passage']).toContain('Rewrite only the sentences of this block');
    expect(Object.keys(role.safeCustomIssues ?? {})).toEqual(
      expect.arrayContaining([
        'format_required',
        'block_type_not_allowed',
        'source_name_nasa',
        'authoring_number_not_in_evidence',
      ]),
    );
    expect(role.instructions.length).toBeLessThan(32_768);
  });

  it('reports structure and semantic findings at the authored block with fixed codes only', () => {
    const missingCites = role.outputSchema.safeParse({
      title: 'How a lighthouse guides ships',
      dek: 'A shaped beam, a rhythm and a dependable rotation turn one lamp into a coastal signal.',
      blocks: [{ type: 'paragraph', text: 'No citations here.' }],
    });
    expect(missingCites.success).toBe(false);
    expect(missingCites.error?.issues[0]?.path).toEqual(['blocks', 0, 'cites']);

    const copied = role.outputSchema.safeParse(
      scroll([...BODY, prose(`${SOURCE[1]} And then some more words of its own.`, ['e2', 'e3'])]),
    );
    expect(copied.success).toBe(false);
    const issue = copied.error?.issues.find(
      (entry) => (entry as { params?: { safeCode?: string } }).params?.safeCode === 'copied_passage',
    );
    expect(issue?.path).toEqual(['blocks', 6]);
  });

  describe('repair notes: the copied words, named for the one repair', () => {
    const copiedAnswer = (overrides: { readonly extra?: string } = {}) =>
      JSON.stringify(
        scroll([
          ...BODY,
          prose(`${SOURCE[1]} ${overrides.extra ?? 'And then some more words of its own.'}`, ['e2', 'e3']),
        ]),
      );

    it('quotes each run of source words in the block that copied them, lower case and without punctuation', () => {
      const notes = role.repairNotes?.(copiedAnswer());
      const run = SOURCE[1]?.toLowerCase().replace(/[^a-z\s]/gu, '');
      expect(notes).toContain(`blocks[6] copies: "${run}"`);
      expect(notes).toContain('Rewrite only the sentences that contain them');
      // The notes carry words of the research only, never the writer's own sentences.
      expect(notes).not.toContain('some more words of its own');
    });

    it('names a run in a title, a list or a table cell as well, and caps the length of a run', () => {
      const longRun = SOURCE.join(' ');
      const answer = JSON.stringify({
        ...scroll([...BODY, comparison]),
        title: `${SOURCE[2]} and a lamp`.slice(0, 120),
        blocks: [
          { type: 'heading', text: 'The beam' },
          ...BODY.slice(0, 4),
          prose(longRun.slice(0, 590), ['e2', 'e3']),
          {
            ...comparison,
            rows: [
              [SOURCE[3], 'Fog'],
              ['Clear', 'Some words'],
            ],
          },
        ],
      });
      const notes = role.repairNotes?.(answer) ?? '';
      expect(notes).toContain('title copies: ');
      expect(notes).toMatch(/blocks\[5\] copies: "[a-z ]+ …"/u);
      expect(notes).toContain('blocks[6] copies: ');
    });

    it.each([
      ['an answer that is not JSON', 'not json at all'],
      ['an answer that is not an authored Scroll', JSON.stringify({ title: 'x' })],
      ['an answer that copies nothing', JSON.stringify(scroll([...BODY, comparison]))],
    ])('has no notes for %s', (_label, answer) => {
      expect(role.repairNotes?.(answer)).toBeUndefined();
    });

    it('has no notes when the refusal is not about copying', () => {
      const answer = JSON.stringify(
        scroll([...BODY, prose('A fresh line that cites a passage that does not exist.', ['e99'])]),
      );
      expect(role.repairNotes?.(answer)).toBeUndefined();
    });
  });
});
