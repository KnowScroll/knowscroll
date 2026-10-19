import { StyleSheet, View } from 'react-native';
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
  /** Visible word. */
  readonly word: string;
  /**
   * Visible word once pressed (toggles only). Icon toggles keep their name ("Save") and report
   * the pressed state; the large-text grid shows the word, so there the word is the name.
   */
  readonly pressedWord?: string;
  /** Accessible name, when it says more than the word. */
  readonly name?: string;
}

export const encounterActionSet: readonly ActionSpec[] = [
  { id: 'like', icon: 'like', word: 'Like', pressedWord: 'Liked' },
  { id: 'save', icon: 'save', word: 'Save', pressedWord: 'Saved' },
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
 * answer for every display (D-006 b); only the orientation of a line differs (a column along
 * the Reel's edge, a row in the Scroll's strip).
 */
export function encounterActionPlacement(display: Pick<Display, 'breakpoint' | 'textScale'>): EncounterActionPlacement {
  if (display.textScale > typeScaling.labelsSentenceCaseAbove)
    return { side: 'end', arrangement: 'grid', compact: false };
  return { side: 'end', arrangement: 'line', compact: display.breakpoint === 'compact' };
}

export interface EncounterActionsProps {
  /** Actions whose command exists; others are not rendered. Order always follows the set. */
  readonly available: readonly EncounterAction[];
  readonly liked?: boolean;
  readonly saved?: boolean;
  /** The Save command is in flight. */
  readonly saving?: boolean;
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

function wordFor(spec: ActionSpec, pressed: boolean | undefined): string {
  return pressed === true && spec.pressedWord !== undefined ? spec.pressedWord : spec.word;
}

function ActionGrid({ props }: { props: EncounterActionsProps }) {
  return (
    <View role="toolbar" accessibilityLabel="Actions" style={styles.grid}>
      {visibleSet(props.available).map((spec) => {
        const pressed = pressedFor(spec, props);
        return (
          <View key={spec.id} style={styles.gridCell}>
            <Button
              label={wordFor(spec, pressed)}
              variant={pressed === true ? 'continue' : 'ghost'}
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
  const placement = encounterActionPlacement(display);
  if (placement.arrangement === 'grid') return <ActionGrid props={props} />;
  return (
    <View role="toolbar" accessibilityLabel="Actions" style={styles.rail}>
      {visibleSet(props.available).map((spec) => {
        const pressed = pressedFor(spec, props);
        const word = wordFor(spec, pressed);
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
                  {word}
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
  const placement = encounterActionPlacement(display);
  if (placement.arrangement === 'grid') return <ActionGrid props={props} />;
  return (
    <View role="toolbar" accessibilityLabel="Actions" style={styles.strip}>
      {visibleSet(props.available).map((spec) => {
        const pressed = pressedFor(spec, props);
        return (
          <IconButton
            key={spec.id}
            icon={spec.icon}
            label={spec.name ?? spec.word}
            variant="plain"
            size={placement.compact ? 44 : 48}
            pressed={pressed}
            busy={spec.id === 'save' && props.saving === true}
            onPress={() => props.onAction(spec.id)}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  rail: { alignSelf: 'flex-end', alignItems: 'center', gap: spacing['3.5'] },
  railItem: { alignItems: 'center', gap: spacing[1] },
  strip: {
    alignSelf: 'flex-end',
    flexDirection: 'row',
    gap: spacing[2],
    padding: spacing[2],
    borderRadius: radius.pill,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
  grid: { alignSelf: 'stretch', flexDirection: 'row', flexWrap: 'wrap', gap: spacing[3] },
  gridCell: { flexBasis: '45%', flexGrow: 1 },
});
