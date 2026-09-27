import { describe, expect, it } from 'vitest';
import { feedPath } from '../../src/api/client';

// #133: the feed is told what this discovery trip already opened, so it never refills a slate
// with Scrolls the reader would skip (a false "end of library").
describe('feedPath', () => {
  it('sends nothing for a fresh trip', () => {
    expect(feedPath([])).toBe('/feed');
  });
  it('sends only UUIDs, once each, the most recent 256', () => {
    const ids = Array.from({ length: 300 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const sent = feedPath([...ids, 'not-a-uuid', ids[0]!]).split('exclude=')[1]!.split(',');
    expect(sent).toHaveLength(256);
    expect(sent).toEqual(ids.slice(-256));
  });
});
