import { describe, expect, it } from 'vitest';
import { gapIdentity, priorityOf, type GapCandidate, type GapKind } from '../domain/gaps.js';
import { catalogueTopics } from './gap-signals.js';
import { makeScanGaps } from './gap-scan.js';
import type { GapRow, GapScanPorts, GapScanTx, SignalDay } from './gap-ports.js';

/** Labelled CI fixtures over the library's own catalogue: no recipe, Scroll or reader is real. */
const [FIRST, SECOND] = catalogueTopics() as [
  ReturnType<typeof catalogueTopics>[number],
  ReturnType<typeof catalogueTopics>[number],
];
const now = new Date('2026-11-11T12:00:00Z');

interface Stored {
  id: string;
  kind: GapKind;
  planet: string;
  facet?: string;
  status: GapRow['status'];
  priority: number;
  readers: number;
  recipes: string[];
  reason?: string;
  attempts: number;
}

/** An in-memory store with the one rule the table has: one open row for a key. */
function world(options: {
  enabled?: boolean;
  released?: { topicId: string; units: number; facets: { facetId: string; units: number }[] }[];
  signals?: SignalDay[];
  gaps?: Stored[];
  rejected?: { kind: GapKind; planet: string; facet?: string; reason: string; endedAt: Date }[];
  states?: Record<string, 'published' | 'held' | 'stopped' | 'running'>;
  busy?: boolean;
  depthTarget?: number;
}) {
  const gaps: Stored[] = options.gaps ?? [];
  const calls: string[] = [];
  let id = 0;
  const tx: GapScanTx = {
    rollUpMarks: () => Promise.resolve(2),
    purge: () => Promise.resolve({ marks: 1, signals: 0, gaps: 0 }),
    readSignals: () => Promise.resolve(options.signals ?? []),
    readLiveGaps: () =>
      Promise.resolve(
        gaps
          .filter((gap) => !['closed', 'rejected'].includes(gap.status))
          .map((gap): GapRow => ({ ...gap, firstSeenAt: now })),
      ),
    readLastRejected: () => Promise.resolve(options.rejected ?? []),
    createGap: (candidate: GapCandidate, priority) => {
      const open = gaps.find(
        (gap) =>
          gap.kind === candidate.kind &&
          gap.planet === candidate.planet &&
          gap.facet === candidate.facet &&
          !['closed', 'rejected'].includes(gap.status),
      );
      if (open) return Promise.resolve(false);
      id += 1;
      gaps.push({
        id: `gap-${String(id)}`,
        kind: candidate.kind,
        planet: candidate.planet,
        ...(candidate.facet === undefined ? {} : { facet: candidate.facet }),
        status: 'open',
        priority,
        readers: candidate.readers,
        recipes: [],
        attempts: 0,
      });
      return Promise.resolve(true);
    },
    refreshGap: (gapId, candidate, priority) => {
      const gap = gaps.find((g) => g.id === gapId)!;
      gap.priority = priority;
      gap.readers = candidate.readers;
      calls.push(`refresh ${gapId}`);
      return Promise.resolve();
    },
    closeGap: (gapId, reason) => {
      const gap = gaps.find((g) => g.id === gapId)!;
      gap.status = 'closed';
      gap.reason = reason;
      calls.push(`close ${gapId} ${reason}`);
      return Promise.resolve();
    },
    reopenGap: (gapId) => {
      const gap = gaps.find((g) => g.id === gapId)!;
      gap.status = 'open';
      gap.recipes = [];
      calls.push(`reopen ${gapId}`);
      return Promise.resolve();
    },
  };
  const ports: GapScanPorts = {
    enabled: options.enabled ?? true,
    depthTarget: options.depthTarget ?? 6,
    store: { exclusively: (work) => (options.busy ? Promise.resolve(undefined) : work(tx)) },
    readCoverage: () => Promise.resolve({ planets: options.released ?? [] }),
    readRecipeStates: (keys) =>
      Promise.resolve(
        new Map(keys.flatMap((key) => (options.states?.[key] ? [[key, options.states[key]] as const] : []))),
      ),
    now: () => now,
    newId: () => 'unused',
  };
  return { scan: makeScanGaps(ports), gaps, calls };
}

const everyCatalogueTopic = () => catalogueTopics().length;

describe('the scan opens one gap for each hole', () => {
  it('opens a gap for every planet with nothing released, and a second scan opens none', async () => {
    const w = world({});
    const first = await w.scan();
    expect(first).toMatchObject({ kind: 'scanned', opened: everyCatalogueTopic(), closed: 0 });
    expect(w.gaps.every((gap) => gap.kind === 'thin_planet' && gap.status === 'open')).toBe(true);
    const second = await w.scan();
    expect(second).toMatchObject({ kind: 'scanned', opened: 0, refreshed: everyCatalogueTopic() });
    expect(w.gaps).toHaveLength(everyCatalogueTopic());
    // One row for each key, whatever the scan is run for.
    expect(new Set(w.gaps.map((gap) => gapIdentity(gap.kind, gap))).size).toBe(w.gaps.length);
  });

  it('gives a planet with nothing released the highest severity and counts the marks it rolled up', async () => {
    const w = world({});
    const result = await w.scan();
    expect(result).toMatchObject({ counted: 2, purged: 1 });
    expect(w.gaps[0]!.priority).toBe(priorityOf(5, 0));
  });

  it('adds counted readers to the hole they point to, ordering by readers within a severity', async () => {
    const w = world({ signals: [{ planet: SECOND.id, day: '2026-11-11', readers: 7 }] });
    await w.scan();
    const first = w.gaps.find((gap) => gap.planet === FIRST.id)!;
    const second = w.gaps.find((gap) => gap.planet === SECOND.id)!;
    expect(second.readers).toBe(7);
    expect(second.priority).toBeGreaterThan(first.priority);
  });

  it('opens a demand gap for a planet that has no hole when readers point to it', async () => {
    const full = { topicId: FIRST.id, units: 9, facets: FIRST.facets.map((facetId) => ({ facetId, units: 3 })) };
    const w = world({
      released: [full],
      signals: [{ planet: FIRST.id, facet: FIRST.facets[0]!, day: '2026-11-11', readers: 4 }],
    });
    await w.scan();
    expect(w.gaps.find((gap) => gap.planet === FIRST.id)).toMatchObject({
      kind: 'demand',
      facet: FIRST.facets[0],
      readers: 4,
    });
  });
});

