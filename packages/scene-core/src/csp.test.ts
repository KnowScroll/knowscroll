import { expect, it, vi } from 'vitest';
import { descriptorFixture } from './test-support/fixtures.js';

it('cold imports, parses and generates without probing dynamic code generation', async () => {
  vi.resetModules();
  let attempts = 0;
  const refused = () => {
    attempts++;
    throw new EvalError('strict CSP');
  };
  vi.stubGlobal('Function', new Proxy(Function, { apply: refused, construct: refused }));
  vi.stubGlobal('eval', refused);
  try {
    const scene = await import('./index.js');
    const parsed = scene.SceneDescriptorSchema.parseJson(JSON.stringify(descriptorFixture()));
    expect(scene.buildSceneGeometry(parsed, { detail: 'low', reducedMotion: true }).objectId).toBe(parsed.objectId);
    expect(attempts).toBe(0);
  } finally {
    vi.unstubAllGlobals();
  }
});
