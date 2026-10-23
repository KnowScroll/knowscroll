import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeCommissionMedia } from './commission-media.js';
import type { PublicationSnapshot, CommissionMediaProof } from '../../production/commission-publication-ports.js';
describe('closed current-media verification capability', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('cannot consume a forged copied proof or start disabled media I/O', async () => {
    const network = vi.fn(() => {
      throw new Error('fixture network forbidden');
    });
    vi.stubGlobal('fetch', network);
    const media = makeCommissionMedia({
      enabled: false,
      origin: 'http://127.0.0.1:9876',
      artifactRoot: '/fixture/missing',
      mediaRoot: '/fixture/missing',
    });
    expect(await media.prepare({} as PublicationSnapshot)).toBeUndefined();
    expect(media.consume({} as CommissionMediaProof, {} as PublicationSnapshot)).toBeUndefined();
    expect(network).not.toHaveBeenCalled();
  });
});
