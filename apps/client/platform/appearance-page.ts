import type { Appearance } from '@knowscroll/design-tokens';

/**
 * Native: there is no page to name. Native styles hold the Light values of the content register
 * (design-tokens `adaptive.ts`), and Talk follows Appearance through its theme provider.
 */
export function paintAppearance(_appearance: Appearance): void {}
