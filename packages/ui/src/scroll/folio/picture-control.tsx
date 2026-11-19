import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { borderWidth, spacing } from '@knowscroll/design-tokens';
import type { Picture, PictureState } from '@knowscroll/scroll-model';
import { canonicalJson, describePicture } from '../model';
import { useFocusRing } from '../../display/focus-ring';
import { radioGroupSemantics, radioSemantics, toggleSemantics } from '../../display/semantics';
import { spaceActivates } from '../../display/space-key';
import { Text } from '../../text/text';
import { usePagePalette } from '../page/page-palette';
import type { FigureControl } from './reading-model';

/** The controls of a document v3 picture; the tilt of a v2 kit picture is drawn by `KitFigureView`. */
export type PictureFigureControl = Exclude<FigureControl, { readonly kind: 'tilt' }>;

export interface PictureControlProps {
  readonly picture: Picture;
  readonly control: PictureFigureControl;
  /** The state the beat shows: where a control starts and what a switch flips back to. */
  readonly base: PictureState;
  /** The state the picture is in now. */
  readonly state: PictureState;
  /** The reader chose another state. It is theirs alone: nothing is reported or stored (D-209). */
  readonly onState: (state: PictureState) => void;
}

/** The target size of a control: 44 px each way, so a thumb or a pointer finds it. */
const TARGET = 44;

/** What a chip's ref holds: the native view behind the pressable. */
type ChipNode = ComponentRef<typeof View>;

const sameState = (first: PictureState, second: PictureState): boolean =>
  canonicalJson(first) === canonicalJson(second);

/**
 * The control under a picture's figure. `scrub` steps through positions (Previous, Next, a chip for each), `switch` flips
 * between the beat's state and one other, `pick` lights one item and reads its note. Each says its sentence in a polite
 * live region: the picture's words for the state it is in, or the chosen item's note.
 */
export function PictureControl(props: PictureControlProps) {
  const { control } = props;
  switch (control.kind) {
    case 'scrub':
      return <ScrubControl {...props} control={control} />;
    case 'switch':
      return <SwitchControl {...props} control={control} />;
    case 'pick':
      return <PickControl {...props} control={control} />;
  }
}

/** Where the sentence goes: a polite live region, always there, so a change is announced rather than a new region found. */
function Sentence({ heading, text }: { readonly heading?: string | undefined; readonly text: string }) {
  const page = usePagePalette();
  return (
    <View role="status" accessibilityLiveRegion="polite" style={styles.sentence} testID="control-sentence">
      {heading === undefined ? null : (
        <Text variant="label" color={page.ink2}>
          {heading}
        </Text>
      )}
      {text === '' ? null : (
        <Text variant="body" color={page.ink}>
          {text}
        </Text>
      )}
    </View>
  );
}

function ScrubControl({
  picture,
  control,
  state,
  onState,
}: PictureControlProps & { readonly control: Extract<PictureFigureControl, { readonly kind: 'scrub' }> }) {
  const { positions } = control;
  const page = usePagePalette();
  const at = positions.findIndex((position) => sameState(position.state, state));
  const go = (index: number) => {
    const position = positions[index];
    if (position !== undefined) onState(position.state);
  };
  const current = positions[at];
  return (
    <View style={styles.control} testID="picture-control-scrub">
      <Text variant="label" color={page.ink2}>
        {control.label}
      </Text>
      <View style={styles.row}>
        <ChipButton label="Previous" disabled={at === 0} onPress={() => go(at < 0 ? positions.length - 1 : at - 1)} />
        <ChipButton label="Next" disabled={at === positions.length - 1} onPress={() => go(at + 1)} />
      </View>
      <ChoiceRow
        label={control.label}
        choices={positions.map((position) => position.label)}
        selected={at}
        onChoose={go}
      />
      <Sentence heading={current?.label} text={current === undefined ? '' : describePicture(picture, current.state)} />
    </View>
  );
}

function SwitchControl({
  picture,
  control,
  base,
  state,
  onState,
}: PictureControlProps & { readonly control: Extract<PictureFigureControl, { readonly kind: 'switch' }> }) {
  const flipped = sameState(state, control.to);
  return (
    <View style={styles.control} testID="picture-control-switch">
      <View style={styles.row}>
        <ChipButton
          label={control.label}
          selected={flipped}
          semantics={toggleSemantics(flipped)}
          onPress={() => onState(flipped ? base : control.to)}
        />
      </View>
      <Sentence text={describePicture(picture, state)} />
    </View>
  );
}

