import type { ComposerSnapshot } from '../domain/types.js';

/**
 * Labelled CI fixtures, never product data: deterministic Composer snapshots of every move and of the
 * shapes a stored decision input had before policy v1 (no traits, no cells, no recent topics). Tests
 * compose them under `composer-policy.v0` and compare the result with a hash taken from the code as it
 * was before policy v1, so "old decisions replay byte for byte" is checked on varied inputs.
 */

type Candidate = ComposerSnapshot['candidates'][number];

/** mulberry32: a tiny seeded generator, so every run builds the same snapshots. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOPICS = ['earth.seasons', 'earth.tides', 'space.stars', 'body.immune', 'machines.learning'] as const;
const FACETS = ['cause', 'scale', 'history', 'limits', 'example', 'measure', 'model', 'myth'] as const;
const MODES = ['vertical', 'vertical', 'vertical', 'horizontal', 'variant', 'return'] as const;

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!;
}

function candidateOf(random: () => number, index: number): Candidate {
  const kind = random() < 0.4 ? 'reel' : 'scroll';
  const topic = pick(random, TOPICS);
  const other = pick(random, TOPICS);
  const facets = [...new Set([pick(random, FACETS), pick(random, FACETS)])];
  const assetId = `asset-${String(index)}`;
  return {
    admitted: true,
    accessible: random() > 0.1,
    renderable: true,
    encounter: {
      assetId,
      assetRevision: 1,
      kind,
      explanationUnitId: `unit-${String(Math.floor(index / 2))}`,
      metadata: {
        kind,
        title: `Fixture ${String(index)} ${topic}`,
        summary: `A labelled fixture about ${topic} and ${other}.`,
        language: 'en',
      },
      topics:
        other === topic
          ? [{ topicId: topic, role: 'primary', weight: 1 }]
          : [
              { topicId: topic, role: 'primary', weight: 0.7 },
              { topicId: other, role: random() < 0.5 ? 'supporting' : 'incidental', weight: 0.3 },
            ],
      facets,
      siblings: [],
      ...(kind === 'scroll' && random() < 0.3
        ? { series: { seriesId: 'fixture.series', seriesRevision: 1, part: 1 + (index % 3) } }
        : {}),
      catalogWatermark: 'fixture-catalog',
      attributionVersion: 'fixture-taxonomy',
    },
  };
}

function evidenceOf(
  random: () => number,
  snapshot: Omit<ComposerSnapshot, 'evidence'>,
): ComposerSnapshot['evidence'] | undefined {
  if (random() < 0.3) return undefined;
  const at = Date.parse(snapshot.evaluatedAt);
  const recent = Array.from({ length: Math.floor(random() * 5) }, (_, n) => {
    const encounter = pick(random, snapshot.candidates).encounter;
    return {
      exposureId: `exposure-${String(n)}`,
      activatedAt: new Date(at - (n + 1) * 600_000).toISOString(),
      explanationUnitId: encounter.explanationUnitId,
      facets: encounter.facets,
    };
  });
  return {
    universeId: snapshot.universeId,
    privacyEpoch: snapshot.privacyEpoch,
    evaluatedAt: snapshot.evaluatedAt,
    watermark: snapshot.watermarks.context,
    policyVersion: 'fixture-actual-activity',
    topics: TOPICS.filter(() => random() < 0.7).map((topicId) => {
      const measured = Math.floor(random() * 9);
      return {
        topicId,
        activity: Math.round(random() * 2000) / 1000,
        formats: [
          { kind: 'reel' as const, measured, qualified: Math.floor(random() * (measured + 1)) },
          { kind: 'scroll' as const, measured, qualified: Math.floor(random() * (measured + 1)) },
        ],
      };
    }),
    recent,
    hiddenAssetIds: random() < 0.3 ? [pick(random, snapshot.candidates).encounter.assetId] : [],
  };
}

function snapshotOf(index: number): ComposerSnapshot {
  const random = seededRandom(7_000 + index);
  const mode = MODES[index % MODES.length]!;
  const count = 6 + Math.floor(random() * 5);
  const candidates = Array.from({ length: count }, (_, n) => candidateOf(random, n));
  const source = candidates[0]!;
  const sticky = mode === 'vertical' && index % 3 === 1;
  const base: Omit<ComposerSnapshot, 'evidence'> = {
    universeId: 'fixture-universe',
    privacyEpoch: 1,
    evaluatedAt: '2026-10-30T12:00:00.000Z',
    seed: `fixture-seed-${String(index)}`,
    mode,
    intent: {
      language: 'en',
      topicIds: source.encounter.topics.filter((t) => t.role !== 'incidental').map((t) => t.topicId),
      text: `${source.encounter.metadata.title} ${source.encounter.metadata.summary}`,
      ...(mode === 'vertical' || mode === 'variant' ? { explanationUnitId: source.encounter.explanationUnitId } : {}),
      ...(mode === 'variant'
        ? { format: source.encounter.kind === 'reel' ? ('scroll' as const) : ('reel' as const) }
        : {}),
      ...(mode === 'return' ? { exactTarget: { assetId: candidates[1]!.encounter.assetId, assetRevision: 1 } } : {}),
      ...(sticky ? { stickyFormat: source.encounter.kind, currentSeriesId: 'fixture.series' } : {}),
    },
    source: { assetId: source.encounter.assetId, assetRevision: 1 },
    candidates:
      mode === 'horizontal'
        ? candidates.map((candidate, n) =>
            n === 0
              ? candidate
              : {
                  ...candidate,
                  continuity: {
                    linkId: `link-${String(n)}`,
                    source: { assetId: source.encounter.assetId, assetRevision: 1 },
                    target: { assetId: candidate.encounter.assetId, assetRevision: 1 },
                    direction: n % 2 === 0 ? ('next' as const) : ('related' as const),
                    strength: Math.round(random() * 100) / 100,
                  },
                },
          )
        : candidates,
    explorationPool:
      mode === 'vertical' ? candidates.map(({ encounter }) => ({ assetId: encounter.assetId, assetRevision: 1 })) : [],
    watermarks: {
      catalog: 'fixture-catalog',
      continuity: 'fixture-links',
      taxonomy: 'fixture-taxonomy',
      context: 'fixture-context',
    },
  };
  const evidence = evidenceOf(random, base);
  return {
    ...base,
    ...(evidence ? { evidence } : {}),
    ...(random() < 0.4
      ? {
          semanticAssessments: {
            roleVersion: 'jev.1/fixture',
            model: 'fixture-model',
            assessedAt: base.evaluatedAt,
            expiresAt: '2026-10-30T12:30:00.000Z',
            entries: candidates.slice(1, 4).map((candidate) => ({
              assetId: candidate.encounter.assetId,
              assetRevision: 1,
              relevance: Math.round(random() * 100) / 100,
              appropriateness: Math.round(random() * 100) / 100,
              redundancy: Math.round(random() * 100) / 100,
            })),
          },
        }
      : {}),
  };
}

/** `count` deterministic snapshots, cycling through the moves. */
export function fixtureSnapshots(count = 60): readonly ComposerSnapshot[] {
  return Array.from({ length: count }, (_, index) => snapshotOf(index));
}
