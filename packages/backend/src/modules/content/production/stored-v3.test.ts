import { describe, expect, it } from 'vitest';
import { ScrollProvenanceV3 } from '@knowscroll/scroll-model/internal';
import type { WrittenScrollV3 } from '@knowscroll/scroll-model/producer';
import { RECIPES } from '../domain/library/index.js';
import { evidencePassages } from './evidence.js';
import { fixtureResearchPageV2 } from './spike-v2/writer-v2.fixture.js';
import { spikePlanV3 } from './spike-v3/plans.js';
import { fixtureReplyV3 } from './spike-v3/writer-v3.fixture.js';
import { storedScrollV3 } from './stored-v3.js';
import { writerContextV3, type WriterV3Context } from './writer-v3.js';
import { WRITER_V3_PROMPT_VERSION } from './writer-v3-version.js';

// CI fixtures only: an invented planet on the seasons recipe's identity, never product content.
const production = { runId: 'run-ci-1', attemptIds: ['attempt-ci-1', 'attempt-ci-2'], model: 'MiniMax-M3.1-Flash' };
const context = (revision = 1): WriterV3Context =>
  writerContextV3(RECIPES.seasons, revision, spikePlanV3('seasons'), evidencePassages([fixtureResearchPageV2]), [
    fixtureResearchPageV2,
  ]);

/** The fixture reply as plain data with one edit. */
function edited(change: (draft: { items: Record<string, unknown>[] }) => void): WrittenScrollV3 {
  const draft = JSON.parse(JSON.stringify(fixtureReplyV3())) as { items: Record<string, unknown>[] };
  change(draft);
  return draft as unknown as WrittenScrollV3;
}

describe('what admission stores for a document v3 Scroll (labelled CI fixture)', () => {
  it('stores the document, a provenance that parses and v4 reading facts, with the real attempts in the production record', () => {
    const outcome = storedScrollV3(fixtureReplyV3(), context(2), production);
    if (outcome.kind !== 'compiled') throw new Error(`CI expected a compile, got ${JSON.stringify(outcome)}`);
    expect(outcome.documentVersion).toBe('scroll-document.v3');
    expect(outcome.provenanceVersion).toBe('scroll-provenance.v3');
    expect(outcome.readingFacts.v).toBe(4);
    expect(outcome.explanationUnitId).toBe(RECIPES.seasons.explanationUnitId);
    expect(outcome.language).toBe('en');
    const provenance = ScrollProvenanceV3.parse(outcome.provenance);
    expect(provenance.documentSha256).toBe(outcome.documentSha256);
    expect(provenance.revision).toBe(2);
    expect(provenance.production).toEqual({ kind: 'model', ...production, promptVersion: WRITER_V3_PROMPT_VERSION });
    // Every beat, aside and picture is accounted for, and so is the takeaway.
    const document = outcome.document as {
      sections: { beats: { id: string }[] }[];
      asides: { id: string }[];
      pictures: { id: string }[];
      title: string;
    };
    expect(outcome.title).toBe(document.title);
    expect(provenance.citations.map((entry) => entry.partId).sort()).toEqual(
      [
        ...document.sections.flatMap((section) => section.beats.map((beat) => beat.id)),
        ...document.asides.map((aside) => aside.id),
        ...document.pictures.map((picture) => picture.id),
        'takeaway',
      ].sort(),
    );
    expect(JSON.stringify(outcome.document)).not.toContain('claimId');
  });

  it('writes the same bytes for the same reply, so a repeated compile is a no-op', () => {
    const first = storedScrollV3(fixtureReplyV3(), context(), production);
    const second = storedScrollV3(fixtureReplyV3(), context(), production);
    expect(second).toEqual(first);
  });

  it('refuses a reply with a finding at the model’s own path, with a code and no text', () => {
    const outcome = storedScrollV3(
      edited((draft) => {
        draft.items[2] = { ...draft.items[2], cites: ['e99'] };
      }),
      context(),
      production,
    );
    expect(outcome).toEqual({
      kind: 'refused',
      stage: 'authoring',
      issues: [{ code: 'authoring_cite_unknown', path: 'items.2' }],
    });
  });

  it('refuses a reply that opens by pointing back, as the validator the harness runs does', () => {
    const outcome = storedScrollV3(
      edited((draft) => {
        draft.items[1] = { ...draft.items[1], text: `This ${String(draft.items[1]?.['text'])}` };
      }),
      context(),
      production,
    );
    expect(outcome).toMatchObject({
      kind: 'refused',
      issues: [{ code: 'first_beat_points_back', path: 'items.1.text' }],
    });
  });
});
