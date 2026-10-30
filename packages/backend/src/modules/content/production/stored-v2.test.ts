import { describe, expect, it } from 'vitest';
import { ScrollProvenanceV2 } from '@knowscroll/scroll-model/internal';
import type { AuthoredScrollV2 } from '@knowscroll/scroll-model/producer';
import { evidencePassages } from './evidence.js';
import { fixtureAuthoredV2, fixtureResearchPageV2 } from './spike-v2/writer-v2.fixture.js';
import { storedScrollV2 } from './stored-v2.js';
import { publicationV2, WRITER_V2_PROMPT_VERSION, type WriterV2Context } from './writer-v2.js';

const production = { runId: 'run-ci-1', attemptIds: ['attempt-ci-1'], model: 'MiniMax-M3.1-Flash' };
const myth = {
  kind: 'myth',
  claim: 'Orrin is warmest because it is closest to its star.',
  source: { label: 'CI fixture label', reviewed: true },
} as const;
const context = (misconception: WriterV2Context['recipe']['misconception'] = myth): WriterV2Context => ({
  publication: publicationV2('seasons'),
  recipe: { variant: 'stage', misconception },
  passages: evidencePassages([fixtureResearchPageV2]),
  pages: [fixtureResearchPageV2],
});

describe('what admission stores for a v2 Scroll (labelled CI fixture)', () => {
  it('stores the document, the provenance of every citation and the v3 reading facts', () => {
    const outcome = storedScrollV2(fixtureAuthoredV2(), context(), production);
    if (outcome.kind !== 'compiled') throw new Error(`CI expected a compile, got ${JSON.stringify(outcome)}`);
    expect(outcome.documentVersion).toBe('scroll-document.v2');
    expect(outcome.provenanceVersion).toBe('scroll-provenance.v2');
    expect(outcome.readingFacts.v).toBe(3);
    const provenance = ScrollProvenanceV2.parse(outcome.provenance);
    expect(provenance.documentSha256).toBe(outcome.documentSha256);
    expect(provenance.production).toEqual({ kind: 'model', ...production, promptVersion: WRITER_V2_PROMPT_VERSION });
    // Every part of the document is accounted for: each stop, each aside and the recap.
    const document = outcome.document as { stops: { id: string }[]; asides: { id: string }[] };
    expect(provenance.citations.map((entry) => entry.partId).sort()).toEqual(
      [...document.stops.map((stop) => stop.id), ...document.asides.map((aside) => aside.id), 'recap'].sort(),
    );
    expect(JSON.stringify(outcome.document)).not.toContain('claimId');
  });

  it('refuses a misconception whose source label no person has reviewed, with a code and no text', () => {
    const unreviewed = {
      ...myth,
      source: { label: 'A common idea; its source is still to be named', reviewed: false },
    };
    expect(storedScrollV2(fixtureAuthoredV2(), context(unreviewed), production)).toEqual({
      kind: 'refused',
      stage: 'library',
      issues: [{ code: 'misconception_source_unreviewed', path: 'misconception.source' }],
    });
  });

  it('reports the producer’s findings for an answer it refuses', () => {
    const draft = JSON.parse(JSON.stringify(fixtureAuthoredV2())) as { items: unknown[] };
    const broken = { ...draft, items: draft.items.slice(0, 3) } as unknown as AuthoredScrollV2;
    const outcome = storedScrollV2(broken, context(), production);
    expect(outcome.kind).toBe('refused');
  });
});
