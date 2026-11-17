import { passageOf } from './passage';

describe('the words a selection puts into a question draft', () => {
  it('is the selected words as one trimmed line', () => {
    expect(passageOf('  Earth is\n tilted  ')).toBe('Earth is tilted');
  });

  it('is empty for words that are only space', () => {
    expect(passageOf('   \n ')).toBe('');
  });

  it('is at most ninety letters, ending in an ellipsis when cut', () => {
    const line = passageOf(`${'word '.repeat(60)}\n end`);
    expect([...line].length).toBeLessThanOrEqual(90);
    expect(line).not.toContain('\n');
    expect(line.endsWith('…')).toBe(true);
  });
});
