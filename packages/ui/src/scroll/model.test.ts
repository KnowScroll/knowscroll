import { z } from 'zod';

describe('the renderers’ door to the scroll model', () => {
  it('configures Zod not to compile parsers (no eval under the Content-Security-Policy) before the model builds its schemas', () => {
    jest.isolateModules(() => {
      // The first value import of the model in a fresh module registry goes through the door.
      expect(z.config().jitless).not.toBe(true);
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- a fresh module registry needs a synchronous load
      require('./model');
      expect(z.config().jitless).toBe(true);
    });
  });
});
