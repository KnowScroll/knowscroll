import { StyleSheet, View, type ViewStyle } from 'react-native';
import { borderWidth, content, radius, spacing, typeScaling } from '@knowscroll/design-tokens';
import { useDisplay, type Display } from '../display/display';
import type { IconName } from '../icons/icon-paths';
import { Text } from '../text/text';
import { Button } from './button';
import { IconButton } from './icon-button';

/**
 * One action set for both formats (D-006 b): Like · Save · Share · Ask, then More (⋯). The
 * Reel/Scroll switch belongs to the same set and sits in the top bar on both formats.
 */
export type EncounterAction = 'like' | 'save' | 'share' | 'ask' | 'more';

interface ActionSpec {
  readonly id: EncounterAction;
  readonly icon: IconName;
  /**
   * The visible word. It does not change when a toggle is pressed: the name stays the label
   * (WCAG 2.5.3) and the pressed state is announced and drawn instead.
   */
  readonly word: string;
  /** Accessible name of the icon button, when it says more than the word. */
  readonly name?: string;
}

export const encounterActionSet: readonly ActionSpec[] = [
  { id: 'like', icon: 'like', word: 'Like' },
  { id: 'save', icon: 'save', word: 'Save' },
  { id: 'share', icon: 'share', word: 'Share' },
  { id: 'ask', icon: 'ask', word: 'Ask', name: 'Ask about this' },
  { id: 'more', icon: 'more', word: 'More', name: 'More options' },
];

export interface EncounterActionPlacement {
  /** Both formats keep their actions on the end (right, in left-to-right layouts) side. */
  readonly side: 'end';
  /** `line`: one row or column of icon buttons; `grid`: 2 × 2 text buttons for large text. */
  readonly arrangement: 'line' | 'grid';
  /** Compact phones (≤ 360): 44 px buttons, words move into the accessible names. */
  readonly compact: boolean;
}

/**
 * Where and how the encounter actions sit. It takes no format: Reel and Scroll get the same
 * answer for every display (D-006 b), and both components lay themselves out from it; only the
 * direction of a line differs (a column along the Reel's edge, a row in the Scroll's strip).
 */
export function encounterActionPlacement(
  display: Pick<Display, 'breakpoint' | 'textScale'>,
  dense = false,
): EncounterActionPlacement {
  if (display.textScale > typeScaling.labelsSentenceCaseAbove)
    return { side: 'end', arrangement: 'grid', compact: false };
  return { side: 'end', arrangement: 'line', compact: dense || display.breakpoint === 'compact' };
}

/** The container style a placement means, shared by the rail and the strip. */
function placementStyle(placement: EncounterActionPlacement, align?: 'start' | 'end'): ViewStyle {
  if (placement.arrangement === 'grid') return { alignSelf: 'stretch' };
  return { alignSelf: (align ?? placement.side) === 'end' ? 'flex-end' : 'flex-start' };
}

export interface EncounterActionsProps {
  /** Actions whose command exists; others are not rendered. Order always follows the set. */
  readonly available: readonly EncounterAction[];
  readonly liked?: boolean;
  readonly saved?: boolean;
  /** The Save command is in flight. */
  readonly saving?: boolean;
  /** Short screens: 44 px buttons without words, as on a compact phone. */
  readonly dense?: boolean;
  /** Where the Scroll's strip sits in its row: under the opening it starts at the text edge (E02-1). */
  readonly align?: 'start' | 'end';
  readonly onAction: (action: EncounterAction) => void;
}

function visibleSet(available: readonly EncounterAction[]): readonly ActionSpec[] {
  return encounterActionSet.filter((spec) => available.includes(spec.id));
}

function pressedFor(spec: ActionSpec, props: EncounterActionsProps): boolean | undefined {
  if (spec.id === 'like') return props.liked ?? false;
  if (spec.id === 'save') return props.saved ?? false;
  return undefined;
}

/*
 * The containers are `group`s named "Actions": a `toolbar` would promise arrow-key roving focus,
 * and each action is its own Tab stop instead.
 */

function ActionGrid({ props, placement }: { props: EncounterActionsProps; placement: EncounterActionPlacement }) {
  return (
    <View role="group" accessibilityLabel="Actions" style={[styles.grid, placementStyle(placement)]}>
      {visibleSet(props.available).map((spec) => {
        const pressed = pressedFor(spec, props);
        return (
          <View key={spec.id} style={styles.gridCell}>
            <Button
              label={spec.word}
              variant={pressed === true ? 'primary' : 'ghost'}
              toggled={pressed}
              busy={spec.id === 'save' && props.saving === true}
              busyLabel="Saving"
              onPress={() => props.onAction(spec.id)}
              fullWidth
            />
          </View>
        );
      })}
    </View>
  );
}

/** The Reel's action rail: a column of on-media icon buttons with a word under each. */
export function ActionRail(props: EncounterActionsProps) {
  const display = useDisplay();
  const placement = encounterActionPlacement(display, props.dense);
  if (placement.arrangement === 'grid') return <ActionGrid props={props} placement={placement} />;
  return (
    <View
      role="group"
      accessibilityLabel="Actions"
      style={[styles.rail, placement.compact ? styles.railCompact : null, placementStyle(placement)]}
    >
      {visibleSet(props.available).map((spec) => {
        const pressed = pressedFor(spec, props);
        return (
          <View key={spec.id} style={styles.railItem}>
            <IconButton
              icon={spec.icon}
              label={spec.name ?? spec.word}
              variant="onMedia"
              size={placement.compact ? 44 : 48}
              pressed={pressed}
              busy={spec.id === 'save' && props.saving === true}
              onPress={() => props.onAction(spec.id)}
            />
            {placement.compact ? null : (
              // The word repeats the button's name, so assistive technology skips it.
              <View aria-hidden importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
                <Text variant="uiLabel" color={content.paper}>
                  {spec.word}
                </Text>
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

/** The Scroll's action strip: the same actions in a pill row (top and end of the article). */
export function ActionStrip(props: EncounterActionsProps) {
  const display = useDisplay();
  const placement = encounterActionPlacement(display, props.dense);
  if (placement.arrangement === 'grid') return <ActionGrid props={props} placement={placement} />;
  return (
    <View role="group" accessibilityLabel="Actions" style={[styles.strip, placementStyle(placement, props.align)]}>
      {visibleSet(props.available).map((spec) => (
        <IconButton
          key={spec.id}
          icon={spec.icon}
          label={spec.name ?? spec.word}
          variant="plain"
          size={placement.compact ? 44 : 48}
          pressed={pressedFor(spec, props)}
          busy={spec.id === 'save' && props.saving === true}
          onPress={() => props.onAction(spec.id)}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  rail: { alignItems: 'center', gap: spacing['3.5'] },
  railCompact: { gap: spacing[2] },
  railItem: { alignItems: 'center', gap: spacing[1] },
  strip: {
    flexDirection: 'row',
    gap: spacing[2],
    padding: spacing[2],
    borderRadius: radius.pill,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[3] },
  gridCell: { flexBasis: '45%', flexGrow: 1 },
});
