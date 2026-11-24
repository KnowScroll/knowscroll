import { readFileSync } from 'node:fs';
import {
  computeIntegrityV2,
  computeMeasuresV2,
  SCROLL_DOCUMENT_V2_SCHEMA_VERSION,
  type ScrollDocumentV2,
} from '@knowscroll/scroll-model';
import { SCROLL_PROVENANCE_V2_SCHEMA_VERSION } from '@knowscroll/scroll-model/internal';
import { extractResearch, type ResearchPage } from '../../../infrastructure/research/public-pages.js';
import { readingFactsOfV2 } from '../adapters/reading-facts-v2.js';
import type { CompileOutcome } from '../application/ports.js';
import { WRITER_V2_PROMPT_VERSION } from './writer-v2-version.js';

/**
 * CI FIXTURE, never product content and never provider output. Every sentence below is authored
 * text about an invented planet, Orrin, and its invented star, Vael. Tests use it as the source
 * pages, and `storedOrrinV2` below as the stored v2 revision the deleted v2 writer made of it.
 */
export const FIXTURE_SOURCE_V2 = [
  'Orrin’s axis leans by 31 degrees, and the lean points the same way all year while the planet circles its star Vael.',
  'When Orrin’s northern half leans toward Vael, sunlight there arrives steeply and days run long, so the north warms.',
  'Half an orbit later the lean points away from Vael, sunlight arrives at a low angle and the northern days shorten.',
  'Orrin passes nearest to Vael in the middle of its southern summer, and its closest and farthest distances differ by only a few percent.',
  'A beam of light that strikes the ground at a low angle spreads over a wider patch, so each square metre receives less energy.',
  'Near the equator the noon sun stays high in every season, so the tropics change far less across the year than the poles do.',
  'Weather and oceans also shape local seasons, so the simple picture of lean and sunlight angle is a guide and not a full forecast.',
  'Were Orrin to stand upright with no lean at all, every place would keep much the same day length all year round.',
];

const retrievedAt = '2026-10-20T00:00:00.000Z';
const fixtureHtml = `<html><title>CI fixture</title><main>${FIXTURE_SOURCE_V2.map((text) => `<p>${text}</p>`).join('')}</main></html>`;

/** The fixture's single research page, on a host the research policy allows. */
export const fixtureResearchPageV2: ResearchPage = extractResearch(
  fixtureHtml,
  'https://spaceplace.nasa.gov/seasons/en/',
  retrievedAt,
);

/**
 * The fixture text as the page at `url`, for a recipe that names several pages. The research check refuses two
 * pages with the same text, so each page ends with one invented sentence that names its own address in letters.
 */
export function fixtureResearchPageAt(url: string): ResearchPage {
  const letters = url.replace(/[^a-z]+/giu, ' ').trim();
  const html = fixtureHtml.replace(
    '</main>',
    `<p>Orrin keeps a separate note for the page named ${letters}, which says nothing else.</p></main>`,
  );
  return extractResearch(html, url, retrievedAt);
}

/** What a stored v2 revision of the Orrin fixture is written as: whose it is and which writer run its provenance names. */
export interface StoredOrrinV2Options {
  readonly assetId: string;
  readonly explanationUnitId: string;
  /** Default 1. */
  readonly revision?: number;
  /** `stage` has a pinned picture and a Final call, `plain` has neither. Default `stage`. */
  readonly variant?: 'stage' | 'plain';
  /** The landmark the Final call awards, set into the document as the former plan's landmark was (D-188). Default: none. */
  readonly landmark?: { readonly key: string; readonly name: string };
  /** The control the Final call hands the reader, set on the Final call as the former plan's `finalCall` was (D-187). Default: none. */
  readonly finalCall?: { readonly kind: 'tilt' };
  /**
   * Changes the document before it is sealed (words reworded, a stop added): its measures and hash are computed again after,
   * so the result is as valid as the snapshot. The provenance is not changed: a test that edits citations edits them itself.
   */
  readonly edit?: (document: ScrollDocumentV2) => void;
  /** The writer run, its paid attempts and the model that the provenance names. Default: one CI run and one attempt. */
  readonly production?: { readonly runId: string; readonly attemptIds: readonly string[]; readonly model: string };
}

const readSnapshot = (
  variant: 'stage' | 'plain',
): { document: ScrollDocumentV2; provenance: Record<string, unknown> } =>
  JSON.parse(readFileSync(new URL(`../fixtures/stored-v2/orrin-${variant}.json`, import.meta.url), 'utf8')) as {
    document: ScrollDocumentV2;
    provenance: Record<string, unknown>;
  };

/**
 * A stored `scroll-document.v2` revision as the deleted v2 writer stored it (#815): the labelled Orrin fixture, a committed
 * snapshot of what `storedScrollV2` compiled from the Orrin answer, re-sealed for whose it is. Stage and main still store and
 * serve v2 Scrolls, so the code that reads one (serving, reading facts, coverage, the release policy, the review gate, the
 * answer and support checks) is tested on this and never on a producer. The citations in its provenance are the claims of
 * `fixtureResearchPageV2`. Never product content. Pure and deterministic.
 */
export function storedOrrinV2(options: StoredOrrinV2Options): Extract<CompileOutcome, { kind: 'compiled' }> {
  const { document, provenance } = readSnapshot(options.variant ?? 'stage');
  const revision = options.revision ?? 1;
  document.assetId = options.assetId;
  document.revision = revision;
  document.explanationUnitId = options.explanationUnitId;
  if (options.landmark !== undefined) document.landmark = options.landmark;
  if (options.finalCall !== undefined)
    for (const stop of document.stops) if (stop.kind === 'final_call') stop.binding = options.finalCall;
  options.edit?.(document);
  if (options.landmark !== undefined || options.finalCall !== undefined || options.edit !== undefined)
    document.measures = computeMeasuresV2(document);
  document.integrity.sha256 = computeIntegrityV2(document);
  const production = options.production ?? {
    runId: 'run-ci-1',
    attemptIds: ['attempt-ci-1'],
    model: 'MiniMax-M3.1-Flash',
  };
  return {
    kind: 'compiled',
    document: JSON.parse(JSON.stringify(document)) as Record<string, unknown>,
    provenance: {
      ...provenance,
      assetId: options.assetId,
      revision,
      documentSha256: document.integrity.sha256,
      production: {
        kind: 'model',
        runId: production.runId,
        attemptIds: [...production.attemptIds],
        model: production.model,
        promptVersion: WRITER_V2_PROMPT_VERSION,
      },
    },
    documentVersion: SCROLL_DOCUMENT_V2_SCHEMA_VERSION,
    provenanceVersion: SCROLL_PROVENANCE_V2_SCHEMA_VERSION,
    documentSha256: document.integrity.sha256,
    explanationUnitId: options.explanationUnitId,
    language: document.language,
    title: document.title,
    readingFacts: readingFactsOfV2(document),
  };
}
