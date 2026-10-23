import { fontFamily } from '@knowscroll/design-tokens';
import { fontFamilies } from './fonts';

describe('bundled fonts', () => {
  it('registers a bundled face for every family the type scale names', () => {
    const registered = new Map(fontFamilies.map((family) => [family.fontFamily, family.fontDefinitions]));
    for (const name of Object.values(fontFamily)) {
      const faces = registered.get(name);
      expect(faces).toHaveLength(1);
      expect(faces?.[0]?.path).toBeDefined();
    }
  });

  it('declares the variable weight ranges so the web selects instances instead of faking bold', () => {
    const weights = Object.fromEntries(
      fontFamilies.map((family) => [family.fontFamily, family.fontDefinitions[0]?.weight]),
    );
    expect(weights).toEqual({ BricolageGrotesque: '200 800', InstrumentSans: '400 700', DMMono: '500' });
  });
});
