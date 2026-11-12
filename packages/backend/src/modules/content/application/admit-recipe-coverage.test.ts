import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import { seedSnapshot } from '../domain/catalogue/seed.js';
import { LIBRARY_SYSTEMS } from '../domain/library/index.js';
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

const plan = seedSnapshot(LIBRARY_SYSTEMS, canonicalSha256);

/** In-memory ports that keep every appended head, as the SQL adapter keeps every revision. */
function memoryPorts(target: CoverageTarget | undefined, catalogueSha256 = digest('catalogue-1')) {
  const heads: CoverageHead[] = [];
  const ports: CoverageHeadPorts = {
    hash: digest,
    bytes: (value) => JSON.stringify(value).length,
    catalogue: () =>
      Promise.resolve({
        sha256: catalogueSha256,
        meaningSha256: (topicId: string, facetId: string) =>
          plan.meaning(topicId, facetId) ? digest([topicId, facetId]) : undefined,
        acceptsMeaning: (topicId: string, facetId: string, sha256: string) =>
          plan.meaning(topicId, facetId) !== undefined && sha256 === digest([topicId, facetId]),
      }),
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

  it('appends a corrected head after the current one when a binding means something else now', async () => {
    const { ports, heads } = memoryPorts(targetOf(5));
    await admitRecipeCoverage(ports, tx, recipe, ref);
    const rephrased = {
      ...ports,
      catalogue: async (at: Parameters<typeof ports.catalogue>[0]) => ({
        ...(await ports.catalogue(at)),
        meaningSha256: () => digest('another meaning'),
        acceptsMeaning: (_topicId: string, _facetId: string, sha256: string) => sha256 === digest('another meaning'),
      }),
    };
    const corrected = await admitRecipeCoverage(rephrased, tx, recipe, ref);
    expect(corrected).toMatchObject({ kind: 'admitted', change: 'appended', head: { authority: { headRevision: 2 } } });
    expect(heads.map((head) => head.authority.headRevision)).toEqual([1, 2]);
  });

  it('appends nothing when a new catalogue release changed only the digest a mapping records (D-419)', async () => {
    const { ports, heads } = memoryPorts(targetOf(5));
    await admitRecipeCoverage(ports, tx, recipe, ref);
    const released = {
      ...ports,
      catalogue: async (at: Parameters<typeof ports.catalogue>[0]) => ({
        ...(await ports.catalogue(at)),
        sha256: digest('catalogue-2'),
      }),
    };
    expect(await admitRecipeCoverage(released, tx, recipe, ref)).toMatchObject({
      kind: 'admitted',
      change: 'unchanged',
    });
    expect(heads.map((head) => head.authority.headRevision)).toEqual([1]);
  });

  it('appends nothing when a revision only reworded a facet the catalogue still accepts as the same meaning (D-419, #674)', async () => {
    const { ports, heads } = memoryPorts(targetOf(5));
    await admitRecipeCoverage(ports, tx, recipe, ref);
    const earlier = heads[0]!.mapping.bindings[0]!.meaningSha256;
    const reworded = {
      ...ports,
      catalogue: async (at: Parameters<typeof ports.catalogue>[0]) => ({
        ...(await ports.catalogue(at)),
        sha256: digest('catalogue-2'),
        meaningSha256: () => digest('reworded'),
        acceptsMeaning: (_topicId: string, _facetId: string, sha256: string) =>
          sha256 === earlier || sha256 === digest('reworded'),
      }),
    };
    expect(await admitRecipeCoverage(reworded, tx, recipe, ref)).toMatchObject({
      kind: 'admitted',
      change: 'unchanged',
    });
    // The head a certificate was read against is still the head, binding for binding.
    expect(heads).toHaveLength(1);
    expect(heads[0]?.mapping.bindings[0]?.meaningSha256).toBe(earlier);
  });

  it('decides against one release even when another lands while it runs (#674)', async () => {
    const { ports, heads } = memoryPorts(targetOf(5));
    let reads = 0;
    const racing: CoverageHeadPorts = {
      ...ports,
      catalogue: async (at) => {
        reads += 1;
        // A release published after the first read changes the digest every later read sees.
        return { ...(await ports.catalogue(at)), sha256: digest(`catalogue-${String(reads)}`) };
      },
    };
    const outcome = await admitRecipeCoverage(racing, tx, recipe, ref);
    expect(outcome).toMatchObject({ kind: 'admitted', change: 'appended' });
    expect(reads).toBe(1);
    expect(heads[0]?.mapping.catalogueSha256).toBe(digest('catalogue-1'));
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
