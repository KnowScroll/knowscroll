import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Line, Path, Rect, Text as SvgText } from 'react-native-svg';
import { borderWidth, content, fontFamily, radius, spacing } from '@knowscroll/design-tokens';
import {
  displayFraction,
  displayRange,
  formatNumber,
  formatWithUnit,
  type SimulationData,
  type SimulationValues,
} from '../../model';
import { Text } from '../../../text/text';

type Sample = { readonly x: number; readonly y: number | null };

function outputOf(data: SimulationData, key: string) {
  return data.outputs.find((output) => output.key === key);
}

function paramOf(data: SimulationData, key: string) {
  return data.params.find((param) => param.key === key);
}

function shown(data: SimulationData, values: SimulationValues, key: string): string {
  const output = outputOf(data, key);
  if (output === undefined) return '—';
  return formatWithUnit(values.outputs[key] ?? null, output.format, output.unit);
}

/** One large output and an optional second line: "~64×" in the display face (E03-2). */
export function ReadoutView({ data, values }: { readonly data: SimulationData; readonly values: SimulationValues }) {
  const view = data.view;
  if (view.kind !== 'readout') return null;
  const primary = outputOf(data, view.primary);
  const secondary = view.secondary === undefined ? undefined : outputOf(data, view.secondary);
  return (
    <View style={styles.readout}>
      <Text variant="displayL" accessibilityLabel={`${primary?.label ?? ''}: ${shown(data, values, view.primary)}`}>
        {shown(data, values, view.primary)}
      </Text>
      {primary === undefined ? null : (
        <Text variant="meta" color={content.ink2}>
          {primary.label}
        </Text>
      )}
      {secondary === undefined || view.secondary === undefined ? null : (
        <Text variant="bodyS">{`${secondary.label}: ${shown(data, values, view.secondary)}`}</Text>
      )}
    </View>
  );
}

/** Two to eight outputs side by side, each with a bar scaled to the largest value the grid reaches. */
export function CardsView({ data, values }: { readonly data: SimulationData; readonly values: SimulationValues }) {
  const view = data.view;
  if (view.kind !== 'cards') return null;
  // The bar scale admission stored: read, never computed, so no client walks the grid.
  return (
    <View style={styles.cards}>
      {view.items.map((item) => {
        // Where the value stands in the stored scale: always finite, 0 to 1 (a forged scale cannot give NaN).
        const fraction = displayFraction(values.outputs[item.output] ?? null, data);
        const text = shown(data, values, item.output);
        return (
          <View key={item.id} accessible accessibilityLabel={`${item.label}: ${text}`} style={styles.card}>
            <Text variant="bodyS" style={styles.cardLabel}>
              {item.label}
            </Text>
            <Text variant="heading">{text}</Text>
            <View style={styles.bar}>
              <View style={[styles.barFill, { width: `${fraction * 100}%` }]} />
            </View>
            {item.note === undefined ? null : (
              <Text variant="meta" color={content.ink2}>
                {item.note}
              </Text>
            )}
          </View>
        );
      })}
    </View>
  );
}

const PLOT = { width: 318, height: 168, left: 10, right: 10, top: 22, bottom: 24 } as const;

