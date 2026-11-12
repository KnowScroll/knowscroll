import { createHmac } from 'node:crypto';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import {
  CONCEPT_CATALOGUE_VERSION,
  fixtureSnapshot,
  planSnapshot,
  type Catalogue as CatalogueSource,
  type CatalogueSnapshot,
} from '../../content/public.js';
import type { RecordingScopeTx } from '../../identity/public.js';
import type { CoverageProbe } from '../../personal-context/public.js';
import { pinCatalogue } from '../application/catalogue.js';
import type { Catalogue, CatalogueTopic } from '../domain/catalogue.js';
import { newestKeysPerFacet } from '../domain/evaluation.js';
import { unreadRetryMs, type PlaceSchedule } from '../domain/quiet.js';
import { routeKey } from '../domain/ids.js';
import type { Place, Route } from '../domain/policy.js';
import type { UniverseDelta } from '@knowscroll/contracts';
import type { GeographyPorts, GeographyState } from '../application/ports.js';

/**
 * An in-memory world for unit tests of incremental formation: the Personal Context ports (dirty set, bounded keys, the trusted
 * read) and the Geography store, over authored readings of the real concept catalogue. It implements the ports exactly as the
 * Postgres adapters promise them (a reading marks its topic dirty at the revision it commits at; the dirty read is newest
 * first; the keys read are the newest few per facet), so the same prepare and apply code runs over it. None of it is a
 * person's reading.
 */
export interface Reading {
  readonly topicId: string;
  readonly facetId: string;
  readonly unit: string;
  readonly at: string;
}

export const NOW = '2026-10-20T00:00:00.000Z';
const hash = (value: unknown) => canonicalSha256(value);
const truthSha256 = hash({ kind: 'factual' });
export const uuid = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;

export type TrustedRead = ReturnType<typeof unreadable> | ReturnType<typeof coverageOf>;
export const unreadable = (reason: 'limit' | 'authority_changed' | 'not_observed') =>
  ({
    version: 'trusted-coverage-read.v1',
    completeness: 'not_asserted',
    supportedFormats: ['scroll', 'reel'],
    availability: 'unavailable',
    reason,
    supports: [],
    witnesses: [],
    certificates: [],
  }) as const;

/** The trusted read of these readings: one witness per support key, the newest. */
export function coverageOf(catalogue: Catalogue, readings: readonly Reading[], padding = 0) {
  const newest = new Map<string, Reading>();
  for (const reading of readings) {
    const key = `${reading.topicId}|${reading.facetId}|${reading.unit}`;
    const best = newest.get(key);
    if (!best || Date.parse(reading.at) >= Date.parse(best.at)) newest.set(key, reading);
  }
  const rows = [...newest.values()].map((reading) => {
    const topic = catalogue.topic(reading.topicId)!;
    const facet = topic.facets.find((entry) => entry.id === reading.facetId)!;
    const support = {
      topicId: reading.topicId,
      facetId: reading.facetId,
      meaningSha256: hash({
        topicId: topic.id,
        topicMeaning: topic.meaning,
        facetId: facet.id,
        facetMeaning: facet.meaning,
      }),
      explanationUnitId: reading.unit,
      truthSha256,
    };
    const witnessKey = `${hash(reading)}${'x'.repeat(padding)}`;
    const identity = {
      sourceKind: 'segment' as const,
      recordingGeneration: 1,
      activityId: uuid(1),
      qualificationId: uuid(2),
      certificateSha256: hash({ witnessKey }),
    };
    const exposureId = `0199a000-0000-7000-9000-${hash(reading).slice(0, 12)}`;
    return {
      support: { ...support, witnessExposureIds: [exposureId] },
      witness: { ...support, ...identity, exposureId, witnessKey },
      certificate: {
        witnessKey,
        ...identity,
        certificate: {
          exposureId,
          availability: 'available',
          explanationUnitId: reading.unit,
          activatedAt: reading.at,
          mapping: { framing: 'factual', catalogueVersion: CONCEPT_CATALOGUE_VERSION, framingSha256: truthSha256 },
        },
      },
    };
  });
  return {
    version: 'trusted-coverage-read.v1',
    completeness: 'not_asserted',
    supportedFormats: ['scroll', 'reel'],
    availability: 'available',
    reason: 'current',
    supports: rows.map((row) => row.support),
    witnesses: rows.map((row) => row.witness),
    certificates: rows.map((row) => row.certificate),
  } as const;
}