function PickControl({
  control,
  base,
  onState,
}: PictureControlProps & { readonly control: Extract<PictureFigureControl, { readonly kind: 'pick' }> }) {
  const page = usePagePalette();
  const [chosen, setChosen] = useState<number | undefined>(undefined);
  const choose = (index: number) => {
    const item = control.items[index];
    if (item === undefined) return;
    setChosen(index);
    onState({ ...base, lit: [item.id] });
  };
  const item = chosen === undefined ? undefined : control.items[chosen];
  return (
    <View style={styles.control} testID="picture-control-pick">
      <Text variant="label" color={page.ink2}>
        {control.label}
      </Text>
      <ChoiceRow
        label={control.label}
        choices={control.items.map((each) => each.label)}
        selected={chosen ?? -1}
        onChoose={choose}
      />
      <Sentence heading={item?.label} text={item?.note ?? ''} />
    </View>
  );
}

interface KeyEvent {
  readonly nativeEvent: unknown;
  preventDefault(): void;
}

/** Where an arrow, Home or End key takes the choice from `from` among `count`, or nowhere for another key. */
export function stepOfKey(key: string, from: number, count: number): number | undefined {
  if (count === 0) return undefined;
  if (key === 'ArrowRight' || key === 'ArrowDown') return Math.min(count - 1, from + 1);
  if (key === 'ArrowLeft' || key === 'ArrowUp') return Math.max(0, from < 0 ? count - 1 : from - 1);
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return undefined;
}

/**
 * One chip for each choice, one chosen at a time (a radio group): a tap chooses; the arrow keys, Home and End move the
 * choice and the focus with it. The key handler is a web one in effect, as the props are not in React Native's types.
 */
function ChoiceRow({
  label,
  choices,
  selected,
  onChoose,
}: {
  readonly label: string;
  readonly choices: readonly string[];
  /** The index chosen, or -1 where none is yet. */
  readonly selected: number;
  readonly onChoose: (index: number) => void;
}) {
  // Which chip holds the keyboard's focus: set by a chip taking it and by an arrow key moving it, and read by the next key.
  const [focusAt, setFocusAt] = useState(-1);
  const keys = {
    onKeyDown: (event: KeyEvent) => {
      const key = (event.nativeEvent as { key?: string }).key ?? '';
      const target = stepOfKey(key, focusAt >= 0 ? focusAt : selected, choices.length);
      if (target === undefined) return;
      event.preventDefault();
      setFocusAt(target);
      onChoose(target);
    },
  };
  return (
    <View {...radioGroupSemantics(label)} {...keys} style={styles.row}>
      {choices.map((choice, index) => (
        <ChipButton
          key={index}
          focused={index === focusAt}
          label={choice}
          selected={index === selected}
          semantics={{ ...radioSemantics(index === selected), ...spaceActivates(() => onChoose(index)) }}
          onFocus={() => setFocusAt(index)}
          onPress={() => onChoose(index)}
        />
      ))}
    </View>
  );
}

/** One button of a control: a pill at least 44 px each way, filled with ink when it is the chosen one. */
function ChipButton({
  label,
  onPress,
  onFocus,
  selected = false,
  disabled = false,
  semantics,
  focused = false,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly onFocus?: (() => void) | undefined;
  readonly selected?: boolean;
  readonly disabled?: boolean;
  /** Toggle or radio semantics; a plain button where absent. */
  readonly semantics?: object | undefined;
  /** The chip the keyboard moved the focus to: it takes the focus when it becomes the one. */
  readonly focused?: boolean;
}) {
  const page = usePagePalette();
  const focus = useFocusRing('onLight');
  const node = useRef<ChipNode>(null);
  useEffect(() => {
    if (focused) node.current?.focus();
  }, [focused]);
  return (
    <Pressable
      ref={node}
      {...focus.props}
      {...(semantics ?? { accessibilityRole: 'button' })}
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onFocus={() => {
        focus.props.onFocus();
        onFocus?.();
      }}
      onPress={onPress}
      style={[
        styles.chip,
        {
          borderColor: page.ink,
          backgroundColor: selected ? page.ink : page.ground,
          opacity: disabled ? 0.4 : 1,
        },
        focus.style,
      ]}
    >
      <Text variant="uiS" color={selected ? page.ground : page.ink}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  control: { gap: spacing[2] },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  sentence: { gap: spacing[1], minWidth: 0 },
  chip: {
    minHeight: TARGET,
    minWidth: TARGET,
    maxWidth: '100%',
    flexShrink: 1,
    paddingHorizontal: spacing[3],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: TARGET / 2,
    borderWidth: borderWidth.regular,
  },
});
