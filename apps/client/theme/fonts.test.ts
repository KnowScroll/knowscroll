import { fontAssets, fontFamilies } from './fonts';

describe('bundled fonts', () => {
  it('provides an asset for every font family the UI names', () => {
    for (const family of Object.values(fontFamilies)) {
      expect(fontAssets[family]).toBeDefined();
    }
  });
});
