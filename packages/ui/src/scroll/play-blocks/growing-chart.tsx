import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, G, Line, Polyline, Rect, Text as SvgText } from 'react-native-svg';
import { content, fontFamily, spacing } from '@knowscroll/design-tokens';
import { Button } from '../../actions/button';
import { Text } from '../../text/text';
import { makeScale, tickLabel } from '../blocks/chart/scales';
import { describeChart, describePoint, type GrowingChart } from '../model';

const WIDTH = 320;
const HEIGHT = 190;
const LEFT = 70;
const RIGHT = WIDTH - 12;
const TOP = 14;
const BOTTOM = HEIGHT - 36;
const INK = content.ink;
const MUTED = content.muted;

/** A label cut to fit its band: the full label is always in the readout and the text version. */
function fitted(label: string, bandWidth: number): string {
  const room = Math.max(3, Math.floor(bandWidth / 5.6));
  return label.length <= room ? label : `${label.slice(0, room - 1)}…`;
}

/**
 * A chart that grows (D-207): the reader reveals its points one at a time, so the shape builds up.
 * The axis is fixed from every point from the start, so nothing jumps when the next one arrives. Every
 * value is a figure of the cited passages (the authoring rules refuse any other); the text version is
 * the whole list. The reveal is a step the reader takes, not an animation, so reduced motion has nothing
 * to remove.
 */
export function ChartBody({ chart, asText }: { readonly chart: GrowingChart; readonly asText: boolean }) {
  const [shown, setShown] = useState(1);
  if (asText)
    return (
      <Text variant="body" testID="chart-text">
        {describeChart(chart)}
      </Text>
    );
  const count = chart.points.length;
  const axis = makeScale(
    chart.points.map((point) => point.value),
    { scale: 'linear' },
    { includeZero: true },
  );
  const band = (RIGHT - LEFT) / count;
  const yOf = (value: number): number => BOTTOM - (BOTTOM - TOP) * axis.at(value);
  const centreOf = (index: number): number => LEFT + band * (index + 0.5);
  const visible = chart.points.slice(0, shown);
  const last = visible[visible.length - 1];
  return (
    <View style={styles.body}>
      <View
        style={styles.picture}
        role="img"
        aria-label={`${describeChart(chart)} ${String(shown)} of ${String(count)} points shown.`}
        accessibilityLabel={`${describeChart(chart)} ${String(shown)} of ${String(count)} points shown.`}
      >
        <Svg width="100%" height="100%" viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`} aria-hidden>
          {axis.ticks.map((tick) => (
            <G key={tick}>
              <Line
                x1={LEFT}
                y1={yOf(tick)}
                x2={RIGHT}
                y2={yOf(tick)}
                stroke={MUTED}
                strokeWidth={0.8}
                strokeDasharray="3 3"
              />
              <SvgText
                x={LEFT - 6}
                y={yOf(tick) + 3.5}
                fontSize={10}
                fontFamily={fontFamily.mono}
                fill={MUTED}
                textAnchor="end"
              >
                {tickLabel(tick)}
              </SvgText>
            </G>
          ))}
          <Line x1={LEFT} y1={BOTTOM} x2={RIGHT} y2={BOTTOM} stroke={INK} strokeWidth={2.5} />
          {chart.shape === 'bars' ? (
            visible.map((point, index) => (
              <Rect
                key={point.label}
                x={centreOf(index) - band * 0.3}
                y={yOf(point.value)}
                width={band * 0.6}
                height={Math.max(1, BOTTOM - yOf(point.value))}
                fill={index === shown - 1 ? content.accent : content.continue}
                stroke={INK}
                strokeWidth={2}
              />
            ))
          ) : (
            <G>
              {visible.length > 1 ? (
                <Polyline
                  points={visible
                    .map((point, index) => `${String(centreOf(index))},${String(yOf(point.value))}`)
                    .join(' ')}
                  fill="none"
                  stroke={INK}
                  strokeWidth={2.5}
                  strokeLinejoin="round"
                />
              ) : null}
              {visible.map((point, index) => (
                <Circle
                  key={point.label}
                  cx={centreOf(index)}
                  cy={yOf(point.value)}
                  r={index === shown - 1 ? 6 : 4.5}
                  fill={index === shown - 1 ? content.accent : content.continue}
                  stroke={INK}
                  strokeWidth={2}
                />
              ))}
            </G>
          )}
          {chart.points.map((point, index) => (
            <SvgText
              key={point.label}
              x={centreOf(index)}
              y={BOTTOM + 15}
              fontSize={9}
              fontFamily={fontFamily.mono}
              fill={index < shown ? INK : MUTED}
              textAnchor="middle"
            >
              {fitted(point.label, band)}
            </SvgText>
          ))}
          <SvgText x={RIGHT} y={HEIGHT - 4} fontSize={10} fontFamily={fontFamily.mono} fill={MUTED} textAnchor="end">
            {chart.unit}
          </SvgText>
        </Svg>
      </View>
      <View accessibilityLiveRegion="polite" role="status">
        {last === undefined ? null : (
          <Text variant="meta" color={content.ink2} testID="chart-readout">
            {describePoint(last, chart.unit)}
          </Text>
        )}
      </View>
      <View style={styles.actions}>
        {shown < count ? (
          <Button label="Show the next point" variant="default" onPress={() => setShown(shown + 1)} />
        ) : (
          <Button label="Start again" variant="ghost" onPress={() => setShown(1)} />
        )}
        {shown < count - 1 ? <Button label="Show every point" variant="ghost" onPress={() => setShown(count)} /> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing[3] },
  picture: { alignSelf: 'stretch', aspectRatio: WIDTH / HEIGHT },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
});
