import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stopWords, WORDS_PER_MINUTE_V2, parseDocumentV2 } from '@knowscroll/scroll-model';
import { readingFactsOfV2 } from '../../../packages/backend/src/modules/content/adapters/reading-facts-v2.js';
import { SCROLL_QUALIFICATION_POLICY_V0 as policy } from '../../../packages/backend/src/modules/evidence/domain/policy.js';
import { qualifyScrollReading } from '../../../packages/backend/src/modules/evidence/domain/qualification.js';
import {
  summariseReading,
  type ObservationBody,
  type ObservationRecord,
} from '../../../packages/backend/src/modules/evidence/domain/reading-summary.js';

/**
 * What the Stage + Spine reader reports, judged by the server's own rules. The reader tells the
 * recorder that the stop on screen is wholly visible, then not visible when it leaves, and that a
 * call's answer was shown. The recorder turns that into one visible interval per stop visit and one
 * `revealed` interaction per call (client-core's `ReadingTracker`; the browser test in
 * `stage-reader-smoke.spec.ts` checks the real recorder's events on the page). Here those events are
 * read as the intake stores them, summarised with the document's reading facts and qualified. The
 * document is the labelled CI fixture `seasons-stage-ci`, not product content.
 */
const seasons: unknown = JSON.parse(
  readFileSync(
    new URL('../../../packages/scroll-model/fixtures/documents/seasons-stage-ci.json', import.meta.url),
    'utf8',
  ),
);
const parsed = parseDocumentV2(seasons);
if (parsed.kind !== 'valid') throw new Error('the CI fixture must parse');
const document = parsed.document;
const facts = readingFactsOfV2(document);

/** A reader: the stops they were on and for how long, and the calls whose answer they saw, in time order. */
interface Session {
  readonly visits: readonly { readonly stopId: string; readonly forMs: number }[];
  readonly revealed: readonly string[];
}

/** The observations the recorder would send for a session: a visit is one interval, a reveal one interaction. */
function recorded(session: Session): ObservationRecord[] {
  let now = 0;
  const intervals = session.visits.map((visit) => {
    const interval = { blockId: visit.stopId, from: now, to: now + visit.forMs };
    now += visit.forMs;
    return interval;
  });
  const bodies: ObservationBody[] = [
    {
      kind: 'scroll.block_coverage',
      blocks: intervals.map((interval) => ({
        blockId: interval.blockId,
        intervalsMs: [[interval.from, interval.to]],
        peakFraction: 1,
      })),
    },
    { kind: 'scroll.active_dwell', activeIntervalsMs: intervals.map((interval) => [interval.from, interval.to]) },
    ...session.revealed.map((blockId): ObservationBody => ({
      kind: 'scroll.block_interaction',
      blockId,
      interaction: 'revealed',
      atMs: now,
    })),
  ];
  return bodies.map((body, index) => ({
    seq: index + 1,
    sessionId: 's1',
    deviceSequence: index + 1,
    instrumentationVersion: 1,
    body,
  }));
}

const qualify = (session: Session) => qualifyScrollReading(summariseReading(recorded(session), facts, policy), policy);
const nominalMs = (stopId: string): number => {
  const stop = document.stops.find((entry) => entry.id === stopId);
  return stop === undefined ? 0 : (stopWords(stop) * 60_000) / WORDS_PER_MINUTE_V2;
};
const calls = document.stops.filter((stop) => stop.kind !== 'read').map((stop) => stop.id);

describe('what the stage reader reports, qualified by the server', () => {
  it('qualifies a reader who stays on each read stop for half its words’ time plus 0.3 s and sees every answer', () => {
    const result = qualify({
      visits: document.stops.map((stop) => ({
        stopId: stop.id,
        forMs: stop.kind === 'read' ? Math.round(nominalMs(stop.id) * 0.5) + 300 : 10_000,
      })),
      revealed: calls,
    });
    expect(result).toMatchObject({ qualification: 'qualified', coverage: 1 });
    expect(result.q).toBeGreaterThanOrEqual(0.6);
  });

  it('does not qualify tapping through every dot, a quarter of a second on each, even with every answer revealed', () => {
    const result = qualify({
      visits: document.stops.map((stop) => ({ stopId: stop.id, forMs: 250 })),
      revealed: calls,
    });
    expect(result.qualification).toBe('not_qualified');
    expect(result.q).toBeLessThan(0.6);
  });

  it('does not qualify a reader who gives every read stop just under its 40 % share', () => {
    const result = qualify({
      visits: document.stops.map((stop) => ({
        stopId: stop.id,
        forMs: stop.kind === 'read' ? Math.floor(nominalMs(stop.id) * 0.39) : 10_000,
      })),
      revealed: calls,
    });
    expect(result.qualification).toBe('not_qualified');
  });
});
