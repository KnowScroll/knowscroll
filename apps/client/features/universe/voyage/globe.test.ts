import * as THREE from 'three';
import { paletteOf } from '../planet/planet-palette';
import { createGlobe, localPointOf, type Globe } from './globe';
import { BAND_WIDTH, worldLookOf } from './world-texture';

const pixels = { width: 4, height: 2, data: new Uint8Array(4 * 2 * 4) };

const uniformsOf = (globe: Globe) => (globe.mesh.material as THREE.ShaderMaterial).uniforms;
const textureOf = (globe: Globe) => uniformsOf(globe).map!.value as THREE.DataTexture | null;
const channelsOf = (globe: Globe, name: string) => (uniformsOf(globe)[name]!.value as THREE.Vector3).toArray();
const haloOf = (globe: Globe) => globe.mesh.children[0] as THREE.Mesh;
/** A `#rrggbb` as its channels over 255, as the palette means it. */
const numbers = (hex: string) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255);

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

describe('the globe shader, its lighting and its sea', () => {
  it('uses no word GLSL ES 3.00 reserves as a name: only a real draw would show it', () => {
    const globe = createGlobe();
    const shaders = [
      (globe.mesh.material as THREE.ShaderMaterial).fragmentShader,
      (globe.mesh.material as THREE.ShaderMaterial).vertexShader,
      (haloOf(globe).material as THREE.ShaderMaterial).fragmentShader,
      (haloOf(globe).material as THREE.ShaderMaterial).vertexShader,
    ];
    for (const shader of shaders)
      expect(shader.replace(/\/\/.*$/gm, '')).not.toMatch(/\b(flat|smooth|sample|half|fixed|input|output)\b/);
  });

  it('composes the sea in the shader under a premultiplied texture, and lights it with mixes that never go over one', () => {
    const shader = (createGlobe().mesh.material as THREE.ShaderMaterial).fragmentShader;
    expect(shader).toContain('vec3 colour = land.rgb + sea * (1.0 - land.a);');
    expect(shader).toContain('vec3 sea = mix(ball(ballAt), mix(groundTop, groundBottom, fromTop), near);');
    expect(shader).toContain('length(nv.xy - lv.xy * 0.34) / 1.5');
    expect(shader).toContain('0.24 *');
    expect(shader).toContain('(0.62 + 0.26 * back)');
    expect(shader).not.toContain('1.04');
  });

  it('gets the sea, cap and air colours as the palette writes them, not turned into linear light', () => {
    const globe = createGlobe();
    globe.setColours({ sea: '#808080', cap: '#f6fcff', air: '#83f2ea' });
    expect(channelsOf(globe, 'seaLit')).toEqual(numbers('#808080'));
    expect(channelsOf(globe, 'seaLit')[0]).toBeCloseTo(128 / 255, 12);
    expect(channelsOf(globe, 'cap')).toEqual(numbers('#f6fcff'));
    expect(channelsOf(globe, 'rim')).toEqual(numbers('#83f2ea'));
    expect(((haloOf(globe).material as THREE.ShaderMaterial).uniforms.halo!.value as THREE.Vector3).toArray()).toEqual(
      numbers('#83f2ea'),
    );
  });

  it('shows no caps before a texture is worn, and keeps them for a texture that carries no look', () => {
    const globe = createGlobe();
    expect(uniformsOf(globe).capOn!.value).toBe(0);
    globe.setTexture(pixels);
    expect(uniformsOf(globe).capOn!.value).toBe(1);
    globe.setTexture(null);
    expect(uniformsOf(globe).capOn!.value).toBe(0);
  });

  it('takes its sea, halo, rim and caps from the look of the texture it wears, caps only where the palette has them', () => {
    const globe = createGlobe();
    const lush = paletteOf('lush', 0);
    globe.setTexture({ ...pixels, look: worldLookOf(lush) });
    ['seaLit', 'seaMid', 'seaDeep', 'seaDark'].forEach((name, at) =>
      expect(channelsOf(globe, name)).toEqual(numbers(lush.sea[at]!)),
    );
    expect(channelsOf(globe, 'groundTop')).toEqual(numbers(lush.flatSea[0]));
    expect(channelsOf(globe, 'groundBottom')).toEqual(numbers(lush.flatSea[1]));
    expect(channelsOf(globe, 'rim')).toEqual(numbers(lush.rim));
    expect(uniformsOf(globe).capOn!.value).toBe(0);
    const frozen = paletteOf('frozen', 30);
    globe.setTexture({ ...pixels, look: worldLookOf(frozen) });
    expect(uniformsOf(globe).capOn!.value).toBe(1);
    expect(channelsOf(globe, 'cap')).toEqual(numbers(frozen.cloud[0]));
    expect(channelsOf(globe, 'groundTop')).toEqual(numbers(frozen.flatSea[0]));
    // Cleared, it falls back to the colours it was given.
    globe.setColours({ sea: '#102030', cap: '#ffffff', air: '#445566' });
    globe.setTexture(null);
    expect(channelsOf(globe, 'seaDark')).toEqual(numbers('#102030'));
    expect(channelsOf(globe, 'groundTop')).toEqual(numbers('#102030'));
  });

  it('shows the real sea before the texture is ready when it is given the look with the colours', () => {
    const globe = createGlobe();
    const ocean = paletteOf('ocean', 0);
    globe.setColours({ sea: ocean.sea[0], cap: ocean.cloud[0], air: ocean.atmosphere, look: worldLookOf(ocean) });
    expect(channelsOf(globe, 'seaDeep')).toEqual(numbers(ocean.sea[2]));
    expect(channelsOf(globe, 'groundBottom')).toEqual(numbers(ocean.flatSea[1]));
  });

  it('measures the screen the flat sea is laid over from the renderer as it draws, or from setScreen', () => {
    const globe = createGlobe();
    const renderer = { getDrawingBufferSize: (target: THREE.Vector2) => target.set(1170, 2532) };
    globe.mesh.onBeforeRender(
      renderer as unknown as THREE.WebGLRenderer,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
    );
    expect((uniformsOf(globe).resolution!.value as THREE.Vector2).toArray()).toEqual([1170, 2532]);
    globe.setScreen(390, 844);
    expect((uniformsOf(globe).resolution!.value as THREE.Vector2).toArray()).toEqual([390, 844]);
  });
});

