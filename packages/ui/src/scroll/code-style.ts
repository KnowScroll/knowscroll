import { fontFamily, typeScaling } from '@knowscroll/design-tokens';

/**
 * The type of displayed code: DM Mono 13 on 21 (E03 draws 13 on 1.6). The token set has no code
 * role yet (D-006 p: name drawn sizes), so the size lives here until it does; it follows the
 * system text size like every other role.
 */
export function codeType(textScale: number): {
  readonly fontFamily: string;
  readonly fontWeight: '500';
  readonly fontSize: number;
  readonly lineHeight: number;
} {
  const scale = Math.min(Math.max(textScale, 1), typeScaling.maxTextScale);
  return {
    fontFamily: fontFamily.mono,
    fontWeight: '500',
    fontSize: Math.round(13 * scale * 2) / 2,
    lineHeight: Math.round(21 * scale),
  };
}