export interface Counters {
  trustedReads: number;
  inputReads: { topicIds: readonly string[]; maxTopics: number | undefined }[];
  dirtyReads: number;
}

export interface WorldOptions {
  /** Invented topics instead of the library plan's (a labelled fixture catalogue, release 1). */
  readonly catalogue?: readonly CatalogueTopic[];
  /** Or an exact release of the catalogue. */
  readonly snapshot?: CatalogueSnapshot;
  /** The trusted read answers this for a batch of probes, instead of what the readings hold. */
  readonly trusted?: (probes: readonly CoverageProbe[]) => TrustedRead;
  /** Extra characters in every witness, to make a context large. */
  readonly padding?: number;
  readonly secret?: string;
}

/** A universe held in memory: readings, stored places, the dirty set and the Geography state. */
export class World {
  readonly readings: Reading[] = [];
  /** Keys whose trusted read is refused, as if the content were withdrawn: `topic|facet|unit`. */
  readonly untrusted = new Set<string>();
  readonly objects = new Map<
    string,
    Place & { lastSupportAt?: string; quietCheckAt?: string; quietAttempts?: number }
  >();
  readonly routes = new Map<string, Route>();
  readonly dirty = new Map<string, number>();
  /** Dirty rows in backoff: when each may be tried again (ms since the epoch) and how many times it was tried. */
  readonly backoff = new Map<string, { retryAt: number; attempts: number }>();
  readonly deltas = new Map<string, { hash: string; delta: UniverseDelta }>();
  readonly counters: Counters = { trustedReads: 0, inputReads: [], dirtyReads: 0 };
  /** The catalogue the world started with, pinned: what readings are authored against. */
  readonly catalogue: Catalogue;
  /** Every release the world holds, by number, and the one that is current: a later release is made with `release`. */
  readonly releases = new Map<number, CatalogueSnapshot>();
  currentRelease = 1;
  secret: string | undefined;
  now = NOW;
  /** The personal scope revision the next change commits at, minus one: what a transaction entering now sees. */
  revision = 1;
  state: GeographyState = {
    revision: 0,
    structureRevision: 0,
    activityRevision: 0,
    desiredRevision: 5,
    materialRevision: 5,
    publishedRevision: 0,
  };
  ids = 0;

  constructor(readonly options: WorldOptions = {}) {
    const initial =
      options.snapshot ??
      (options.catalogue
        ? fixtureSnapshot(
            options.catalogue.map((topic) => ({
              id: topic.id,
              parent: topic.parent,
              facets: topic.facets.map((facet) => facet.id),
            })),
          )
        : planSnapshot());
    this.releases.set(initial.releaseId, initial);
    this.currentRelease = initial.releaseId;
    this.catalogue = pinCatalogue(initial);
    this.secret = options.secret;
  }

  /** The topic catalogue as the services read it: the current release, and any earlier one by number. */
  get source(): CatalogueSource {
    return {
      current: () => Promise.resolve(this.releases.get(this.currentRelease)!),
      release: (releaseId) => Promise.resolve(this.releases.get(releaseId)),
    };
  }

  /** A later release of the catalogue becomes the current one; earlier releases stay readable. */
  release(snapshot: CatalogueSnapshot): void {
    this.releases.set(snapshot.releaseId, snapshot);
    this.currentRelease = snapshot.releaseId;
  }

  /** One encounter: a reference is added to a support key, and its topic is marked dirty at the revision it commits at. */
  read(...readings: readonly { topicId: string; facetId: string; unit: string; at?: string }[]): void {
    for (const reading of readings) this.readings.push({ ...reading, at: reading.at ?? this.now });
    for (const topic of new Set(readings.map((reading) => reading.topicId))) this.markDirty(topic);
    this.revision += 1;
  }

