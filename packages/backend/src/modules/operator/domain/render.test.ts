import { describe, expect, it } from 'vitest';
import { renderJourney } from './render.js';
import type { Journey } from './journey.js';

const journey: Journey = {
  subject: 'request',
  subjectId: '11111111-1111-4111-8111-111111111111',
  steps: [
    {
      at: new Date('2026-10-24T10:00:00.120Z'),
      endedAt: new Date('2026-10-24T10:00:02.620Z'),
      stage: 'supply.request',
      title: 'Request',
      state: 'ready',
      code: 'create',
      label: null,
      count: null,
      ref: '11111111-1111-4111-8111-111111111111',
      scope: 'personal',
    },
    {
      at: new Date('2026-10-24T10:00:03.000Z'),
      endedAt: null,
      stage: 'reasoning.production_attempt',
      title: 'Model attempt (production)',
      state: 'unknown',
      code: null,
      label: 'write',
      count: 3,
      ref: null,
      scope: 'shared',
    },
  ],
  gaps: [{ stage: 'reasoning.production_attempt', ref: null, note: 'Outcome unknown.' }],
  truncated: true,
};

describe('renderJourney', () => {
  it('prints a header, a line per step, the gaps and the cut-off note', () => {
    expect(renderJourney(journey).split('\n')).toEqual([
      'journey request 11111111-1111-4111-8111-111111111111 (2 steps, from 2026-10-24)',
      '10:00:00.120  personal  supply.request                  ready create  +2.5s  11111111-1111-4111-8111-111111111111',
      '10:00:03.000  shared    reasoning.production_attempt    unknown write n=3',
      'gap  reasoning.production_attempt: Outcome unknown.',
      'Only the newest steps are shown.',
    ]);
  });
});
