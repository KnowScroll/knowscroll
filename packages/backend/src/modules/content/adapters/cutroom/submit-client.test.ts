import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeCutroomSubmitClient } from './submit-client.js';
import type { CutroomDispatchPermit } from '../../../../reasoning/public.js';
describe('default-deny fixed Cutroom transport', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('cannot turn disabled/foreign origins or fabricated serialized permits into network authority', async () => {
    const network = vi.fn(() => {
      throw new Error('fixture must never reach network');
    });
    vi.stubGlobal('fetch', network);
    const forged = Object.freeze({
      dispatchId: 'forged',
      requestUtf8: 'private-canary',
    }) as unknown as CutroomDispatchPermit;
    expect(await makeCutroomSubmitClient().submit(forged)).toEqual({ kind: 'held', code: 'disabled' });
    for (const origin of [
      'https://127.0.0.1',
      'http://example.com',
      'http://127.0.0.1/?key=private',
      'http://user:secret@127.0.0.1',
      'http://127.0.0.1/other',
    ])
      expect(await makeCutroomSubmitClient({ enabled: true, origin }).submit(forged)).toEqual({
        kind: 'held',
        code: 'disabled',
      });
    expect(await makeCutroomSubmitClient({ enabled: true, origin: 'http://127.0.0.1:9876' }).submit(forged)).toEqual({
      kind: 'held',
      code: 'permit',
    });
    expect(network).not.toHaveBeenCalled();
  });
});
