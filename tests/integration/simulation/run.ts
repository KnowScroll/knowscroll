import { collect, fingerprint, type DbSnapshot } from './collect.js';
import { PersonaRun } from './driver.js';
import { createRng, seedFrom } from './rng.js';
import type { PersonaSpec } from './persona.js';
import type { SimWorld } from './world.js';

/** One persona's finished session: what it did, what the product answered, and what the database holds. */
export interface PersonaResult {
  readonly run: PersonaRun;
  readonly db: DbSnapshot;
  /** Wall time of the whole session, milliseconds. */
  readonly millis: number;
  /** Drains after the last encounter, until nothing more happened or the bound was reached. */
  readonly settleDrains: number;
  /** Other people's steps that changed this person's evidence or places (side-by-side runs only). */
  readonly isolationBreaches: readonly { readonly actor: string; readonly tables: readonly string[] }[];
  /**
   * Proof that the isolation check can see: how many tables it fingerprints and how many of them changed over the
   * person's own session. A check that fingerprints nothing, or never sees a change, would pass for the wrong reason.
   */
  readonly isolationControl?: { readonly tables: number; readonly ownChanged: number };
}

function startRun(world: SimWorld, spec: PersonaSpec, person: Awaited<ReturnType<SimWorld['newPerson']>>) {
  const rng = createRng(seedFrom(world.config.seed, spec.id));
  return new PersonaRun(world, spec, person, rng, spec.encounters(world.config, world.library));
}

/**
 * After the last encounter the worker keeps draining: a run paced 30 seconds apart, a retried job, a
 * projection that wakes another. The lab drains up to the formation bound of times more and stops
 * early when a drain finds nothing to do.
 */
async function settle(world: SimWorld, run: PersonaRun): Promise<number> {
  let drains = 0;
  while (drains < world.config.bounds.formationDrains) {
    const report = await run.drain();
    drains += 1;
    if (Object.keys(report.handled).length === 0) break;
  }
  await run.recordFormation();
  await run.readQualifications();
  return drains;
}

/** Runs one persona alone from first move to settled worker. */
export async function runSolo(world: SimWorld, spec: PersonaSpec): Promise<PersonaResult> {
  const startedAt = performance.now();
  const person = await world.newPerson();
  const run = startRun(world, spec, person);
  while (await run.step()) {
    // each step is one encounter
  }
  const settleDrains = await settle(world, run);
  return {
    run,
    db: await collect(world, person.universeId),
    millis: performance.now() - startedAt,
    settleDrains,
    isolationBreaches: [],
  };
}

/**
 * Runs two personas in one world, one encounter each in turn. Before each person's step the other
 * person's evidence and places are fingerprinted, and again after it: nothing one person does may
 * change a row of the other's.
 */
export async function runSideBySide(
  world: SimWorld,
  first: PersonaSpec,
  second: PersonaSpec,
): Promise<readonly [PersonaResult, PersonaResult]> {
  const startedAt = performance.now();
  const a = startRun(world, first, await world.newPerson());
  const b = startRun(world, second, await world.newPerson());
  const startA = await fingerprint(world, a.person.universeId);
  const startB = await fingerprint(world, b.person.universeId);
  const breaches = new Map<PersonaRun, { actor: string; tables: string[] }[]>([
    [a, []],
    [b, []],
  ]);
  const turn = async (actor: PersonaRun, other: PersonaRun) => {
    const before = await fingerprint(world, other.person.universeId);
    const moved = await actor.step();
    const after = await fingerprint(world, other.person.universeId);
    const changed = Object.keys(after).filter((table) => before[table] !== after[table]);
    if (changed.length > 0) breaches.get(other)!.push({ actor: actor.spec.id, tables: changed });
    return moved;
  };
  let live = true;
  while (live) {
    const movedA = a.done ? false : await turn(a, b);
    const movedB = b.done ? false : await turn(b, a);
    live = movedA || movedB;
  }
  const settleA = await settle(world, a);
  const settleB = await settle(world, b);
  const millis = performance.now() - startedAt;
  const control = async (run: PersonaRun, start: Readonly<Record<string, string>>) => {
    const end = await fingerprint(world, run.person.universeId);
    return {
      tables: Object.keys(end).length,
      ownChanged: Object.keys(end).filter((table) => end[table] !== start[table]).length,
    };
  };
  return [
    {
      run: a,
      db: await collect(world, a.person.universeId),
      millis,
      settleDrains: settleA,
      isolationBreaches: breaches.get(a)!,
      isolationControl: await control(a, startA),
    },
    {
      run: b,
      db: await collect(world, b.person.universeId),
      millis,
      settleDrains: settleB,
      isolationBreaches: breaches.get(b)!,
      isolationControl: await control(b, startB),
    },
  ];
}
