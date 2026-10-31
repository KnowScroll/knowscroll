import type { ReactElement } from 'react';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';
import { ROOM_SWATCHES, type RoomKit, type RoomMotif } from '@knowscroll/contracts';

/**
 * The faint pattern behind a room's band (D-170): one of the closed list, drawn in the kit's accent. Where the stars and
 * lines fall comes from a number made of the kit's own words, so the same kit is always drawn the same and two kits that
 * differ look different. Decoration only: it carries no meaning, so it is hidden from screen readers.
 */

const WIDTH = 320;
const HEIGHT = 112;

/** A repeatable list of numbers from 0 to 1, from the kit's words (a small linear congruential generator). */
function numbersFrom(seed: string): () => number {
  let state = 2166136261;
  for (let index = 0; index < seed.length; index += 1)
    state = Math.imul(state ^ seed.charCodeAt(index), 16777619) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

type Draw = (next: () => number, colour: string) => ReactElement[];

const drawings: Record<RoomMotif, Draw> = {
  'star-field': (next, colour) =>
    Array.from({ length: 30 }, (_, index) => (
      <Circle key={index} cx={next() * WIDTH} cy={next() * HEIGHT} r={0.6 + next() * 1.4} fill={colour} />
    )),
  constellation: (next, colour) => {
    const points = Array.from({ length: 7 }, (_, index) => [150 + index * 24 + next() * 14, 12 + next() * 70] as const);
    return [
      ...points
        .slice(1)
        .map(([x, y], index) => (
          <Line
            key={`l${String(index)}`}
            x1={points[index]![0]}
            y1={points[index]![1]}
            x2={x}
            y2={y}
            stroke={colour}
            strokeWidth={0.9}
          />
        )),
      ...points.map(([x, y], index) => <Circle key={`s${String(index)}`} cx={x} cy={y} r={2.2} fill={colour} />),
    ];
  },
  'chalk-lines': (_next, colour) => [
    <Rect key="pitch" x={170} y={14} width={140} height={84} fill="none" stroke={colour} strokeWidth={1} />,
    <Line key="half" x1={240} y1={14} x2={240} y2={98} stroke={colour} strokeWidth={1} />,
    <Circle key="centre" cx={240} cy={56} r={16} fill="none" stroke={colour} strokeWidth={1} />,
    <Path
      key="move"
      d="M190 80 C205 50 220 40 232 30"
      fill="none"
      stroke={colour}
      strokeWidth={1.2}
      strokeDasharray="4 4"
    />,
    <Path key="x1" d="M276 36 l8 8 m0 -8 l-8 8" stroke={colour} strokeWidth={1.2} />,
    <Path key="x2" d="M200 36 l8 8 m0 -8 l-8 8" stroke={colour} strokeWidth={1.2} />,
  ],
  circuit: (next, colour) =>
    Array.from({ length: 6 }, (_, index) => {
      const y = 12 + index * 17 + next() * 5;
      const x = 150 + next() * 60;
      const bend = x + 30 + next() * 60;
      return (
        <Path
          key={index}
          d={`M${String(x)} ${String(y)} H${String(bend)} v${next() > 0.5 ? '9' : '-9'} H${String(bend + 30)}`}
          fill="none"
          stroke={colour}
          strokeWidth={1}
        />
      );
    }),
  waves: (_next, colour) =>
    Array.from({ length: 4 }, (_, index) => (
      <Path
        key={index}
        d={`M0 ${String(30 + index * 18)} Q40 ${String(14 + index * 18)} 80 ${String(30 + index * 18)} T160 ${String(30 + index * 18)} T240 ${String(30 + index * 18)} T320 ${String(30 + index * 18)}`}
        fill="none"
        stroke={colour}
        strokeWidth={1.1}
      />
    )),
  grid: (_next, colour) => [
    ...Array.from({ length: 9 }, (_, index) => (
      <Line
        key={`v${String(index)}`}
        x1={index * 40}
        y1={0}
        x2={index * 40}
        y2={HEIGHT}
        stroke={colour}
        strokeWidth={0.8}
      />
    )),
    ...Array.from({ length: 4 }, (_, index) => (
      <Line
        key={`h${String(index)}`}
        x1={0}
        y1={index * 32}
        x2={WIDTH}
        y2={index * 32}
        stroke={colour}
        strokeWidth={0.8}
      />
    )),
  ],
  rings: (_next, colour) =>
    Array.from({ length: 5 }, (_, index) => (
      <Circle key={index} cx={262} cy={56} r={14 + index * 14} fill="none" stroke={colour} strokeWidth={1} />
    )),
  rays: (_next, colour) =>
    Array.from({ length: 9 }, (_, index) => {
      const angle = Math.PI * (0.6 + index * 0.1);
      return (
        <Line
          key={index}
          x1={280}
          y1={118}
          x2={280 + 220 * Math.cos(angle)}
          y2={118 - 220 * Math.sin(angle) * 0.9}
          stroke={colour}
          strokeWidth={1}
        />
      );
    }),
};

export function Motif({ kit }: { readonly kit: Pick<RoomKit, 'motif' | 'palette' | 'emblem'> }) {
  const colour = ROOM_SWATCHES[kit.palette.accent];
  const next = numbersFrom(`${kit.motif}|${kit.emblem.glyph}|${kit.palette.ground}|${kit.palette.accent}`);
  return (
    <Svg
      width="100%"
      height="100%"
      viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
      preserveAspectRatio="xMaxYMid slice"
      aria-hidden
      accessibilityElementsHidden
    >
      {drawings[kit.motif](next, colour)}
    </Svg>
  );
}
