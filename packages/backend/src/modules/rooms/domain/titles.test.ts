import { describe, expect, it } from 'vitest';
import { TITLE_MAX_CHARS, titleFrom } from './titles.js';

describe('titleFrom', () => {
  it('collapses whitespace and drops control characters', () => {
    expect(titleFrom('  What   one\tanswer\ncosts \u0007 to serve ', 'Shared')).toBe('What one answer costs to serve');
  });

  it('cuts a long title on a character boundary with an ellipsis', () => {
    const title = titleFrom('😀'.repeat(TITLE_MAX_CHARS + 20), 'Shared');
    expect([...title]).toHaveLength(TITLE_MAX_CHARS);
    expect(title.endsWith('…')).toBe(true);
  });

  it('keeps a title that fits as it is, and falls back when nothing is left', () => {
    expect(titleFrom('x'.repeat(TITLE_MAX_CHARS), 'Shared')).toBe('x'.repeat(TITLE_MAX_CHARS));
    expect(titleFrom(' \u0001 ', 'Shared')).toBe('Shared');
  });
});