describe('the scan closes what is filled', () => {
  const stale = (over: Partial<Stored>): Stored => ({
    id: 'old',
    kind: 'thin_planet',
    planet: FIRST.id,
    status: 'open',
    priority: 500,
    readers: 0,
    recipes: [],
    attempts: 0,
    ...over,
  });
  const full = { topicId: FIRST.id, units: 9, facets: FIRST.facets.map((facetId) => ({ facetId, units: 3 })) };

  it('closes an open, briefed or blocked gap whose hole is gone, and keeps a blocked one while the hole remains', async () => {
    const gone = world({
      released: [full],
      gaps: [stale({ id: 'a' }), stale({ id: 'b', status: 'briefed' }), stale({ id: 'c', status: 'blocked_unknown' })],
    });
    await gone.scan();
    expect(gone.calls).toEqual(expect.arrayContaining(['close a filled', 'close b filled', 'close c filled']));
    // While the hole remains a blocked gap stays blocked: its attempt is never resent.
    const remains = world({ gaps: [stale({ id: 'c', status: 'blocked_unknown' })] });
    await remains.scan();
    expect(remains.gaps.find((gap) => gap.id === 'c')!.status).toBe('blocked_unknown');
    expect(remains.calls).toEqual(['refresh c']);
  });

  it('closes a commissioned gap whose recipe was released, and reopens one whose recipes all ended while the hole remains', async () => {
    const w = world({
      gaps: [
        stale({ id: 'done', status: 'commissioned', recipes: ['gen-a'] }),
        stale({ id: 'ended', planet: SECOND.id, status: 'commissioned', recipes: ['gen-b'] }),
        stale({ id: 'waiting', planet: catalogueTopics()[2]!.id, status: 'commissioned', recipes: ['gen-c'] }),
      ],
      states: { 'gen-a': 'published', 'gen-b': 'stopped', 'gen-c': 'held' },
    });
    await w.scan();
    expect(w.calls).toContain('close done released');
    expect(w.calls).toContain('reopen ended');
    expect(w.calls.filter((call) => call.endsWith('waiting'))).toEqual(['refresh waiting']);
  });
});

describe('a key that was rejected before', () => {
  const rejected = (reason: string, daysAgo: number) => ({
    kind: 'thin_planet' as const,
    planet: FIRST.id,
    reason,
    endedAt: new Date(now.getTime() - daysAgo * 86_400_000),
  });

  it('is not opened again by the structure that was there, whatever the reason', async () => {
    const w = world({ rejected: [rejected('nothing_accepted', 30)] });
    await w.scan();
    expect(w.gaps.find((gap) => gap.planet === FIRST.id)).toBeUndefined();
  });

  it('is opened again by readers since, when the reason allows and the cooldown has passed', async () => {
    const reopenable = world({
      rejected: [rejected('nothing_accepted', 30)],
      signals: [{ planet: FIRST.id, day: '2026-11-10', readers: 2 }],
    });
    await reopenable.scan();
    expect(reopenable.gaps.find((gap) => gap.planet === FIRST.id)).toMatchObject({ kind: 'thin_planet', readers: 2 });
    const final = world({
      rejected: [rejected('facet_unknown', 30)],
      signals: [{ planet: FIRST.id, day: '2026-11-10', readers: 2 }],
    });
    await final.scan();
    expect(final.gaps.find((gap) => gap.planet === FIRST.id)).toBeUndefined();
  });

  it('is looked at again after the cooldown with no readers when it held no page, and not before', async () => {
    const waited = world({ rejected: [rejected('no_candidate_pages', 30)] });
    await waited.scan();
    expect(waited.gaps.find((gap) => gap.planet === FIRST.id)).toMatchObject({ kind: 'thin_planet', readers: 0 });
    const soon = world({ rejected: [rejected('no_candidate_pages', 2)] });
    await soon.scan();
    expect(soon.gaps.find((gap) => gap.planet === FIRST.id)).toBeUndefined();
  });
});

describe('the switch and the lock', () => {
  it('does nothing and reads nothing where the loop is off', async () => {
    const w = world({ enabled: false });
    expect(await w.scan()).toEqual({ kind: 'disabled' });
    expect(w.gaps).toEqual([]);
  });

  it('does not run while another scan holds the lock', async () => {
    const w = world({ busy: true });
    expect(await w.scan()).toEqual({ kind: 'busy' });
    expect(w.gaps).toEqual([]);
  });
});
