import type { ReactElement } from 'react';
import Svg, { Circle, G, Line, Path, Rect, Text as SvgText } from 'react-native-svg';
import { content, family, fontFamily } from '@knowscroll/design-tokens';
import type { BlockOfType } from '@knowscroll/scroll-model';
import { makeScale, tickLabel, type Scale } from './scales';

type Spec = BlockOfType<'chart'>['data']['spec'];

/** The logical width a chart is drawn in; it scales to the width of its block. */
export const CHART_WIDTH = 318;
const HEIGHT = 230;
const TOP = 22;
const RIGHT = 12;
const BOTTOM = 40;

/**
 * Up to four series, told apart by more than colour: a colour, a dash pattern and a marker shape
 * (never the continuation yellow, D-006 b).
 */
const SERIES = [
  { color: content.accent, dash: undefined, marker: 'circle' },
  { color: content.ink, dash: '6 4', marker: 'square' },
  { color: family.learningMachines.base, dash: '2 3', marker: 'diamond' },
  { color: family.play.base, dash: '10 3 2 3', marker: 'triangle' },
] as const;

export function seriesStyle(index: number) {
  return SERIES[index % SERIES.length] ?? SERIES[0];
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const label = { fontFamily: fontFamily.mono, fontSize: 10, fill: content.ink2 } as const;

function Marker({
  kind,
  x,
  y,
  color,
}: {
  kind: (typeof SERIES)[number]['marker'];
  x: number;
  y: number;
  color: string;
}) {
  const r = 3.5;
  switch (kind) {
    case 'circle':
      return <Circle cx={x} cy={y} r={r} fill={color} stroke={content.paper} strokeWidth={1} />;
    case 'square':
      return (
        <Rect x={x - r} y={y - r} width={r * 2} height={r * 2} fill={color} stroke={content.paper} strokeWidth={1} />
      );
    case 'diamond':
      return (
        <Path
          d={`M${x} ${y - r - 1}L${x + r + 1} ${y}L${x} ${y + r + 1}L${x - r - 1} ${y}Z`}
          fill={color}
          stroke={content.paper}
          strokeWidth={1}
        />
      );
    case 'triangle':
      return (
        <Path
          d={`M${x} ${y - r - 1}L${x + r + 1} ${y + r}L${x - r - 1} ${y + r}Z`}
          fill={color}
          stroke={content.paper}
          strokeWidth={1}
        />
      );
  }
}

interface Plot {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

function axisTitle(text: string, x: number, y: number, anchor: 'start' | 'middle' | 'end'): ReactElement {
  return (
    <SvgText key={`title-${text}-${x}-${y}`} x={x} y={y} textAnchor={anchor} {...label}>
      {text}
    </SvgText>
  );
}

function withUnit(axis: { label: string; unit?: string | undefined }): string {
  return axis.unit === undefined ? axis.label : `${axis.label} (${axis.unit})`;
}

/** Horizontal gridlines and value labels down the left edge. */
function valueAxis(scale: Scale, plot: Plot): ReactElement[] {
  return scale.ticks.map((tick) => {
    const y = plot.top + plot.height * (1 - scale.at(tick));
    return (
      <G key={`tick-${tick}`}>
        <Line x1={plot.left} x2={plot.left + plot.width} y1={y} y2={y} stroke={content.rule} strokeWidth={1} />
        <SvgText x={plot.left - 6} y={y + 3.5} textAnchor="end" {...label}>
          {tickLabel(tick)}
        </SvgText>
      </G>
    );
  });
}

/** Vertical gridlines and number labels along the bottom edge. */
function numberAxis(scale: Scale, plot: Plot): ReactElement[] {
  return scale.ticks.map((tick) => {
    const x = plot.left + plot.width * scale.at(tick);
    // A label at either end of the axis hangs inward, so it is never cut off by the edge of the chart.
    const anchor = x > plot.left + plot.width - 14 ? 'end' : x < plot.left + 14 ? 'start' : 'middle';
    return (
      <G key={`xtick-${tick}`}>
        <Line x1={x} x2={x} y1={plot.top} y2={plot.top + plot.height} stroke={content.rule} strokeWidth={1} />
        <SvgText x={x} y={plot.top + plot.height + 14} textAnchor={anchor} {...label}>
          {tickLabel(tick)}
        </SvgText>
      </G>
    );
  });
}

function frame(plot: Plot): ReactElement {
  return (
    <Rect
      key="frame"
      x={plot.left}
      y={plot.top}
      width={plot.width}
      height={plot.height}
      fill="none"
      stroke={content.ink}
      strokeWidth={1.5}
    />
  );
}

function barChart(spec: Extract<Spec, { kind: 'bar' }>): { height: number; shapes: ReactElement[] } {
  const horizontal = spec.orientation === 'horizontal';
  const left = horizontal ? 84 : 44;
  const plot: Plot = { left, top: TOP, width: CHART_WIDTH - left - RIGHT, height: HEIGHT - TOP - BOTTOM };
  const values = spec.series.flatMap((series) => series.values);
  const scale = makeScale(values, spec.valueAxis, { includeZero: spec.valueAxis.scale === 'linear' });
  const shapes: ReactElement[] = [];
  const count = spec.categories.length;
  const seriesCount = spec.series.length;
  if (horizontal) {
    shapes.push(...numberAxis(scale, plot), frame(plot));
    const band = plot.height / count;
    const thickness = (band * 0.7) / seriesCount;
    const zero = plot.left + plot.width * scale.at(Math.max(scale.domain[0], Math.min(0, scale.domain[1])));
    spec.categories.forEach((category, index) => {
      const y0 = plot.top + band * index + band * 0.15;
      shapes.push(
        <SvgText
          key={`cat-${index}`}
          x={plot.left - 6}
          y={y0 + (thickness * seriesCount) / 2 + 3.5}
          textAnchor="end"
          {...label}
        >
          {clip(category, 14)}
        </SvgText>,
      );
      spec.series.forEach((series, seriesIndex) => {
        const end = plot.left + plot.width * scale.at(series.values[index] ?? 0);
        shapes.push(
          <Rect
            key={`bar-${index}-${seriesIndex}`}
            x={Math.min(zero, end)}
            y={y0 + thickness * seriesIndex}
            width={Math.max(1, Math.abs(end - zero))}
            height={thickness - 1}
            fill={seriesStyle(seriesIndex).color}
            stroke={content.ink}
            strokeWidth={1}
          />,
        );
      });
    });
    shapes.push(axisTitle(withUnit(spec.valueAxis), plot.left + plot.width / 2, HEIGHT - 6, 'middle'));
    return { height: HEIGHT, shapes };
  }
  shapes.push(...valueAxis(scale, plot), frame(plot));
  const band = plot.width / count;
  const thickness = (band * 0.7) / seriesCount;
  const zeroY = plot.top + plot.height * (1 - scale.at(Math.max(scale.domain[0], Math.min(0, scale.domain[1]))));
  const rotate = count > 6;
  spec.categories.forEach((category, index) => {
    const x0 = plot.left + band * index + band * 0.15;
    spec.series.forEach((series, seriesIndex) => {
      const top = plot.top + plot.height * (1 - scale.at(series.values[index] ?? 0));
      shapes.push(
        <Rect
          key={`bar-${index}-${seriesIndex}`}
          x={x0 + thickness * seriesIndex}
          y={Math.min(zeroY, top)}
          width={thickness - 1}
          height={Math.max(1, Math.abs(zeroY - top))}
          fill={seriesStyle(seriesIndex).color}
          stroke={content.ink}
          strokeWidth={1}
        />,
      );
    });
    const cx = plot.left + band * index + band / 2;
    shapes.push(
      <SvgText
        key={`cat-${index}`}
        x={cx}
        y={plot.top + plot.height + 14}
        textAnchor={rotate ? 'end' : 'middle'}
        rotation={rotate ? -40 : 0}
        origin={`${cx}, ${plot.top + plot.height + 14}`}
        {...label}
      >
        {clip(category, rotate ? 10 : 8)}
      </SvgText>,
    );
  });
  shapes.push(axisTitle(withUnit(spec.valueAxis), plot.left, 12, 'start'));
  return { height: HEIGHT, shapes };
}

function pointChart(spec: Extract<Spec, { kind: 'line' | 'scatter' }>): { height: number; shapes: ReactElement[] } {
  const plot: Plot = { left: 44, top: TOP, width: CHART_WIDTH - 44 - RIGHT, height: HEIGHT - TOP - BOTTOM };
  const points = spec.series.flatMap((series) => series.points);
  const xScale = makeScale(
    points.map((point) => point[0]),
    spec.x,
  );
  const yScale = makeScale(
    points.map((point) => point[1]),
    spec.y,
  );
  const shapes: ReactElement[] = [...valueAxis(yScale, plot), ...numberAxis(xScale, plot), frame(plot)];
  spec.series.forEach((series, index) => {
    const style = seriesStyle(index);
    const placed = series.points.map(
      (point) =>
        [plot.left + plot.width * xScale.at(point[0]), plot.top + plot.height * (1 - yScale.at(point[1]))] as const,
    );
    if (spec.kind === 'line') {
      const path = placed
        .map(([x, y], position) => `${position === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`)
        .join('');
      shapes.push(
        <Path
          key={`line-${index}`}
          d={path}
          fill="none"
          stroke={style.color}
          strokeWidth={2.5}
          strokeDasharray={style.dash}
          strokeLinejoin="round"
        />,
      );
    }
    // A line with many points is a curve, not a set of dots: markers only where there are few.
    if (spec.kind === 'scatter' || placed.length <= 24) {
      placed.forEach(([x, y], position) =>
        shapes.push(<Marker key={`dot-${index}-${position}`} kind={style.marker} x={x} y={y} color={style.color} />),
      );
    }
  });
  shapes.push(
    axisTitle(withUnit(spec.y), plot.left, 12, 'start'),
    axisTitle(withUnit(spec.x), plot.left + plot.width / 2, HEIGHT - 6, 'middle'),
  );
  return { height: HEIGHT, shapes };
}

function heatmap(spec: Extract<Spec, { kind: 'heatmap' }>): { height: number; shapes: ReactElement[] } {
  const rows = spec.rows.length;
  const columns = spec.columns.length;
  const left = 74;
  const top = 26;
  const cell = Math.min(44, (CHART_WIDTH - left - RIGHT) / columns);
  const height = top + rows * cell + 16;
  const shapes: ReactElement[] = [];
  const span = spec.scale.max - spec.scale.min || 1;
  spec.columns.forEach((column, index) =>
    shapes.push(
      <SvgText key={`col-${index}`} x={left + cell * index + cell / 2} y={top - 6} textAnchor="middle" {...label}>
        {clip(column, 5)}
      </SvgText>,
    ),
  );
  spec.rows.forEach((row, rowIndex) => {
    shapes.push(
      <SvgText
        key={`row-${rowIndex}`}
        x={left - 6}
        y={top + cell * rowIndex + cell / 2 + 3.5}
        textAnchor="end"
        {...label}
      >
        {clip(row, 11)}
      </SvgText>,
    );
    (spec.values[rowIndex] ?? []).forEach((value, columnIndex) => {
      shapes.push(
        <Rect
          key={`cell-${rowIndex}-${columnIndex}`}
          x={left + cell * columnIndex + 1}
          y={top + cell * rowIndex + 1}
          width={cell - 2}
          height={cell - 2}
          rx={4}
          fill={content.accent}
          fillOpacity={0.08 + 0.92 * ((value - spec.scale.min) / span)}
        />,
      );
    });
  });
  if (spec.highlightRow !== undefined) {
    shapes.push(
      <Rect
        key="highlight"
        x={left - 1}
        y={top + cell * spec.highlightRow}
        width={cell * columns + 2}
        height={cell}
        rx={6}
        fill="none"
        stroke={content.ink}
        strokeWidth={3}
      />,
    );
  }
  return { height, shapes };
}

/** The chart drawn as SVG in canvas units (`CHART_WIDTH` wide); the wrapper scales it. */
export function chartDrawing(spec: Spec): { height: number; shapes: ReactElement[] } {
  switch (spec.kind) {
    case 'bar':
      return barChart(spec);
    case 'line':
    case 'scatter':
      return pointChart(spec);
    case 'heatmap':
      return heatmap(spec);
  }
}

/** A series' swatch for the legend: its colour and dash pattern. */
export function ChartSvg({ spec }: { readonly spec: Spec }) {
  const { height, shapes } = chartDrawing(spec);
  return (
    <Svg width="100%" height="100%" viewBox={`0 0 ${CHART_WIDTH} ${height}`}>
      {shapes}
    </Svg>
  );
}
