import { BUBBLE_SIZE, bubbleDots } from './crossing-bubble';

describe('a universe bubble', () => {
  it('makes the same web for the same seed and a different one for another', () => {
    expect(bubbleDots('friend:Ravi')).toEqual(bubbleDots('friend:Ravi'));
    expect(bubbleDots('friend:Ravi')).not.toEqual(bubbleDots('friend:Mei'));
  });

  it('has hundreds of dots of all three colours, inside the square', () => {
    const dots = bubbleDots('you');
    expect(dots.length).toBeGreaterThan(500);
    expect(new Set(dots.map((dot) => dot.colour))).toEqual(new Set([0, 1, 2]));
    for (const dot of dots) {
      expect(dot.x).toBeGreaterThan(0);
      expect(dot.x).toBeLessThan(BUBBLE_SIZE);
      expect(dot.y).toBeGreaterThan(0);
      expect(dot.y).toBeLessThan(BUBBLE_SIZE);
    }
  });
});
