import { StyleSheet, View } from 'react-native';
import { content, spacing } from '@knowscroll/design-tokens';
import type { SimulationParam } from '../model';
import { AXIAL_TILT_DEGREES, TILT_RANGE } from '../model';
import { Text } from '../../text/text';
import { Slider, SliderRange } from '../blocks/simulation/slider-view';

/** Earth's tilt as the slider sees it: whole degrees from nothing to a right angle, starting at the tilt it has now. */
const TILT_PARAM: SimulationParam = {
  key: 'tilt',
  label: 'Earth’s tilt',
  unit: '°',
  min: TILT_RANGE.min,
  max: TILT_RANGE.max,
  step: TILT_RANGE.step,
  default: AXIAL_TILT_DEGREES,
  control: 'slider',
  format: { decimals: 0, grouping: false, approximate: false },
};

/** "23.4°" for today's tilt, whole degrees for any other. */
export function tiltText(degrees: number): string {
  return degrees === AXIAL_TILT_DEGREES ? `${AXIAL_TILT_DEGREES}°` : `${String(Math.round(degrees))}°`;
}

/**
 * The control a Final call hands the reader (D-187): turn Earth's axis on the pinned picture before
 * answering. The value is the reader's to play with. It is kept on this screen only: nothing about it
 * is saved, reported or sent, and the picture draws whatever it says at once.
 */
export function TiltControl({
  value,
  onChange,
  onDragging,
}: {
  readonly value: number;
  readonly onChange: (degrees: number) => void;
  readonly onDragging: (dragging: boolean) => void;
}) {
  return (
    <View style={styles.control} testID="tilt-control">
      <View style={styles.readout}>
        <Text variant="label" color={content.ink2}>
          Earth’s tilt
        </Text>
        <Text variant="title" testID="tilt-value">
          {tiltText(value)}
        </Text>
        {value === AXIAL_TILT_DEGREES ? (
          <Text variant="meta" color={content.ink2}>
            today
          </Text>
        ) : (
          <Text variant="meta" color={content.ink2}>
            {`${String(AXIAL_TILT_DEGREES)}° today`}
          </Text>
        )}
      </View>
      <Slider
        param={TILT_PARAM}
        value={value}
        onPreview={onChange}
        onCommit={(next) => onChange(next)}
        onDragging={onDragging}
        valueText={tiltText}
      />
      <SliderRange param={TILT_PARAM} />
    </View>
  );
}

const styles = StyleSheet.create({
  control: { alignSelf: 'stretch', gap: spacing[1] },
  readout: { flexDirection: 'row', alignItems: 'baseline', gap: spacing[2] },
});
