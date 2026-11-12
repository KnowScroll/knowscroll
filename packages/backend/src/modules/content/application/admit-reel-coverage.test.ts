import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { conceptMeaning } from '../domain/concepts.js';
import type { CoverageTarget } from '../domain/coverage.js';
import { REEL_RECIPE_COVERAGE_RULE } from '../domain/reel-coverage.js';
import { admitRecipeCoverage } from './admit-recipe-coverage.js';
import { admitReelCoverage } from './admit-reel-coverage.js';
import { readmitRecipeCoverage } from './readmit-recipe-coverage.js';
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

function reelTarget(segments: number, unit: string = recipe.explanationUnitId): CoverageTarget {
  return {
    format: 'reel',
    documentSha256: digest('document'),
    provenanceSha256: digest('provenance'),
    explanationUnitId: unit,
    framing: 'factual',
    framingSha256: digest('framing'),
    readingFactsVersion: 2,
    readingFactsSha256: digest('facts'),
    blocks: Array.from({ length: segments }, (_, index) => ({
      id: `s${String(index + 1)}`,
      type: 'segment',
      nested: false,
      truthSupported: true,
      span: [index * 4000, index * 4000 + 4000] as const,
    })),
  };
}

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

describe('admitReelCoverage (in-memory ports; the SQL adapter is covered in integration)', () => {
  it('appends the first head from the recipe, with the Reel rule and recipe as its basis', async () => {
    const { ports, heads } = memoryPorts(reelTarget(6));
    expect(await admitReelCoverage(ports, tx, recipe, ref)).toMatchObject({ kind: 'admitted', change: 'appended' });
    expect(heads).toHaveLength(1);
    expect(heads[0]).toMatchObject({
      status: 'active',
      authority: { ...ref, headRevision: 1 },
      semanticReviewReference: `${REEL_RECIPE_COVERAGE_RULE}:fixture-unit`,
      mapping: { version: 'reel-static-coverage.v1' },
    });
    expect(heads[0]?.mapping.bindings.map((binding) => binding.requiredBlockIds)).toEqual([['s1', 's3', 's6']]);
  });

  it('replays an identical decision and appends a corrected head after a catalogue change', async () => {
    const { ports, heads } = memoryPorts(reelTarget(6));
    await admitReelCoverage(ports, tx, recipe, ref);
    expect(await admitReelCoverage(ports, tx, recipe, ref)).toMatchObject({ change: 'unchanged' });
    const grown = { ...ports, catalogue: { ...ports.catalogue, sha256: digest('catalogue-2') } };
    expect(await admitReelCoverage(grown, tx, recipe, ref)).toMatchObject({ change: 'appended' });
    expect(heads.map((head) => head.authority.headRevision)).toEqual([1, 2]);
  });

  it('writes nothing for an unavailable target, a Scroll, another recipe’s unit or too few segments', async () => {
    for (const [target, code] of [
      [undefined, 'target_unavailable'],
      [{ ...reelTarget(6), format: undefined }, 'not_a_reel'],
      [reelTarget(6, 'another-unit'), 'recipe_mismatch'],
      [reelTarget(2), 'too_few_segments'],
    ] as const) {
      const { ports, heads } = memoryPorts(target);
      expect(await admitReelCoverage(ports, tx, recipe, ref)).toEqual({ kind: 'not_admitted', code });
      expect(heads).toEqual([]);
    }
  });

  it('is refused by the Scroll rule, which never decides a Reel’s coverage', async () => {
    const { ports, heads } = memoryPorts(reelTarget(6));
    expect(await admitRecipeCoverage(ports, tx, recipe, ref)).toEqual({
      kind: 'not_admitted',
      code: 'target_unavailable',
    });
    expect(heads).toEqual([]);
  });
});

