import * as THREE from 'three';
import { createGlobe, localPointOf, type Globe } from './globe';
import { BAND_WIDTH } from './world-texture';

const pixels = { width: 4, height: 2, data: new Uint8Array(4 * 2 * 4) };

const uniformsOf = (globe: Globe) => (globe.mesh.material as THREE.ShaderMaterial).uniforms;
const textureOf = (globe: Globe) => uniformsOf(globe).map!.value as THREE.DataTexture | null;

describe('where a band point is on the sphere', () => {
  it('follows the shader: longitude is atan(x, z) with band x 0 at -PI, latitude is asin(y)', () => {
    for (const [bandX, latitude] of [
      [0, 0],
      [120, 0.4],
      [240, -0.7],
      [359, 1.2],
      [479, -1.2],
    ] as const) {
      const point = localPointOf(bandX, latitude);
      const u = (Math.atan2(point.x, point.z) / (2 * Math.PI) + 0.5 + 1) % 1;
      expect(u).toBeCloseTo(bandX / BAND_WIDTH, 9);
      expect(Math.asin(point.y)).toBeCloseTo(latitude, 9);
      expect(point.length()).toBeCloseTo(1, 12);
    }
  });

  it('puts the middle of the band, on the equator, facing +z', () => {
    const point = localPointOf(BAND_WIDTH / 2, 0);
    expect([point.x, point.y, point.z].map((value) => Math.round(value))).toEqual([0, 0, 1]);
  });
});

describe('the globe shader', () => {
  it('turns latitude into a row of the 480 by 360 band with the band-size constants', () => {
    const shader = (createGlobe().mesh.material as THREE.ShaderMaterial).fragmentShader;
    expect(shader).toContain('const float K = 76.394373;');
    expect(shader).toContain('float bandY = 180.0 - K * log(tan(PI * 0.25 + lat * 0.5));');
    expect(shader).toContain('float v = bandY / 360.0;');
  });
});

describe('the globe texture', () => {
  it('wears a painted world as a repeating, linear, mipmap-free RGBA texture, not flipped', () => {
    const globe = createGlobe();
    globe.setTexture(pixels);
    const texture = textureOf(globe)!;
    expect(texture.image).toMatchObject({ width: 4, height: 2, data: pixels.data });
    expect(texture.format).toBe(THREE.RGBAFormat);
    expect(texture.type).toBe(THREE.UnsignedByteType);
    expect(texture.wrapS).toBe(THREE.RepeatWrapping);
    expect(texture.wrapT).toBe(THREE.ClampToEdgeWrapping);
    expect(texture.minFilter).toBe(THREE.LinearFilter);
    expect(texture.magFilter).toBe(THREE.LinearFilter);
    expect(texture.generateMipmaps).toBe(false);
    expect(texture.flipY).toBe(false);
    expect(texture.colorSpace).toBe(THREE.NoColorSpace);
    expect(texture.version).toBeGreaterThan(0);
    expect(uniformsOf(globe).painted!.value).toBe(1);
    globe.dispose();
  });

  it('frees the texture it wore when the next arrives, when it is cleared and when the globe goes', () => {
    const globe = createGlobe();
    globe.setTexture(pixels);
    const first = textureOf(globe)!;
    const freeFirst = jest.spyOn(first, 'dispose');
    globe.setTexture(pixels);
    expect(freeFirst).toHaveBeenCalledTimes(1);
    const second = textureOf(globe)!;
    expect(second).not.toBe(first);
    const freeSecond = jest.spyOn(second, 'dispose');
    globe.setTexture(null);
    expect(freeSecond).toHaveBeenCalledTimes(1);
    expect(textureOf(globe)).toBeNull();
    expect(uniformsOf(globe).painted!.value).toBe(0);
    globe.setTexture(pixels);
    const last = textureOf(globe)!;
    const freeLast = jest.spyOn(last, 'dispose');
    globe.dispose();
    expect(freeLast).toHaveBeenCalledTimes(1);
  });
});
