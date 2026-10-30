import { describe, expect, it } from 'vitest';
import { AuthoredScrollV2 } from '@knowscroll/scroll-model/producer';
import { evidencePassages } from './evidence.js';
import { spikeRecipeV2 } from './spike-v2/topics.js';
import { fixtureAuthoredV2, fixtureResearchPageV2 } from './spike-v2/writer-v2.fixture.js';
import { WRITER_PROMPT_VERSION } from './writer.js';
import {
  compileGeneratedScrollV2,
  publicationV2,
  writerInstructionsV2,
  writerRoleV2,
  WRITER_V2_PROMPT_VERSION,
  type WriterV2Context,
} from './writer-v2.js';

const passages = evidencePassages([fixtureResearchPageV2]);
const context = (key: 'seasons' | 'dns-lookup' = 'seasons'): WriterV2Context => ({
  publication: publicationV2(key),
  recipe: spikeRecipeV2(key),
  passages,
  pages: [fixtureResearchPageV2],
});

/** The fixture with an edit, parsed again so only schema-valid input reaches the compile. */
function changed(
  edit: (draft: { items: Record<string, unknown>[]; [key: string]: unknown }) => void,
): AuthoredScrollV2 {
  const draft = JSON.parse(JSON.stringify(fixtureAuthoredV2())) as { items: Record<string, unknown>[] };
  edit(draft);
  return AuthoredScrollV2.parse(draft);
}

describe('the v14 writer', () => {
  it('has its own version and leaves the v1 writer’s alone', () => {
    expect(WRITER_V2_PROMPT_VERSION).toBe('scroll-writer.v14');
    expect(WRITER_PROMPT_VERSION).toBe('scroll-writer.v13');
    expect(writerRoleV2(context()).version).toBe('scroll-writer.v14');
    expect(writerRoleV2(context()).id).toBe('content.scroll-writer');
  });

  it('compiles the recorded fixture answer for a stage recipe with a myth', () => {
    const outcome = compileGeneratedScrollV2(fixtureAuthoredV2(), context());
    expect(outcome.kind).toBe('compiled');
    if (outcome.kind !== 'compiled') return;
    expect(outcome.document.stage?.states.length).toBeGreaterThanOrEqual(3);
    expect(outcome.document.measures.readingMinutes).toBeGreaterThanOrEqual(3);
    expect(outcome.document.misconception.kind).toBe('myth');
    // The fixture's labelled source is the seasons recipe's, not the fixture's.
    expect(outcome.document.misconception.kind === 'myth' && outcome.document.misconception.source.label).toContain(
      'Private Universe',
    );
  });

  it('keeps asides, stages and the misconception to what the recipe decided', () => {
    const plain = compileGeneratedScrollV2(fixtureAuthoredV2(), context('dns-lookup'));
    expect(plain.kind === 'refused' && plain.issues.map((issue) => issue.code)).toContain('stage_unexpected');
  });

  it('refuses a reader name of a source the Scroll rests on, at the writer’s item', () => {
    const named = changed((draft) => {
      draft.items[2] = {
        ...draft.items[2],
        text: 'NASA says the orbit is almost a circle, and so the nearest and farthest points hardly matter.',
      };
    });
    const outcome = compileGeneratedScrollV2(named, context());
    expect(outcome.kind === 'refused' && outcome.issues).toEqual(
      expect.arrayContaining([{ code: 'source_name_nasa', path: 'items.2' }]),
    );
  });

  it('refuses a stop copied from the research and says which words, for the repair', () => {
    const copied = changed((draft) => {
      draft.items[2] = {
        ...draft.items[2],
        text: 'Near the equator the noon sun stays high in every season, so the tropics change far less across the year than the poles do.',
      };
    });
    const refused = compileGeneratedScrollV2(copied, context());
    expect(refused.kind === 'refused' && refused.issues).toContainEqual({ code: 'copied_passage', path: 'items.2' });
    const role = writerRoleV2(context());
    const notes = role.repairNotes?.(JSON.stringify(copied));
    expect(notes).toContain('items[2] copies:');
    expect(notes).toContain('near the equator the noon sun stays high');
    expect(role.repairNotes?.('not json')).toBeUndefined();
    expect(role.repairNotes?.(JSON.stringify(fixtureAuthoredV2()))).toBeUndefined();
  });
});

