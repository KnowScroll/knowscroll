import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { content, highlightRing, space, target } from '@knowscroll/design-tokens';
import { Text, useFocusRing } from '@knowscroll/ui';
import type { SceneDescriptor, SceneGeometry } from '@knowscroll/scene-core';
import type { UniverseIndex, Size, PlacedLabel } from './universe-layout';
import type { UniverseMapSession, UniverseViewState } from './universe-session';

/** What every scene (overview, system, planet) is drawn from. */
export interface SceneProps {
  readonly session: UniverseMapSession;
  readonly state: UniverseViewState;
  readonly index: UniverseIndex;
  readonly size: Size;
  /** A tap on a dust cue: the screen explains it; it is not a place and goes nowhere. */
  readonly onDust?: () => void;
}

/**
 * A place's silhouette, or `undefined` when it cannot be built. A descriptor that fails the drawing
 * rules must not take the screen down: its target and its row in the list stay, only the drawing goes.
 */
export function safeGeometry(
  session: UniverseMapSession,
  descriptor: SceneDescriptor,
  low = false,
): SceneGeometry | undefined {
  try {
    return session.geometry(descriptor, low);
  } catch {
    return undefined;
  }
}

/** Width of a map label in 13 px semibold, estimated because text cannot be measured before it is drawn. */
export const labelWidth = (text: string, padding = 8) => Math.ceil(text.length * 7.3) + padding;
export const LABEL_HEIGHT = 20;
export const PILL_HEIGHT = 26;

/** The kind word a screen reader hears after a place's name: "Machine learning, a system". */
export const KIND_PHRASE = { system: 'a system', star: 'a star', planet: 'a planet', region: 'a region' } as const;

/**
 * One tappable place: a 48 px target named with its name and kind. The drawing beneath is
 * decoration; this is the control (keyboard focus, screen reader, 48 px hit area).
 */
export function BodyTarget({
  x,
  y,
  size = target.comfortable,
  label,
  kind,
  hypothetical,
  selected,
  onPress,
  testID,
}: {
  readonly x: number;
  readonly y: number;
  readonly size?: number;
  /** The place's name; for something that is not a place, the whole accessible name. */
  readonly label: string;
  /** Omitted for dust, which is not a place and has no kind. */
  readonly kind?: keyof typeof KIND_PHRASE;
  readonly hypothetical?: boolean;
  readonly selected?: boolean;
  readonly onPress: () => void;
  readonly testID: string;
}) {
  const focus = useFocusRing('onDark');
  const side = Math.max(size, target.comfortable);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={kind ? `${label}, ${KIND_PHRASE[kind]}${hypothetical ? ', hypothetical' : ''}` : label}
      accessibilityState={{ selected: Boolean(selected) }}
      onPress={onPress}
      {...focus.props}
      style={[
        styles.target,
        { left: x - side / 2, top: y - side / 2, width: side, height: side, borderRadius: side / 2 },
        focus.style,
        selected ? { borderWidth: highlightRing.width, borderColor: highlightRing.color } : null,
      ]}
    />
  );
}

/** A name drawn on the map: plain cream text on the sky, or a pill where the ground is busy (close-ups). */
export function MapLabel({
  label,
  text,
  variant = 'plain',
  calm,
}: {
  readonly label: PlacedLabel;
  readonly text: string;
  readonly variant?: 'plain' | 'pill' | 'selected';
  readonly calm?: boolean;
}) {
  const pill = variant !== 'plain';
  return (
    <View
      pointerEvents="none"
      style={[
        styles.label,
        { left: label.x, top: label.y, width: label.width, height: label.height },
        pill ? styles.pill : null,
        variant === 'selected' ? styles.selectedPill : null,
      ]}
    >
      <Text
        variant="spaceLabel"
        color={variant === 'selected' ? content.ink : calm ? space.label2 : space.label}
        align="center"
        numberOfLines={1}
        style={pill ? null : styles.plainText}
      >
        {text}
      </Text>
    </View>
  );
}

/** Decoration and hit targets share one absolute layer over the drawing. */
export function SceneLayer({ children }: { readonly children: ReactNode }) {
  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  target: { position: 'absolute', backgroundColor: 'transparent', cursor: 'pointer' as const },
  label: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  pill: { backgroundColor: space.labelChip, borderRadius: 13, paddingHorizontal: 6 },
  selectedPill: { backgroundColor: space.focus },
  plainText: { textShadowColor: space.s0, textShadowRadius: 4, textShadowOffset: { width: 0, height: 0 } },
});
