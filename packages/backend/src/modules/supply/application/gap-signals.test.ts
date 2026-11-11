import { describe, expect, it } from 'vitest';
import type { PersonalScopeTx } from '../../identity/public.js';
import type { CatalogueTopic } from '../domain/gaps.js';
import { MAX_SIGNALS_PER_CALL, makeRecordGapSignals, recordableSignals, utcDay } from './gap-signals.js';
import type { GapMarkStore, GapSignalInput } from './gap-ports.js';

/** Labelled CI fixtures: an invented catalogue, never product data. */
const CATALOGUE: readonly CatalogueTopic[] = [
  { id: 'fixture.tides', facets: ['fixture.tides.pull', 'fixture.tides.range'] },
  { id: 'fixture.stars', facets: ['fixture.stars.light'] },
  { id: 'fixture.rocks', facets: [] },
  { id: 'fixture.moons', facets: [] },
];
const scope = {} as PersonalScopeTx;

function recorder(enabled: boolean) {
  const written: { day: string; signals: readonly GapSignalInput[] }[] = [];
  const marks: GapMarkStore = {
    mark: (_scope, day, signals) => {
      written.push({ day, signals });
      return Promise.resolve();
    },
  };
  const record = makeRecordGapSignals({
    enabled,
    marks,
    now: () => new Date('2026-11-11T23:59:59Z'),
    catalogue: CATALOGUE,
  });
  return { record, written };
}

describe('which signals are recorded', () => {
  it('keeps one for each planet and facet, in the order given, and the first source of a repeat', () => {
    expect(
      recordableSignals(CATALOGUE, [
        { source: 'last_resort', planet: 'fixture.tides' },
        { source: 'low_headroom', planet: 'fixture.tides' },
        { source: 'ask', planet: 'fixture.tides', facet: 'fixture.tides.pull' },
      ]),
    ).toEqual([
      { source: 'last_resort', planet: 'fixture.tides' },
      { source: 'ask', planet: 'fixture.tides', facet: 'fixture.tides.pull' },
    ]);
  });

  it('drops a name the catalogue does not hold, so no label, title or model string becomes a gap', () => {
    expect(
      recordableSignals(CATALOGUE, [
        { source: 'ask', planet: 'what is a tide' },
        { source: 'ask', planet: 'fixture.tides', facet: 'fixture.stars.light' },
        { source: 'ask', planet: 'fixture' },
      ]),
    ).toEqual([]);
  });

  it('keeps at most three a call', () => {
    const many = ['tides', 'stars', 'rocks', 'moons'].map((name): GapSignalInput => ({
      source: 'low_headroom',
      planet: `fixture.${name}`,
    }));
    expect(recordableSignals(CATALOGUE, many)).toHaveLength(MAX_SIGNALS_PER_CALL);
  });
});

describe('recording a signal in the person’s own transaction', () => {
  it('writes the person’s marks for the UTC day, nothing else', async () => {
    const { record, written } = recorder(true);
    await record(scope, [{ source: 'planned_demand', planet: 'fixture.tides' }]);
    expect(written).toEqual([{ day: '2026-11-11', signals: [{ source: 'planned_demand', planet: 'fixture.tides' }] }]);
    expect(utcDay(new Date('2026-12-31T23:59:59.999Z'))).toBe('2026-12-31');
  });

  it('does nothing where the loop is off, and nothing for an empty or unusable call', async () => {
    const off = recorder(false);
    await off.record(scope, [{ source: 'ask', planet: 'fixture.tides' }]);
    expect(off.written).toEqual([]);
    const on = recorder(true);
    await on.record(scope, []);
    await on.record(scope, [{ source: 'ask', planet: 'unknown' }]);
    expect(on.written).toEqual([]);
  });
});
