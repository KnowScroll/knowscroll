import { sql } from 'kysely';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import type { Kysely } from 'kysely';
import { CONCEPTS, COVERAGE_POLICY, CONCEPT_CATALOGUE_VERSION } from '@knowscroll/backend/modules/content';
import type { CoverageCommand, CoverageMapping, ImportEditorialScroll } from '@knowscroll/backend/modules/content';
import {
  admitReelCoverage,
  coverageCatalogue,
  coverageHeadPorts,
  makeAdmissionStore,
  makeAdmitCoverage,
  makeCoverageAdmissionPorts,
} from '@knowscroll/backend/modules/content/nest-providers';
import { starterSource } from '../support/scroll.js';
import type { SimConfig } from './config.js';
import { createRng, seedFrom, type Rng } from './rng.js';

/** One readable block of a stored Scroll revision: its id and its share of the reading time. */
export interface BlockFact {
  readonly id: string;
  readonly weight: number;
}

export interface LibraryScroll {
  readonly assetId: string;
  readonly revision: number;
  readonly blocks: readonly BlockFact[];
  readonly totalWeight: number;
  /** The stored reading estimate every persona's timings derive from. */
  readonly estimatedReadingMs: number;
}

export interface LibraryReel {
  readonly assetId: string;
  readonly revision: number;
  readonly durationMs: number;
}

/**
 * One explanation unit of the fixture library: a Scroll, and for some units a Reel twin that shares
 * its explanation identity. Identifiers and titles are obviously fixtures (`ci-sim-*`, `[CI sim]`; the editorial source grammar has no dots).
 */
export interface LibraryUnit {
  readonly unitId: string;
  /** A planet of the real code catalogue. */
  readonly topicId: string;
  /** Its system in the real code catalogue. */
  readonly systemId: string;
  /** The facet the unit's coverage binds. */
  readonly facetId: string;
  readonly title: string;
  readonly scroll: LibraryScroll;
  readonly reel?: LibraryReel;
}

export interface Library {
  readonly units: readonly LibraryUnit[];
  readonly topics: readonly string[];
  readonly unit: (unitId: string) => LibraryUnit;
  readonly ofAsset: (assetId: string) => { readonly unit: LibraryUnit; readonly kind: 'scroll' | 'reel' } | undefined;
  readonly ofTopic: (topicId: string) => readonly LibraryUnit[];
  readonly scrollCount: number;
  readonly reelCount: number;
}

const SLUG = (id: string) => id.replaceAll(/[^a-z0-9]+/g, '-');
/** Titles may not carry digits (the honesty rules want a number to be supported), so units are numbered in words. */
const ORDINALS = [
  'alpha',
  'beta',
  'gamma',
  'delta',
  'epsilon',
  'zeta',
  'eta',
  'theta',
  'iota',
  'kappa',
  'lambda',
  'mu',
  'nu',
  'xi',
  'omicron',
  'pi',
];

/**
 * Builds the fixture library through the real admission paths: each Scroll is admitted by the editorial
 * import use case (the starter document under a fixture identity), attributed to a planet of the real
 * code catalogue, and given observed-coverage admission for one facet of that planet; each Reel twin is
 * written the way a published Reel is stored (a document, the provenance of an approved script whose claims rest
 * on its twin Scroll, no media bytes), and its coverage is decided by the same code that decides it at
 * publication. Nothing here was written by a model and nothing claims to be real content.
 *
 * The catalogue is still code, so the library attaches to its 17 planets. A later slice moves the
 * catalogue into Postgres; `buildLibrary` then reads it from there.
 */