  /** The dirty topics not waiting out a backoff: what a run takes now. */
  eligibleDirty(): string[] {
    const at = new Date(this.now).getTime();
    return [...this.dirty.keys()].filter((topic) => (this.backoff.get(topic)?.retryAt ?? 0) <= at);
  }

  /** A change with no reading of its own (content restored, a re-read) commits and marks the topic dirty. */
  touch(topic: string): void {
    this.markDirty(topic);
    this.revision += 1;
  }

  /** A topic's trusted support changed: it is dirty at the revision the change commits at, and out of any backoff. */
  markDirty(topic: string): void {
    this.dirty.set(topic, this.revision + 1);
    this.backoff.delete(topic);
  }

  /** The newest key of each support, with when its newest reading was activated. */
  keys(): (CoverageProbe & { lastActivatedAt: string })[] {
    const keys = new Map<string, CoverageProbe & { lastActivatedAt: string }>();
    for (const reading of this.readings) {
      const key = `${reading.topicId}|${reading.facetId}|${reading.unit}`;
      const best = keys.get(key);
      if (!best || Date.parse(reading.at) > Date.parse(best.lastActivatedAt))
        keys.set(key, {
          topicId: reading.topicId,
          facetId: reading.facetId,
          explanationUnitId: reading.unit,
          lastActivatedAt: reading.at,
        });
    }
    return [...keys.values()];
  }

  readonly cap = (): RecordingScopeTx =>
    ({
      personal: { authority: { universeId: uuid(7), privacyEpoch: 1 }, revisionAtEntry: this.revision },
      generation: 1,
    }) as unknown as RecordingScopeTx;

  nextId() {
    return uuid(1000 + this.ids++);
  }

  /** The ports the prepare and apply code reads and writes through, over this world. */
  ports(): GeographyPorts {
    return portsOf(this);
  }

  /** The semantic keys of the stored places, sorted. */
  keysOfPlaces(): string[] {
    return [...this.objects.keys()].sort();
  }
}

/** Three distinct units over two facets of a topic: enough for the rules to form its planet. */
export function planetReadings(catalogue: Catalogue, topicId: string, at: string = NOW): Reading[] {
  const topic = catalogue.topic(topicId)!;
  return [
    { topicId, facetId: topic.facets[0]!.id, unit: `${topicId}:a`, at },
    { topicId, facetId: topic.facets[1]!.id, unit: `${topicId}:b`, at },
    { topicId, facetId: topic.facets[0]!.id, unit: `${topicId}:c`, at },
  ];
}