describe('the v14 writer role', () => {
  it('accepts the fixture answer and refuses a broken one with fixed codes only', () => {
    const role = writerRoleV2(context());
    expect(role.outputSchema.safeParse(fixtureAuthoredV2()).success).toBe(true);
    const broken = changed((draft) => {
      draft.items[3] = { ...draft.items[3], cites: ['e99'], text: Array.from({ length: 70 }, () => 'word').join(' ') };
    });
    const result = role.outputSchema.safeParse(broken);
    expect(result.success).toBe(false);
    const safeCodes = (result.error?.issues ?? []).flatMap((issue) =>
      issue.code === 'custom' ? [(issue.params as { safeCode?: string } | undefined)?.safeCode] : [],
    );
    expect(safeCodes).toEqual(expect.arrayContaining(['authoring_cite_unknown', 'stop_too_long']));
    const paths = (result.error?.issues ?? []).map((issue) => issue.path.join('.'));
    expect(paths).toContain('items.3');
  });

  it('sends a catalogue the harness accepts: lower-case codes, short fixed hints, at most 128', () => {
    const catalogue = writerRoleV2(context()).safeCustomIssues ?? {};
    const codes = Object.keys(catalogue);
    expect(codes.length).toBeLessThanOrEqual(128);
    for (const code of codes) {
      expect(code).toMatch(/^[a-z][a-z0-9_]{0,63}$/u);
      expect(catalogue[code]?.length).toBeGreaterThan(0);
      expect(catalogue[code]?.length).toBeLessThanOrEqual(256);
    }
    expect(codes).toContain('source_name_nasa');
  });

  it('asks for one repair that carries the refused answer, and at most 16,000 tokens including thinking', () => {
    const role = writerRoleV2(context());
    expect(role.repairWithPreviousAnswer).toBe(true);
    expect(role.maxOutputTokens).toBe(16_000);
    expect(role.effort).toBe('medium');
  });
});

describe('the v14 instructions', () => {
  it('state the shape, the budget, the voice and the rules the checks enforce', () => {
    const text = writerInstructionsV2(spikeRecipeV2('seasons'));
    for (const phrase of [
      'at most 4 calls',
      'final_call',
      '"limits"',
      '60 words',
      '12 words',
      'FIRST',
      'nine words in a row',
      'cites',
      '3 to 6 minutes',
      'second person',
    ])
      expect(text).toContain(phrase);
    expect(text.length).toBeLessThan(32_768);
  });

  it('name the misconception of the recipe, with no source, and keep the common guess to it', () => {
    const text = writerInstructionsV2(spikeRecipeV2('seasons'));
    expect(text).toContain('closer to the Sun in summer');
    expect(text).toContain('"commonGuess"');
    expect(text).toContain('without naming any study or source');
    expect(text).not.toContain('Private Universe');
  });

  it('say there is no misconception when the recipe has none', () => {
    const text = writerInstructionsV2(spikeRecipeV2('industrial-causes'));
    expect(text).toContain('names no misconception');
    expect(text).not.toContain('THE MISCONCEPTION');
  });

  it('describe the picture and its kit only for a stage recipe', () => {
    const stage = writerInstructionsV2(spikeRecipeV2('seasons'));
    expect(stage).toContain('PINNED PICTURE');
    expect(stage).toContain('view: sun-earth | orbit | earth-close | moon-orbit | night-sky');
    expect(stage).toContain('ray: off | overhead | high | low');
    const plain = writerInstructionsV2(spikeRecipeV2('dns-lookup'));
    expect(plain).toContain('NO PICTURE');
    expect(plain).not.toContain('earthAt');
    expect(plain).not.toContain('"stage":{…}');
  });

  it('tell the writer to ignore the v1 layout words of a brief', () => {
    expect(writerInstructionsV2(spikeRecipeV2('seasons'))).toContain('Ignore anything in it about diagrams');
  });
});
