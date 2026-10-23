import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { conceptMeaning } from '../domain/concepts.js';
import type { CoverageTarget } from '../domain/coverage.js';
import { RECIPE_COVERAGE_RULE } from '../domain/recipe-coverage.js';
import { admitRecipeCoverage } from './admit-recipe-coverage.js';
import type { CoverageHead, CoverageHeadPorts } from './coverage-ports.js';
import type { AdmissionTx } from './ports.js';

const ref = { assetId: '6f1c2b0e-3d6a-4a53-9a8a-0f4a1c9b2d11', assetRevision: 1 };
const recipe = {
  explanationUnitId: 'fixture-unit',
  topicId: 'earth.seasons',
  facetId: 'earth.seasons.axial-tilt',
} as const;
const tx = {} as AdmissionTx;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function targetOf(blockCount: number): CoverageTarget {
  return {
    documentSha256: digest('document'),
    provenanceSha256: digest('provenance'),
    explanationUnitId: recipe.explanationUnitId,
    framing: 'factual',
    framingSha256: digest('framing'),
    readingFactsVersion: 2,
    readingFactsSha256: digest('facts'),
    blocks: Array.from({ length: blockCount }, (_, index) => ({
      id: `block-${String(index)}`,
      type: 'paragraph',
      nested: false,
      truthSupported: true,
    })),
  };
}

/** In-memory ports that keep every appended head, as the SQL adapter keeps every revision. */
function memoryPorts(target: CoverageTarget | undefined, catalogueSha256 = digest('catalogue-1')) {
  const heads: CoverageHead[] = [];
  const ports: CoverageHeadPorts = {
    hash: digest,
    bytes: (value) => JSON.stringify(value).length,
    catalogue: {
      sha256: catalogueSha256,
      meaningSha256: (topicId, facetId) => (conceptMeaning(topicId, facetId) ? digest([topicId, facetId]) : undefined),
    },
    lockTarget: () => Promise.resolve(target),
    readHead: () => Promise.resolve(heads.at(-1)),
    append: (_tx, _command, head) => {
      heads.push(head);
      return Promise.resolve();
    },
  };
  return { ports, heads };
}

describe('admitRecipeCoverage (in-memory ports; the SQL adapter is covered in integration)', () => {
  it('appends the first head from the recipe, with the rule and recipe as its basis', async () => {
    const { ports, heads } = memoryPorts(targetOf(5));
    const outcome = await admitRecipeCoverage(ports, tx, recipe, ref);
    expect(outcome.kind).toBe('admitted');
    expect(heads).toHaveLength(1);
    expect(heads[0]).toMatchObject({
      status: 'active',
      authority: { ...ref, headRevision: 1 },
      semanticReviewReference: `${RECIPE_COVERAGE_RULE}:fixture-unit`,
    });
    expect(heads[0]?.mapping.bindings.map((binding) => binding.facetId)).toEqual(['earth.seasons.axial-tilt']);
  });

  it('replays an identical decision without appending history', async () => {
    const { ports, heads } = memoryPorts(targetOf(5));
    const first = await admitRecipeCoverage(ports, tx, recipe, ref);
    const again = await admitRecipeCoverage(ports, tx, recipe, ref);
    expect(first).toMatchObject({ kind: 'admitted', change: 'appended' });
    expect(again).toEqual({ ...first, change: 'unchanged' });
    expect(heads).toHaveLength(1);
  });

  it('appends a corrected head after the current one when the decision changes', async () => {
    const { ports, heads } = memoryPorts(targetOf(5));
    await admitRecipeCoverage(ports, tx, recipe, ref);
    const changedCatalogue = { ...ports, catalogue: { ...ports.catalogue, sha256: digest('catalogue-2') } };
    const corrected = await admitRecipeCoverage(changedCatalogue, tx, recipe, ref);
    expect(corrected).toMatchObject({ kind: 'admitted', change: 'appended', head: { authority: { headRevision: 2 } } });
    expect(heads.map((head) => head.authority.headRevision)).toEqual([1, 2]);
  });

  it('writes nothing when the revision is not an admissible target', async () => {
    const { ports, heads } = memoryPorts(undefined);
    expect(await admitRecipeCoverage(ports, tx, recipe, ref)).toEqual({
      kind: 'not_admitted',
      code: 'target_unavailable',
    });
    expect(heads).toEqual([]);
  });

  it('writes nothing when the document has too few body blocks', async () => {
    const { ports, heads } = memoryPorts(targetOf(2));
    expect(await admitRecipeCoverage(ports, tx, recipe, ref)).toEqual({
      kind: 'not_admitted',
      code: 'too_few_body_blocks',
    });
    expect(heads).toEqual([]);
  });
});
