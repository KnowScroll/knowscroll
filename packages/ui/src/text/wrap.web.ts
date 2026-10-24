import type { TextStyle } from 'react-native';

/**
 * A heading's word wider than its line (a long title at double text size on a 320 px phone) breaks
 * instead of running past the edge (WCAG 1.4.4, 1.4.10). Only headings take it: `anywhere` also
 * lets a flex item shrink to one letter, which would squeeze labels in a row. React Native Web
 * passes `overflowWrap` to CSS.
 */
export const longWordWrap = { overflowWrap: 'anywhere' } as TextStyle;
