import { useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { borderWidth, content, radius, spacing, target } from '@knowscroll/design-tokens';
import { formatWithUnit, type SimulationParam } from '../../model';
import { useFocusRing } from '../../../display/focus-ring';
import { Text } from '../../../text/text';
import { useSliderGesture } from './slider-gesture';
import { ratioOf, stepped, valueForKey } from './slider-model';

const THUMB = 32;

export interface SliderProps {
  readonly param: SimulationParam;
  /** The value shown: the committed one, or the one being dragged. */
  readonly value: number;
  /** A drag is moving the value: update the views, keep nothing yet. */
  readonly onPreview: (value: number) => void;
  /** The value is final (release, a key, an assistive action, a tap): keep it. */
  readonly onCommit: (value: number, how: 'drag' | 'control') => void;
  readonly onDragging: (dragging: boolean) => void;
  /** What a screen reader hears for a value, when the parameter's own format would not say it right. */
  readonly valueText?: ((value: number) => string) | undefined;
}

/**
 * The slider (E03-2): a track, a fill, a thumb, its range in words. It is a real slider for
 * assistive technology: role `slider` with a value text ("4,096 words"), the arrow keys step by
 * one, Page Up and Page Down by a tenth, Home and End jump to the ends; VoiceOver and TalkBack
 * get increment and decrement actions. A drag is owned once the horizontal axis locks
 * (`useSliderGesture`). The row is 48 px tall; the thumb is 32 and sits inside it.
 */
export function Slider({ param, value, onPreview, onCommit, onDragging, valueText }: SliderProps) {
  const [width, setWidth] = useState(0);
  const focus = useFocusRing('onLight');
  const travel = Math.max(0, width - THUMB);
  const ratio = ratioOf(param, value);
  const text = valueText === undefined ? formatWithUnit(value, param.format, param.unit) : valueText(value);
  const gesture = useSliderGesture({
    param,
    travel,
    inset: THUMB / 2,
    onPreview,
    onCommit: (next, dragged) => onCommit(next, dragged ? 'drag' : 'control'),
    onDragging,
  });
  const nudge = (steps: number) => onCommit(stepped(param, value, steps), 'control');

  const track = (
    <View
      testID={`slider-${param.key}`}
      role="slider"
      accessible
      accessibilityLabel={param.label}
      accessibilityValue={{ min: param.min, max: param.max, now: value, text }}
      aria-valuemin={param.min}
      aria-valuemax={param.max}
      aria-valuenow={value}
      aria-valuetext={text}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'increment') nudge(1);
        if (event.nativeEvent.actionName === 'decrement') nudge(-1);
      }}
      tabIndex={0}
      onKeyDown={(event) => {
        const next = valueForKey(param, value, event.nativeEvent.key);
        if (next === null) return;
        event.preventDefault();
        onCommit(next, 'control');
      }}
      onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
      {...focus.props}
      {...gesture.viewProps}
      style={[styles.row, gesture.viewProps['style'] as object | undefined]}
    >
      <View style={styles.rail} pointerEvents="none">
        <View style={[styles.fill, { width: THUMB / 2 + travel * ratio }]} />
      </View>
      <View
        pointerEvents="none"
        style={[styles.thumb, { left: travel * ratio }, focus.style]}
        accessible={false}
        importantForAccessibility="no"
      />
    </View>
  );
  return gesture.wrap(track);
}

/** "512 words" and "4,096 words" under the ends of the track. */
export function SliderRange({ param }: { readonly param: SimulationParam }) {
  return (
    <View style={styles.range}>
      <Text variant="meta" color={content.ink2}>
        {formatWithUnit(param.min, param.format, param.unit)}
      </Text>
      <Text variant="meta" color={content.ink2}>
        {formatWithUnit(param.max, param.format, param.unit)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { height: target.comfortable, justifyContent: 'center', cursor: 'pointer' as const },
  rail: {
    height: spacing['1.5'],
    borderRadius: radius.tag,
    borderWidth: borderWidth.light,
    borderColor: content.ink,
    backgroundColor: content.paper2,
    overflow: 'hidden',
  },
  fill: { height: '100%', backgroundColor: content.accent },
  thumb: {
    position: 'absolute',
    top: (target.comfortable - THUMB) / 2,
    width: THUMB,
    height: THUMB,
    borderRadius: radius.pill,
    borderWidth: 2.5,
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
  range: { flexDirection: 'row', justifyContent: 'space-between' },
});
