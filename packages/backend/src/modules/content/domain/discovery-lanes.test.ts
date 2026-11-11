import { describe, expect, it } from 'vitest';
import {
  DISCOVERY_LANE_LIMITS,
  DISCOVERY_LANE_QUOTAS,
  DISCOVERY_LANES,
  validateDiscoveryLanes,
} from './discovery-lanes.js';

describe('the lanes of a retrieval (D-420)', () => {
  it('names the six lanes in priority order', () => {
    expect(DISCOVERY_LANES).toEqual(['source', 'planned', 'text', 'continue', 'adjacent', 'explore']);
  });

  it('caps the lanes before explore at 66, so explore keeps at least 34 of the 100 and takes the rest, without the text lane a subject move never asks for', () => {
    const { source, planned, continue: continued, adjacent, explore } = DISCOVERY_LANE_QUOTAS;
    expect(source + planned + continued + adjacent).toBe(66);
    expect(100 - (source + planned + continued + adjacent)).toBeGreaterThanOrEqual(34);
    expect(explore).toBe(100);
  });

  it('keeps ids as data: bounded, non-empty and de-duplicated', () => {
    const checked = validateDiscoveryLanes({ continueTopicIds: ['a', 'b', 'a'], plannedUnitIds: ['u'] });
    expect(checked).toEqual({ continueTopicIds: ['a', 'b'], plannedUnitIds: ['u'] });
  });

  it('refuses what is not a bounded list of ids', () => {
    const tooMany = Array.from({ length: DISCOVERY_LANE_LIMITS.continueTopics + 1 }, (_, n) => `t${String(n)}`);
    expect(() => validateDiscoveryLanes({ continueTopicIds: tooMany, plannedUnitIds: [] })).toThrow(
      'DISCOVERY_LANES_INVALID',
    );
    expect(() => validateDiscoveryLanes({ continueTopicIds: [''], plannedUnitIds: [] })).toThrow(
      'DISCOVERY_LANES_INVALID',
    );
    expect(() => validateDiscoveryLanes({ continueTopicIds: ['x'.repeat(161)], plannedUnitIds: [] })).toThrow(
      'DISCOVERY_LANES_INVALID',
    );
    expect(() =>
      validateDiscoveryLanes({
        continueTopicIds: [],
        plannedUnitIds: Array.from({ length: 13 }, (_, n) => `u${String(n)}`),
      }),
    ).toThrow('DISCOVERY_LANES_INVALID');
    expect(() => validateDiscoveryLanes({ continueTopicIds: 'a' as unknown as string[], plannedUnitIds: [] })).toThrow(
      'DISCOVERY_LANES_INVALID',
    );
    expect(() => validateDiscoveryLanes(null as unknown as never)).toThrow('DISCOVERY_LANES_INVALID');
  });
});
