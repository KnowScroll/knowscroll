/**
 * Labelled fixtures for visibility, presence and visit tests: authored geography rows written
 * straight to the tables (no formation, no Cartographer, no model) and the real Social and Geography
 * adapters over a test database. Nothing here claims that a person formed any place.
 */
import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { expect } from 'vitest';
import {
  fencePersonalRecording,
  makeWithPersonalScope,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import { FENCE_OWN_ACCOUNT } from '@knowscroll/backend/modules/identity';
import {
  accountAccessUseCases,
  identityScopeOwnerProviders,
} from '@knowscroll/backend/modules/identity/nest-providers';
import {
  GEOGRAPHY_APPLIED,
  READ_GEOGRAPHY_SCENE_INPUT,
  type ReadGeographySceneInput,
} from '@knowscroll/backend/modules/geography';
import { GEOGRAPHY_PORTS, geographyProviders } from '@knowscroll/backend/modules/geography/nest-providers';
import { visibilityUseCases, refreshVisitPublication } from '@knowscroll/backend/modules/social/nest-providers';
import { conversationUseCases, socialUseCases } from '@knowscroll/backend/modules/social/nest-providers';
import {
  makeReadPublicContent,
  readScrollPlayFacts,
  readShareableContent,
} from '@knowscroll/backend/modules/content/nest-providers';
import { buildFromProviders } from './providers.js';
import type { FixturePerson } from './fixtures.js';

export interface AuthoredPlanet {
  readonly conceptId: string;
  readonly label: string;
  readonly hypothetical?: boolean;
  /** Region concept ids, written so a test can prove no region ever reaches a visitor. */
  readonly regions?: readonly string[];
}
export interface AuthoredSystem {
  readonly conceptId: string;
  readonly label: string;
  readonly hypothetical?: boolean;
  readonly planets: readonly AuthoredPlanet[];
}

/** Every private identity a seeded universe holds, so a test can search an answer for each of them. */
export interface SeededWorld {
  readonly systems: readonly {
    readonly conceptId: string;
    readonly id: string;
    readonly planets: Map<string, string>;
  }[];
  readonly privateIds: readonly string[];
}

/** An earth system with three planets and a region, and a second system, both authored for CI. */
export const authoredWorld: readonly AuthoredSystem[] = [
  {
    conceptId: 'earth',
    label: 'Earth and climate',
    planets: [
      { conceptId: 'earth.seasons', label: 'Seasons', regions: ['earth.seasons.axial-tilt'] },
      { conceptId: 'earth.tides', label: 'Tides' },
    ],
  },
  { conceptId: 'space', label: 'Space', planets: [{ conceptId: 'space.stars', label: 'Stars' }] },
];

const key = (kind: string, conceptId: string, truth = 'factual') => `${kind}:${conceptId}:${truth}`;

/** Writes the authored systems (each with its star), planets and regions for `person`, at Geography revision 1. */
export async function seedAuthoredGeography(
  db: Kysely<Database>,
  person: FixturePerson,
  systems: readonly AuthoredSystem[] = authoredWorld,
): Promise<SeededWorld> {
  await db
    .insertInto('geography.state')
    .values({ universe_id: person.universeId, privacy_epoch: 1, revision: 1, structure_revision: 1 })
    .onConflict((conflict) => conflict.columns(['universe_id', 'privacy_epoch']).doNothing())
    .execute();
  const privateIds = [person.universeId, person.accountId];
  const seeded: SeededWorld['systems'][number][] = [];
  async function insert(kind: string, conceptId: string, parentKey: string, label: string, hypothetical = false) {
    const id = randomUUID();
    const truthStatus = hypothetical ? 'hypothetical' : 'factual';
    const semantic = key(kind, conceptId, truthStatus);
    await db
      .insertInto('geography.objects')
      .values({
        universe_id: person.universeId,
        privacy_epoch: 1,
        id,
        semantic_key: semantic,
        payload: {
          id,
          key: semantic,
          kind,
          conceptId,
          parentKey,
          truthStatus,
          label,
          labels: [label],
          objectRevision: 1,
          originTransitionId: randomUUID(),
          activity: { availability: 'available', state: 'active' },
        },
        support_refs: JSON.stringify([]),
      })
      .execute();
    privateIds.push(id);
    return { id, key: semantic };
  }
  for (const system of systems) {
    const truth = system.hypothetical ?? false;
    const placed = await insert('system', system.conceptId, 'universe', system.label, truth);
    await insert('star', system.conceptId, placed.key, `Star of ${system.label}`, truth);
    const planets = new Map<string, string>();
    for (const planet of system.planets) {
      const made = await insert('planet', planet.conceptId, placed.key, planet.label, planet.hypothetical ?? truth);
      planets.set(planet.conceptId, made.id);
      for (const region of planet.regions ?? [])
        await insert('region', region, made.key, `Region ${region}`, planet.hypothetical ?? truth);
    }
    seeded.push({ conceptId: system.conceptId, id: placed.id, planets });
  }
  return { systems: seeded, privateIds };
}

/** The real Geography read of the scene input, bound to a test database (the same adapter the API uses). */
export function geographyReader(db: Kysely<Database>): ReadGeographySceneInput {
  const SCOPE = Symbol('scope'),
    ENQUEUE = Symbol('enqueue'),
    providers = geographyProviders({ withPersonalScope: SCOPE, enqueueJob: ENQUEUE });
  const values = new Map<symbol, unknown>([
    [SCOPE, makeWithPersonalScope(db, { lockTimeoutMs: 5000 })],
    [FENCE_OWN_ACCOUNT, accountAccessUseCases({ db, lockTimeoutMs: 5000 }).fenceOwnAccount],
    [ENQUEUE, undefined],
    [GEOGRAPHY_APPLIED, undefined],
    ...identityScopeOwnerProviders().map((p) => [p.provide, p.useValue] as const),
  ]);
  // Reading a scene input touches only the owner check and the store; the other ports are never called.
  for (const provider of providers)
    for (const token of provider.inject) if (!values.has(token)) values.set(token, undefined);
  values.set(GEOGRAPHY_PORTS, buildFromProviders(providers, GEOGRAPHY_PORTS, values));
  return buildFromProviders(providers, READ_GEOGRAPHY_SCENE_INPUT, values) as ReadGeographySceneInput;
}

/** Friends, Talk, visibility and the visit refresh over one database; `clock.now` moves time. */
export function visitCases(db: Kysely<Database>, clock: { now: Date } = { now: new Date('2026-10-24T08:00:00Z') }) {
  const access = accountAccessUseCases({ db, lockTimeoutMs: 10_000 });
  const withScope = makeWithPersonalScope(db, { lockTimeoutMs: 10_000 });
  const readGeography = geographyReader(db);
  const deps = {
    withScope,
    fencePair: access.fenceAccountPair,
    fenceOwn: access.fenceOwnAccount,
    now: () => clock.now,
  };
  return {
    clock,
    friends: socialUseCases(deps),
    visibility: visibilityUseCases({ ...deps, readGeography }),
    refresh: refreshVisitPublication({ withScope, readGeography, now: () => clock.now }),
    talk: conversationUseCases({
      ...deps,
      db,
      readContent: readShareableContent,
      readPublicContent: makeReadPublicContent(db),
      readCallFacts: readScrollPlayFacts,
      fenceRecording: fencePersonalRecording,
    }),
  };
}

/** The caller's own visibility read, which must succeed. */
export async function ownVisibility(cases: ReturnType<typeof visitCases>, person: FixturePerson) {
  const read = await cases.visibility.readVisibility(person.authority);
  if (read.kind !== 'ok') throw new Error('CI visibility read refused');
  return read.value;
}

/** Sets the audience and the shared systems from the person's current revision. */
export async function setVisibility(
  cases: ReturnType<typeof visitCases>,
  person: FixturePerson,
  audience: { mode: 'nobody' } | { mode: 'all_friends' } | { mode: 'chosen_friends'; personIds: string[] },
  sharedSystemIds: string[],
) {
  const current = await ownVisibility(cases, person);
  return cases.visibility.setVisibility(person.authority, {
    version: 'sharing.v1',
    commandId: randomUUID(),
    expectedVisibilityRevision: current.visibilityRevision,
    audience,
    sharedSystemIds,
  });
}

/** The visit read of a friend by public person ID. */
export function visit(
  cases: ReturnType<typeof visitCases>,
  visitor: FixturePerson,
  target: { kind: 'person'; personId: string } | { kind: 'handle'; handle: string },
) {
  return cases.visibility.readVisit(visitor.authority, {
    version: 'sharing.v1',
    target,
    capabilities: { presentations: ['list.v1'] },
  });
}

/** Asserts the answer is an accepted command. */
export function expectAccepted(result: { kind: string }): void {
  expect(result.kind).toBe('ok');
}