/** An output as a curve over one parameter's range, with a marker where the reader's value is. */
export function PlotView({
  data,
  values,
  curve,
}: {
  readonly data: SimulationData;
  readonly values: SimulationValues;
  readonly curve: readonly Sample[];
}) {
  const view = data.view;
  if (view.kind !== 'plot') return null;
  const x = paramOf(data, view.x);
  if (x === undefined) return null;
  const [low, high] = displayRange(data);
  const spanX = x.max - x.min || 1;
  const spanY = high - low || 1;
  const areaWidth = PLOT.width - PLOT.left - PLOT.right;
  const areaHeight = PLOT.height - PLOT.top - PLOT.bottom;
  const px = (value: number) => PLOT.left + (areaWidth * (value - x.min)) / spanX;
  const py = (value: number) => PLOT.top + areaHeight * (1 - (value - low) / spanY);
  const path = curve
    .filter((point): point is { x: number; y: number } => point.y !== null)
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${px(point.x).toFixed(1)} ${py(point.y).toFixed(1)}`)
    .join('');
  const current = values.outputs[view.y];
  const here = values.params[view.x];
  const label = { fontFamily: fontFamily.mono, fontSize: 10, fill: content.ink2 } as const;
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={`${view.yLabel} over ${x.label}`}
      accessibilityValue={{
        text: `${shown(data, values, view.y)} at ${formatWithUnit(here ?? null, x.format, x.unit)}`,
      }}
      style={{ aspectRatio: PLOT.width / PLOT.height }}
    >
      <Svg width="100%" height="100%" viewBox={`0 0 ${PLOT.width} ${PLOT.height}`}>
        <Rect
          x={PLOT.left}
          y={PLOT.top}
          width={areaWidth}
          height={areaHeight}
          fill="none"
          stroke={content.ink}
          strokeWidth={1.5}
        />
        <Line x1={PLOT.left} x2={PLOT.left + areaWidth} y1={py(0)} y2={py(0)} stroke={content.rule} strokeWidth={1} />
        <Path d={path} fill="none" stroke={content.accent} strokeWidth={3} strokeLinejoin="round" />
        {current === null || current === undefined || here === undefined ? null : (
          <Circle cx={px(here)} cy={py(current)} r={6} fill={content.paper} stroke={content.ink} strokeWidth={2.5} />
        )}
        <SvgText x={PLOT.left} y={13} {...label}>
          {view.yLabel}
        </SvgText>
        <SvgText x={PLOT.left} y={PLOT.height - 8} {...label}>
          {formatNumber(x.min, x.format)}
        </SvgText>
        <SvgText x={PLOT.left + areaWidth} y={PLOT.height - 8} textAnchor="end" {...label}>
          {formatNumber(x.max, x.format)}
        </SvgText>
      </Svg>
    </View>
  );
}

/** A parameter as a bar beside an output as a square whose area follows the output. */
export function AreaView({ data, values }: { readonly data: SimulationData; readonly values: SimulationValues }) {
  const view = data.view;
  if (view.kind !== 'area') return null;
  const length = paramOf(data, view.length);
  if (length === undefined) return null;
  const lengthShare = Math.min(
    1,
    Math.max(0, ((values.params[view.length] ?? length.min) - length.min) / (length.max - length.min || 1)),
  );
  // The square's area follows the output against the stored scale; a value a hair above it (engines
  // round the last digit differently) is clamped by `displayFraction`.
  const side = Math.sqrt(displayFraction(values.outputs[view.area] ?? null, data));
  return (
    <View style={styles.area}>
      <View style={styles.areaColumn}>
        <View style={styles.lengthTrack}>
          <View style={[styles.lengthFill, { width: `${Math.max(4, lengthShare * 100)}%` }]} />
        </View>
        <Text variant="meta" color={content.ink2}>
          {`${view.lengthLabel}: ${formatWithUnit(values.params[view.length] ?? null, length.format, length.unit)}`}
        </Text>
      </View>
      <View style={styles.areaColumn}>
        <View style={styles.square}>
          <View
            style={[styles.squareFill, { width: `${Math.max(4, side * 100)}%`, height: `${Math.max(4, side * 100)}%` }]}
          />
        </View>
        <Text variant="meta" color={content.ink2}>
          {`${view.areaLabel}: ${shown(data, values, view.area)}`}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  readout: { gap: spacing[1] },
  cards: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing['2.5'] },
  card: {
    flexGrow: 1,
    flexBasis: '45%',
    gap: spacing[1],
    padding: spacing[3],
    borderRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
  cardLabel: { fontWeight: '700' },
  bar: { height: spacing[2], borderRadius: radius.tag, backgroundColor: content.paper2, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: radius.tag, backgroundColor: content.accent },
  area: { flexDirection: 'row', gap: spacing[4], alignItems: 'flex-end' },
  areaColumn: { flex: 1, gap: spacing[2] },
  lengthTrack: {
    height: spacing[4],
    borderRadius: radius.tag,
    borderWidth: borderWidth.light,
    borderColor: content.ink,
    backgroundColor: content.paper2,
    overflow: 'hidden',
  },
  lengthFill: { height: '100%', backgroundColor: content.accent },
  square: {
    aspectRatio: 1,
    width: '100%',
    justifyContent: 'flex-end',
    borderWidth: borderWidth.light,
    borderColor: content.ink,
    backgroundColor: content.paper2,
  },
  squareFill: { backgroundColor: content.accent },
});