/** The ports over a world: the Personal Context ports and the Geography store, implemented as the Postgres adapters promise them. */
function portsOf(world: World): GeographyPorts {
  const store = {
    root: () => Promise.resolve({ accountId: uuid(9), revision: world.revision }),
    state: () => Promise.resolve(world.state),
    writeState: (_scope: unknown, state: GeographyState) => {
      world.state = state;
      return Promise.resolve();
    },
    structure: () => Promise.resolve({ objects: world.objects.size, relations: world.routes.size }),
    places: (_scope: unknown, keys: readonly string[]) =>
      Promise.resolve(
        keys.flatMap((key) => {
          const stored = world.objects.get(key);
          return stored ? [{ place: stored, lastSupportAt: stored.lastSupportAt }] : [];
        }),
      ),
    placesById: (_scope: unknown, ids: readonly string[]) =>
      Promise.resolve([...world.objects.values()].filter((place) => ids.includes(place.id))),
    routes: (_scope: unknown, keys: readonly string[]) =>
      Promise.resolve(keys.flatMap((key) => (world.routes.has(key) ? [world.routes.get(key)!] : []))),
    placeSecret: (_scope: unknown, create: boolean) => {
      if (world.secret === undefined && create) world.secret = hash({ secret: world.ids++ });
      return Promise.resolve(world.secret);
    },
    saveSchedule: (_scope: unknown, schedules: readonly PlaceSchedule[]) => {
      for (const schedule of schedules) {
        const stored = world.objects.get(schedule.key);
        if (!stored) continue;
        if (schedule.lastSupportAt === null) delete stored.lastSupportAt;
        else stored.lastSupportAt = schedule.lastSupportAt;
        if (schedule.quietCheckAt === null) delete stored.quietCheckAt;
        else stored.quietCheckAt = schedule.quietCheckAt;
        delete stored.quietAttempts;
      }
      return Promise.resolve();
    },
    deferQuiet: (_scope: unknown, ids: readonly string[], at: Date) => {
      for (const stored of world.objects.values()) if (ids.includes(stored.id)) stored.quietCheckAt = at.toISOString();
      return Promise.resolve();
    },
    backOffQuiet: (_scope: unknown, ids: readonly string[], now: Date) => {
      for (const stored of world.objects.values()) {
        if (!ids.includes(stored.id)) continue;
        const looks = (stored.quietAttempts ?? 0) + 1;
        stored.quietAttempts = looks;
        const wait = unreadRetryMs(looks);
        if (wait === undefined) delete stored.quietCheckAt;
        else stored.quietCheckAt = new Date(now.getTime() + wait).toISOString();
      }
      return Promise.resolve();
    },
    duePlaces: (_scope: unknown, at: Date, limit: number) =>
      Promise.resolve(
        [...world.objects.values()]
          .filter((stored) => stored.quietCheckAt !== undefined && Date.parse(stored.quietCheckAt) <= at.getTime())
          .slice(0, limit),
      ),
    findDelta: (_scope: unknown, transitionId: string) => Promise.resolve(world.deltas.get(transitionId)),
    writeDelta: (_scope: unknown, _runId: string | undefined, deltaHash: string, delta: UniverseDelta) => {
      world.deltas.set(delta.transitionId, { hash: deltaHash, delta });
      return Promise.resolve();
    },
    saveObject: (_scope: unknown, place: Place) => {
      world.objects.set(place.key, { ...(world.objects.get(place.key) ?? {}), ...place });
      return Promise.resolve();
    },
    saveRoute: (_scope: unknown, route: Route) => {
      world.routes.set(routeKey(route.fromKey, route.toKey), route);
      return Promise.resolve();
    },
  };
  const ports = {
    store,
    ownerActive: () => Promise.resolve(true),
    advance: () => Promise.resolve(world.revision + 1),
    enqueueDelta: () => Promise.resolve(),
    applied: () => Promise.resolve(),
    readDirty: (_scope: unknown, { limit }: { limit: number }) => {
      world.counters.dirtyReads++;
      const now = new Date(world.now).getTime();
      const waiting = [...world.backoff].filter(([topic, wait]) => world.dirty.has(topic) && wait.retryAt > now);
      const ordered = [...world.dirty]
        .filter(([topic]) => (world.backoff.get(topic)?.retryAt ?? 0) <= now)
        .sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
      const next = waiting.map(([, wait]) => wait.retryAt).sort((a, b) => a - b)[0];
      return Promise.resolve({
        revision: world.revision,
        topics: ordered.slice(0, limit).map(([topic]) => topic),
        hasMore: ordered.length > limit,
        anySupport: world.readings.length > 0,
        nextRetryAt: next === undefined ? null : new Date(next).toISOString(),
      });
    },
    clearDirty: (
      _scope: unknown,
      {
        topicIds,
        throughRevision,
        deferTopicIds = [],
        maxAttempts,
      }: {
        topicIds: readonly string[];
        throughRevision: number;
        deferTopicIds?: readonly string[];
        maxAttempts?: number;
      },
    ) => {
      const now = new Date(world.now).getTime();
      for (const topic of deferTopicIds) {
        if ((world.dirty.get(topic) ?? Infinity) > throughRevision) continue;
        const attempts = world.backoff.get(topic)?.attempts ?? 0;
        if (maxAttempts !== undefined && attempts + 1 >= maxAttempts) {
          world.dirty.delete(topic);
          world.backoff.delete(topic);
        } else
          world.backoff.set(topic, {
            retryAt: now + Math.min(3_600_000, 60_000 * 2 ** Math.min(attempts, 20)),
            attempts: attempts + 1,
          });
      }
      let removed = 0;
      for (const topic of topicIds)
        if ((world.dirty.get(topic) ?? Infinity) <= throughRevision) {
          world.dirty.delete(topic);
          world.backoff.delete(topic);
          removed++;
        }
      return Promise.resolve(removed);
    },
    markDirty: () => {
      const topics = new Set(world.readings.map((reading) => reading.topicId));
      for (const topic of topics) world.markDirty(topic);
      return Promise.resolve(topics.size);
    },
    readInputs: (
      _scope: unknown,
      query: {
        topicIds?: readonly string[];
        recent?: { limit: number; exclude: readonly string[] };
        perFacet: number;
        maxTopics?: number;
        page?: number;
        onlyFacets?: readonly { topicId: string; facetId: string }[];
      },
    ) => {
      world.counters.inputReads.push({ topicIds: query.topicIds ?? [], maxTopics: query.maxTopics });
      const newestOf = new Map<string, string>();
      for (const key of world.keys())
        if (!newestOf.has(key.topicId) || key.lastActivatedAt > newestOf.get(key.topicId)!)
          newestOf.set(key.topicId, key.lastActivatedAt);
      const named = query.recent ? undefined : new Set(query.topicIds);
      const excluded = new Set(query.recent?.exclude ?? []);
      // Topics newest first (the topic whose newest key is most recent), as the Postgres port orders `maxTopics` and `recent`.
      const supported = [...newestOf.keys()]
        .filter((topic) => (named ? named.has(topic) : !excluded.has(topic)))
        .sort((a, b) => newestOf.get(b)!.localeCompare(newestOf.get(a)!) || a.localeCompare(b))
        .slice(0, query.recent ? query.recent.limit : (query.maxTopics ?? Infinity));
      const only = query.onlyFacets && new Set(query.onlyFacets.map((f) => `${f.topicId}|${f.facetId}`));
      const page = query.page ?? 0;
      const keys = world
        .keys()
        .filter((key) => supported.includes(key.topicId) && (!only || only.has(`${key.topicId}|${key.facetId}`)))
        .map((key) => ({ ...key }));
      const probes = newestKeysPerFacet(
        keys.map((key) => ({ ...key, lastActivatedAt: key.lastActivatedAt })),
        (page + 1) * query.perFacet,
      )
        .sort(
          (a, b) =>
            a.topicId.localeCompare(b.topicId) ||
            a.facetId.localeCompare(b.facetId) ||
            (a.lastActivatedAt !== b.lastActivatedAt
              ? b.lastActivatedAt.localeCompare(a.lastActivatedAt)
              : a.explanationUnitId.localeCompare(b.explanationUnitId)),
        )
        .filter((key, index, all) => {
          // The `page`th run of `perFacet` keys of each facet, newest first.
          const rank = all
            .slice(0, index)
            .filter((other) => other.topicId === key.topicId && other.facetId === key.facetId).length;
          return rank >= page * query.perFacet;
        })
        .map(({ topicId, facetId, explanationUnitId }) => ({ topicId, facetId, explanationUnitId }));
      return Promise.resolve({
        revision: world.revision,
        topics: only ? [...new Set(probes.map((probe) => probe.topicId))] : supported,
        probes,
      });
    },
    readTrusted: (_scope: unknown, query: { probes: readonly CoverageProbe[] }) => {
      world.counters.trustedReads++;
      if (world.options.trusted) return Promise.resolve(world.options.trusted(query.probes));
      const wanted = world.readings.filter(
        (reading) =>
          !world.untrusted.has(`${reading.topicId}|${reading.facetId}|${reading.unit}`) &&
          query.probes.some(
            (probe) =>
              probe.topicId === reading.topicId &&
              probe.facetId === reading.facetId &&
              probe.explanationUnitId === reading.unit,
          ),
      );
      return Promise.resolve(
        wanted.length ? coverageOf(world.catalogue, wanted, world.options.padding ?? 0) : unreadable('not_observed'),
      );
    },
    catalogue: world.source,
    hash,
    mac: (secret: string, message: string) =>
      createHmac('sha256', Buffer.from(secret, 'hex')).update(message).digest('hex'),
    seed: () => hash({ seed: world.ids++ }),
    newId: () => world.nextId(),
    now: () => new Date(world.now),
  };
  return ports as unknown as GeographyPorts;
}