describe('the halo of air', () => {
  it('is one child of the globe, facing the camera, that does not write depth', () => {
    const globe = createGlobe();
    expect(globe.mesh.children).toHaveLength(1);
    const halo = haloOf(globe);
    expect((halo.material as THREE.ShaderMaterial).transparent).toBe(true);
    expect((halo.material as THREE.ShaderMaterial).depthWrite).toBe(false);
    const shader = (halo.material as THREE.ShaderMaterial).fragmentShader;
    expect(shader).toContain('0.36');
    expect(shader).toContain('0.9648');
    expect(shader).toContain('0.3752');
    expect((halo.material as THREE.ShaderMaterial).vertexShader).toContain('1.34');
  });

  it('takes the globe opacity and fades away as the ground comes near', () => {
    const globe = createGlobe();
    const halo = haloOf(globe).material as THREE.ShaderMaterial;
    globe.setLight(new THREE.Vector3(1, 0, 0), 0.25, 0.6);
    expect(halo.uniforms.opacity!.value).toBe(0.6);
    expect(halo.uniforms.near!.value).toBe(0.25);
    expect(haloOf(globe).visible).toBe(true);
    globe.setLight(new THREE.Vector3(1, 0, 0), 1, 1);
    expect(haloOf(globe).visible).toBe(false);
    globe.setLight(new THREE.Vector3(1, 0, 0), 0, 0);
    expect(haloOf(globe).visible).toBe(false);
    globe.setLight(new THREE.Vector3(1, 0, 0), 0, 1);
    expect(haloOf(globe).visible).toBe(true);
  });

  it('is freed with the globe', () => {
    const globe = createGlobe();
    const geometry = jest.spyOn(haloOf(globe).geometry, 'dispose');
    const material = jest.spyOn(haloOf(globe).material as THREE.Material, 'dispose');
    globe.dispose();
    expect(geometry).toHaveBeenCalledTimes(1);
    expect(material).toHaveBeenCalledTimes(1);
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
