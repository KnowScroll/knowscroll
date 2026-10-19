/** Reads the labelled fixtures in `packages/scroll-model/fixtures/` (CI fixtures, not product content). */
import { readFileSync } from 'node:fs';
import type { ScrollDocument } from '../index.js';
import type { ScrollProvenance } from '../internal/index.js';
import type { DraftProvenance } from '../producer/index.js';

export const FIXTURE_NAMES = ['attention-slowly', 'weight-other-worlds', 'spring-neap-tides'] as const;
export type FixtureName = (typeof FIXTURE_NAMES)[number];

function read(file: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../fixtures/${file}`, import.meta.url), 'utf8')) as unknown;
}

export interface Fixture {
  readonly name: FixtureName;
  /** The writer-style draft, as a model would return it (untrusted JSON). */
  readonly draft: unknown;
  readonly provenance: DraftProvenance;
  /** The committed compile output. */
  readonly document: ScrollDocument;
  readonly internal: ScrollProvenance;
}

export function fixture(name: FixtureName): Fixture {
  return {
    name,
    draft: read(`${name}.draft.json`),
    provenance: read(`${name}.provenance.json`) as DraftProvenance,
    document: read(`${name}.document.json`) as ScrollDocument,
    internal: read(`${name}.internal.json`) as ScrollProvenance,
  };
}

export function allFixtures(): Fixture[] {
  return FIXTURE_NAMES.map((name) => fixture(name));
}