export async function buildLibrary(
  db: Kysely<Database>,
  importScroll: ImportEditorialScroll,
  config: SimConfig,
): Promise<Library> {
  const rng = createRng(seedFrom(config.seed, 'library'));
  const approvals = new Map<string, string>();
  const admitCoverage = makeAdmitCoverage(
    makeCoverageAdmissionPorts(db, (digest, reference) => approvals.get(digest) === reference),
  );
  const units: LibraryUnit[] = [];
  const planets = CONCEPTS.filter((concept) => concept.parent !== null && concept.facets.length > 0).slice(
    0,
    config.library.planets,
  );
  for (const planet of planets) {
    const count = rng.int(config.library.unitsPerPlanet[0], config.library.unitsPerPlanet[1]);
    for (let index = 0; index < count; index++) {
      const facet = planet.facets[index % planet.facets.length]!;
      const unitId = `ci-sim-${SLUG(planet.id)}-${String(index + 1)}`;
      const title = `[CI sim] ${planet.id.replaceAll('.', ' ')} ${facet.id.slice(planet.id.length + 1)} ${ORDINALS[index % ORDINALS.length]!}`;
      const scroll = await admitScroll({
        db,
        importScroll,
        admitCoverage,
        approvals,
        rng,
        unitId,
        title,
        planet,
        facet,
      });
      // Each planet's first two units have a Reel twin, so a Reel watcher can meet two units of a system; the rest by share.
      const reel =
        index < 2 || rng.chance(config.library.reelTwinShare)
          ? await admitReel(db, rng, { unitId, title, topicId: planet.id, facetId: facet.id }, scroll)
          : undefined;
      units.push({
        unitId,
        topicId: planet.id,
        systemId: planet.parent!,
        facetId: facet.id,
        title,
        scroll,
        ...(reel ? { reel } : {}),
      });
    }
  }
  const byUnit = new Map(units.map((unit) => [unit.unitId, unit]));
  const byAsset = new Map<string, { unit: LibraryUnit; kind: 'scroll' | 'reel' }>();
  for (const unit of units) {
    byAsset.set(unit.scroll.assetId, { unit, kind: 'scroll' });
    if (unit.reel) byAsset.set(unit.reel.assetId, { unit, kind: 'reel' });
  }
  return {
    units,
    topics: planets.map((planet) => planet.id),
    unit: (unitId) => {
      const found = byUnit.get(unitId);
      if (!found) throw new Error(`SIM_UNKNOWN_UNIT ${unitId}`);
      return found;
    },
    ofAsset: (assetId) => byAsset.get(assetId),
    ofTopic: (topicId) => units.filter((unit) => unit.topicId === topicId),
    scrollCount: units.length,
    reelCount: units.filter((unit) => unit.reel).length,
  };
}

interface AdmitScrollInput {
  readonly db: Kysely<Database>;
  readonly importScroll: ImportEditorialScroll;
  readonly admitCoverage: ReturnType<typeof makeAdmitCoverage>;
  readonly approvals: Map<string, string>;
  readonly rng: Rng;
  readonly unitId: string;
  readonly title: string;
  readonly planet: (typeof CONCEPTS)[number];
  readonly facet: { readonly id: string };
}

async function admitScroll(input: AdmitScrollInput): Promise<LibraryScroll> {
  const { db, rng, unitId, title, planet, facet } = input;
  const source = starterSource() as {
    assetId: string;
    reference: string;
    publication: { explanationUnitId: string };
    draft: { title: string };
  };
  source.assetId = rng.uuid();
  source.reference = `ci-sim-${unitId}`;
  source.publication.explanationUnitId = unitId;
  source.draft.title = title;
  const imported = await input.importScroll(source);
  if (imported.kind !== 'imported')
    throw new Error(`SIM_LIBRARY_ADMISSION_REFUSED ${unitId} ${imported.reason} ${JSON.stringify(imported.issues)}`);
  await db.deleteFrom('content.encounter_topics').where('asset_id', '=', imported.assetId).execute();
  await db
    .insertInto('content.encounter_topics')
    .values({
      asset_id: imported.assetId,
      asset_revision: imported.revision,
      topic_id: planet.id,
      role: 'primary',
      weight: 1,
    })
    .execute();
  const row = await db
    .selectFrom('content.asset_revisions')
    .select(['document_sha256', 'reading_facts'])
    .where('asset_id', '=', imported.assetId)
    .where('revision', '=', imported.revision)
    .executeTakeFirstOrThrow();
  const provenance = await db
    .selectFrom('content.asset_provenance')
    .select('provenance')
    .where('asset_id', '=', imported.assetId)
    .executeTakeFirstOrThrow();
  const mapping: CoverageMapping = {
    version: COVERAGE_POLICY,
    documentSha256: row.document_sha256,
    provenanceSha256: canonicalSha256(provenance.provenance),
    explanationUnitId: unitId,
    framing: 'factual',
    framingSha256: canonicalSha256({ kind: 'factual' }),
    readingFactsVersion: 2,
    readingFactsSha256: canonicalSha256(row.reading_facts),
    catalogueVersion: CONCEPT_CATALOGUE_VERSION,
    catalogueSha256: coverageCatalogue.sha256,
    bindings: [
      {
        topicId: planet.id,
        facetId: facet.id,
        meaningSha256: coverageCatalogue.meaningSha256(planet.id, facet.id)!,
        requiredBlockIds: ['intro-look-up'],
      },
    ],
  };
  const command: CoverageCommand = {
    version: 'content-coverage-command.v1',
    assetId: imported.assetId,
    assetRevision: imported.revision,
    expectedHeadRevision: 0,
    semanticReviewReference: 'ci-sim-coverage-fixture-only',
    change: { kind: 'admit', mapping },
  };
  input.approvals.set(canonicalSha256(command), command.semanticReviewReference);
  await input.admitCoverage(command);
  const facts = row.reading_facts as unknown as {
    blocks: BlockFact[];
    totalWeight: number;
    estimatedReadingMs: number;
  };
  return {
    assetId: imported.assetId,
    revision: imported.revision,
    blocks: facts.blocks.map((block) => ({ id: block.id, weight: block.weight })),
    totalWeight: facts.totalWeight,
    estimatedReadingMs: facts.estimatedReadingMs,
  };
}

