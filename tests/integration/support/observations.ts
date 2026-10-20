import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { InteractionEvent } from '@knowscroll/contracts';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import type { TestDatabase } from './database.js';
import type { FixturePerson } from './fixtures.js';
import { textCapabilities, type scrollUseCases } from './scroll.js';

export interface OpenedFixture {
  readonly exposureId: string;
  readonly assetId: string;
  readonly assetRevision: number;
}

/** Opens and activates an exposure of `starter` for `person` through the real use cases. */
export async function openActive(
  useCases: Awaited<ReturnType<typeof scrollUseCases>>,
  person: FixturePerson,
  starter: { readonly assetId: string; readonly revision: number },
  options: { readonly activate?: boolean } = {},
): Promise<OpenedFixture> {
  const opened = await useCases.openExposure(person.authority, {
    commandId: randomUUID(),
    target: { kind: 'scroll', assetId: starter.assetId },
    origin: { kind: 'direct' },
    capabilities: textCapabilities,
  });
  if (opened.kind !== 'opened') throw new Error('fixture open refused');
  if (options.activate !== false) {
    const activated = await useCases.activateExposure(person.authority, {
      commandId: randomUUID(),
      exposureId: opened.outcome.exposureId,
    });
    if (activated.kind !== 'activated') throw new Error('fixture activation refused');
  }
  return { exposureId: opened.outcome.exposureId, assetId: starter.assetId, assetRevision: starter.revision };
}

/**
 * Pretends the exposure was activated `minutesAgo` minutes ago, so honest claims of that much
 * reading time are within the elapsed wall time the intake bounds them by.
 */
export async function activatedAgo(
  db: TestDatabase<Database>['db'],
  exposureId: string,
  minutesAgo: number,
): Promise<void> {
  await sql`update experience.exposures set opened_at = now() - make_interval(mins => ${minutesAgo + 1}), activated_at = now() - make_interval(mins => ${minutesAgo}) where id = ${exposureId}`.execute(
    db,
  );
}

/** The next device sequence per recorder session and exposure: 1, 2, 3 ... like a real recorder. */
const sequences = new Map<string, number>();

/** One valid event of `kind` for the exposure, with a fresh event ID unless one is given. */
export function event(
  exposure: OpenedFixture,
  body: Pick<InteractionEvent, 'kind' | 'payload'>,
  overrides: {
    readonly eventId?: string;
    readonly sessionId?: string;
    readonly deviceSequence?: number;
    readonly occurredAt?: string;
  } = {},
): InteractionEvent {
  const sessionId = overrides.sessionId ?? '00000000-0000-4000-8000-000000000001';
  const key = `${exposure.exposureId}:${sessionId}`;
  const next = (sequences.get(key) ?? 0) + 1;
  sequences.set(key, next);
  return {
    schemaVersion: 'interaction.v1',
    eventId: overrides.eventId ?? randomUUID(),
    sessionId,
    deviceSequence: overrides.deviceSequence ?? next,
    exposureId: exposure.exposureId,
    assetId: exposure.assetId,
    assetRevision: exposure.assetRevision,
    occurredAt: overrides.occurredAt ?? new Date().toISOString(),
    ...body,
  } as InteractionEvent;
}

/** Coverage of `blocks`, each visible for `visibleMs` back to back from `fromMs`. */
export function coverage(
  blocks: readonly string[],
  visibleMs: number,
  fromMs = 0,
): Pick<InteractionEvent, 'kind' | 'payload'> {
  return {
    kind: 'scroll.block_coverage',
    payload: {
      blocks: blocks.map((blockId, index) => ({
        blockId,
        intervalsMs: [[fromMs + index * visibleMs, fromMs + (index + 1) * visibleMs]],
        peakFraction: 1,
      })),
    },
  };
}

export function dwell(...intervals: readonly [number, number][]): Pick<InteractionEvent, 'kind' | 'payload'> {
  return { kind: 'scroll.active_dwell', payload: { activeIntervalsMs: intervals.map(([from, to]) => [from, to]) } };
}
