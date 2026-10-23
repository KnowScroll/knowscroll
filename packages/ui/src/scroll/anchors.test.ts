import { bridgesPoster } from './fixtures/documents';
import { formatBlockAnchor, parseBlockAnchor, resolveAnchor } from './anchors';

describe('block anchors', () => {
  it('round-trips a block id through the address fragment', () => {
    expect(formatBlockAnchor('why-squared')).toBe('#why-squared');
    expect(parseBlockAnchor('#why-squared')).toBe('why-squared');
    expect(parseBlockAnchor('why-squared')).toBe('why-squared');
  });

  it('refuses a fragment that is not a block id (never a pixel offset)', () => {
    expect(parseBlockAnchor('#240')).toBeNull();
    expect(parseBlockAnchor('#')).toBeNull();
    expect(parseBlockAnchor('#Why Squared')).toBeNull();
    expect(parseBlockAnchor('#a')).toBeNull();
  });

  it('leads to a top-level block itself', () => {
    expect(resolveAnchor(bridgesPoster(), 'code-load')).toEqual({
      scrollToBlockId: 'code-load',
      openDisclosureId: null,
    });
  });

  it('leads a block inside a disclosure to the disclosure, to be opened', () => {
    expect(resolveAnchor(bridgesPoster(), 'safety-why')).toEqual({
      scrollToBlockId: 'd-safety',
      openDisclosureId: 'd-safety',
    });
  });

  it('has no target for a block the revision does not have', () => {
    expect(resolveAnchor(bridgesPoster(), 'no-such-block')).toBeNull();
  });
});