describe('readmit-coverage decides the Reels again with the Scrolls', () => {
  const reelRevision = { ...ref, recipe: 'seasons-tilt' };
  const readmitPorts = (target: CoverageTarget | undefined) => {
    const { ports, heads } = memoryPorts(target);
    return {
      heads,
      ports: {
        coverage: ports,
        inAdmission: <T>(work: (admission: AdmissionTx) => Promise<T>) => work(tx),
        listGeneratedRevisions: () => Promise.resolve([]),
        listReelRevisions: () => Promise.resolve([reelRevision]),
      },
    };
  };
  const recipeOfKey = (key: string) => (key === 'seasons-tilt' ? { ...recipe, assetId: ref.assetId } : undefined);

  it('appends a head for a Reel, counts it, and names its unit so readers are judged again', async () => {
    const { ports, heads } = readmitPorts(reelTarget(6));
    const summary = await readmitRecipeCoverage(ports, [], { dryRun: false }, recipeOfKey as never);
    expect(summary).toEqual({
      dryRun: false,
      considered: 1,
      appended: 1,
      unchanged: 0,
      skipped: {},
      changedUnits: ['fixture-unit'],
    });
    expect(heads).toHaveLength(1);
    expect(await readmitRecipeCoverage(ports, [], { dryRun: false }, recipeOfKey as never)).toMatchObject({
      appended: 0,
      unchanged: 1,
      changedUnits: [],
    });
  });

  it('writes nothing in a dry run, and skips a Reel whose recipe is gone or whose script cannot be bound', async () => {
    const dry = readmitPorts(reelTarget(6));
    expect(await readmitRecipeCoverage(dry.ports, [], { dryRun: true }, recipeOfKey as never)).toMatchObject({
      considered: 1,
      appended: 1,
      changedUnits: [],
    });
    expect(dry.heads).toEqual([]);
    const gone = readmitPorts(reelTarget(6));
    expect((await readmitRecipeCoverage(gone.ports, [], { dryRun: false })).skipped).toEqual({ no_recipe: 1 });
    const few = readmitPorts(reelTarget(2));
    expect((await readmitRecipeCoverage(few.ports, [], { dryRun: false }, recipeOfKey as never)).skipped).toEqual({
      too_few_segments: 1,
    });
  });
});

describe('a head an operator retracted (#674, slice 5.1)', () => {
  /** A Reel with coverage whose head was then retracted by a reviewed command, which keeps the mapping it retracts. */
  async function retracted() {
    const fixture = memoryPorts(reelTarget(6));
    await admitReelCoverage(fixture.ports, tx, recipe, ref);
    const [active] = fixture.heads;
    fixture.heads.push({
      ...active!,
      authority: { ...active!.authority, headRevision: 2 },
      status: 'retracted',
      semanticReviewReference: 'ci-retract',
    });
    return fixture;
  }

  it('stays retracted when readmit decides the same thing again, and says so', async () => {
    const { ports, heads } = await retracted();
    expect(await admitReelCoverage(ports, tx, recipe, ref)).toEqual({ kind: 'not_admitted', code: 'retracted' });
    expect(heads.map((head) => head.status)).toEqual(['active', 'retracted']);
  });

  it('stays retracted after a catalogue change alone: a new digest is not a new decision', async () => {
    const { ports, heads } = await retracted();
    const grown = { ...ports, catalogue: { ...ports.catalogue, sha256: digest('catalogue-2') } };
    expect(await admitReelCoverage(grown, tx, recipe, ref)).toEqual({ kind: 'not_admitted', code: 'retracted' });
    expect(heads).toHaveLength(2);
  });

  it('gets a new head when the decision itself changes: another facet, or another script', async () => {
    const { ports, heads } = await retracted();
    const other = { ...recipe, facetId: 'earth.seasons.hemispheres' };
    expect(await admitReelCoverage(ports, tx, other, ref)).toMatchObject({ kind: 'admitted', change: 'appended' });
    expect(heads.map((head) => head.status)).toEqual(['active', 'retracted', 'active']);
  });

  it('is counted as left alone by readmit-coverage, and names no unit', async () => {
    const { ports, heads } = await retracted();
    const summary = await readmitRecipeCoverage(
      {
        coverage: ports,
        inAdmission: (work) => work(tx),
        listGeneratedRevisions: () => Promise.resolve([]),
        listReelRevisions: () => Promise.resolve([{ ...ref, recipe: 'seasons-tilt' }]),
      },
      [],
      { dryRun: false },
      ((key: string) => (key === 'seasons-tilt' ? { ...recipe, assetId: ref.assetId } : undefined)) as never,
    );
    expect(summary).toMatchObject({
      considered: 1,
      appended: 0,
      unchanged: 0,
      skipped: { retracted: 1 },
      changedUnits: [],
    });
    expect(heads).toHaveLength(2);
  });
});
