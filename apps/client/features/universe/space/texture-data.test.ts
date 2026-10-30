import { planetGenome } from './planet-genome';
import { cloudPuff, paintPlanet, radialGlow } from './texture-data';

describe('painted textures', () => {
  it('paint the same pixels for the same planet', () => {
    const genome = planetGenome('same-planet', 'lush', 'teal');
    const first = paintPlanet(genome);
    const second = paintPlanet(genome);
    expect(Buffer.from(second.surface.data).equals(Buffer.from(first.surface.data))).toBe(true);
    expect(second.atmosphere).toEqual(first.atmosphere);
  });

  it('paint different worlds for different ids', () => {
    const one = paintPlanet(planetGenome('planet-a', 'lush', 'teal'));
    const other = paintPlanet(planetGenome('planet-b', 'lush', 'teal'));
    expect(Buffer.from(other.surface.data).equals(Buffer.from(one.surface.data))).toBe(false);
  });

  it('give rings only to worlds that have them, and clouds only to worlds with an atmosphere layer', () => {
    expect(paintPlanet(planetGenome('ringed', 'gas', 'teal')).ring).not.toBeNull();
    expect(paintPlanet(planetGenome('plain', 'scorched', 'teal')).ring).toBeNull();
    expect(paintPlanet(planetGenome('wet', 'ocean', 'teal')).clouds).not.toBeNull();
    expect(paintPlanet(planetGenome('dry', 'barren', 'teal')).clouds).toBeNull();
  });

  it('size every planet from its seed alone', () => {
    const sizes = ['a', 'b', 'c', 'd'].map((id) => planetGenome(id, 'lush', 'teal').size);
    for (const size of sizes) {
      expect(size).toBeGreaterThanOrEqual(0.8);
      expect(size).toBeLessThanOrEqual(1.3);
    }
    expect(planetGenome('a', 'lush', 'teal').size).toBe(sizes[0]);
  });

  it('fade a glow from opaque white at the centre to nothing at the edge', () => {
    const glow = radialGlow(
      [
        [0, 1],
        [1, 0],
      ],
      32,
    );
    const alphaAt = (column: number, row: number): number => glow.data[(row * 32 + column) * 4 + 3]!;
    expect(alphaAt(15, 15)).toBeGreaterThan(230);
    expect(alphaAt(0, 0)).toBe(0);
  });

  it('draws a cloud puff that is soft, not a flat disc', () => {
    const puff = cloudPuff(64);
    const alphas = new Set<number>();
    for (let at = 3; at < puff.data.length; at += 4) alphas.add(puff.data[at]!);
    expect(alphas.size).toBeGreaterThan(10);
  });
});
