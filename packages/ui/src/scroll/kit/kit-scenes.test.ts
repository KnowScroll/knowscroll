import { blendScenes, lerpAngle } from './blend';

describe('moving a picture between two scenes', () => {
  it('blends numbers, switches words at the middle and takes the shortest way round an angle', () => {
    const from = { angle: 350, size: 10, word: 'a', list: [0, 10] };
    const to = { angle: 10, size: 20, word: 'b', list: [10, 30] };
    expect(blendScenes(from, to, 0)).toBe(from);
    expect(blendScenes(from, to, 1)).toBe(to);
    const middle = blendScenes(from, to, 0.5, ['angle']);
    expect(middle).toEqual({ angle: 360, size: 15, word: 'b', list: [5, 20] });
    expect(blendScenes(from, to, 0.25, ['angle']).word).toBe('a');
    expect(lerpAngle(350, 10, 0.5)).toBe(360);
    expect(lerpAngle(10, 350, 0.5)).toBe(0);
  });
});
