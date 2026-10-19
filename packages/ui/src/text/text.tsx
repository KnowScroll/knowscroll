import type { ReactNode } from 'react';
import { Text as NativeText, type StyleProp, type TextProps as NativeTextProps, type TextStyle } from 'react-native';
import { content, resolveType, type ResolvedTypeStyle, type TypeRole } from '@knowscroll/design-tokens';
import { useDisplay } from '../display/display';
import { headingSemantics } from '../display/semantics';

/** The resolved type style for a role at the current breakpoint and system text size. */
export function useTypeStyle(role: TypeRole): ResolvedTypeStyle {
  const { breakpoint, textScale } = useDisplay();
  return resolveType(role, { desktop: breakpoint === 'desktop', textScale });
}

export interface TextProps extends Pick<
  NativeTextProps,
  'accessibilityLabel' | 'nativeID' | 'numberOfLines' | 'testID' | 'selectable'
> {
  /** Marks the text as a heading of this outline level (screen title 1, sections 2). */
  readonly heading?: 1 | 2 | 3;
  /** Type role from the token scale. */
  readonly variant: TypeRole;
  readonly color?: string;
  readonly align?: 'auto' | 'left' | 'center' | 'right';
  readonly children: ReactNode;
  /** Layout only (margins, flex); typography comes from `variant`. */
  readonly style?: StyleProp<TextStyle>;
}

/**
 * Text in a token role. The role, not the platform, scales the text: `allowFontScaling` is off
 * because `resolveType` already applies the system text size with the export's 200 % rules, and
 * caps labels switch to sentence case above 150 %.
 */
export function Text({ variant, color = content.ink, align, heading, children, style, ...rest }: TextProps) {
  const type = useTypeStyle(variant);
  return (
    <NativeText
      {...rest}
      {...(heading === undefined ? {} : headingSemantics(heading))}
      allowFontScaling={false}
      style={[type, { color }, align === undefined ? null : { textAlign: align }, style]}
    >
      {children}
    </NativeText>
  );
}