/** The six sentences of a lab Reel's script: one shot each, every one citing the claim of its own number. */
const REEL_SENTENCES = [
  'The question starts with one plain observation.',
  'A first detail shows what changes and what stays.',
  'A second detail adds the part people often miss.',
  'Together they point to one cause.',
  'The cause explains the pattern from the start.',
  'That is the whole idea in a single picture.',
];

/**
 * A Reel twin as a published Reel is stored: a valid document, the provenance of an approved script (six sentences, each
 * citing a claim that rests on the unit's Scroll) and no media bytes. Its coverage is decided by the code that decides it
 * at publication (`admitReelCoverage`), for the facet its unit binds.
 */
async function admitReel(
  db: Kysely<Database>,
  rng: Rng,
  unit: { readonly unitId: string; readonly title: string; readonly topicId: string; readonly facetId: string },
  twin: LibraryScroll,
): Promise<LibraryReel> {
  const { unitId, title, topicId, facetId } = unit;
  const assetId = rng.uuid();
  const durationMs = rng.int(20, 45) * 1000;
  const digest = canonicalSha256({ assetId, durationMs });
  const reelTitle = `${title} (Reel)`;
  const document = {
    schemaVersion: 'reel-document.v1',
    assetId,
    revision: 1,
    title: reelTitle,
    summary: 'CI simulation fixture',
    language: 'en',
    truthLabel: 'generated',
    fixture: false,
    captions: 'burned_in',
    mediaKey: `sha256/${digest.slice(0, 2)}/${digest}.mp4`,
    durationMs,
    width: 1080,
    height: 1920,
  };
  const facts = {
    v: 2,
    measuresVersion: 'reel-duration.v1',
    totalWeight: 0,
    estimatedReadingMs: durationMs,
    blocks: [],
    nested: [],
    reelDurationMs: durationMs,
  };
  const brief = {
    version: 1,
    worldId: 'ci-sim',
    narration: REEL_SENTENCES.map((text, index) => ({ text, claimIds: [`c${String(index + 1)}`] })),
    claims: REEL_SENTENCES.map((_, index) => ({
      id: `c${String(index + 1)}`,
      role: index === 0 ? 'main' : 'supporting',
    })),
    claimSources: REEL_SENTENCES.map((_, index) => ({
      claimId: `c${String(index + 1)}`,
      assetId: twin.assetId,
      assetRevision: twin.revision,
    })),
    criteria: { mustShow: [], mustNotShow: [], depictionPolicyVersion: 'policy-3' },
    style: { id: 'ci-sim', version: 1, text: 'CI simulation fixture' },
    title: reelTitle,
    summary: 'CI simulation fixture',
  };
  const provenance = {
    schemaVersion: 'reel-provenance.v1',
    kind: 'cutroom_import',
    script: assetId,
    brief,
    recipe: 'ci-sim',
    twin: { assetId: twin.assetId, assetRevision: twin.revision, explanationUnitId: unitId },
    fixture: false,
  };
  await sql`insert into content.assets (id, revision, kind, status) values (${assetId}::uuid, 1, 'reel', 'admitted')`.execute(
    db,
  );
  await sql`insert into content.asset_revisions
      (asset_id, revision, provenance_kind, document_version, document, document_sha256, explanation_unit_id, language, title, reading_facts)
    values (${assetId}::uuid, 1, 'cutroom_import', 'reel-document.v1', ${JSON.stringify(document)}::jsonb,
      ${digest}, ${unitId}, 'en', ${reelTitle}, ${JSON.stringify(facts)}::jsonb)`.execute(db);
  await sql`insert into content.asset_provenance (asset_id, revision, provenance_version, provenance)
    values (${assetId}::uuid, 1, 'reel-provenance.v1', ${JSON.stringify(provenance)}::jsonb)`.execute(db);
  await db
    .insertInto('content.encounter_topics')
    .values({ asset_id: assetId, asset_revision: 1, topic_id: topicId, role: 'primary', weight: 1 })
    .execute();
  const outcome = await makeAdmissionStore(db).inAdmission((tx) =>
    admitReelCoverage(
      coverageHeadPorts,
      tx,
      { explanationUnitId: unitId, topicId, facetId },
      { assetId, assetRevision: 1 },
    ),
  );
  if (outcome.kind !== 'admitted') throw new Error(`SIM_LIBRARY_REEL_COVERAGE_REFUSED ${unitId} ${outcome.code}`);
  return { assetId, revision: 1, durationMs };
}
