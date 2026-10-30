import { memo, useId } from 'react';
import { Circle, ClipPath, Defs, Ellipse, G, LinearGradient, Path, RadialGradient, Rect, Stop } from 'react-native-svg';
import type { Chart, MapWorld, SeaMark } from '@knowscroll/scene-core';
import type { PlanetPalette } from './planet-palette';
import { loopsToPath, puffsToPath } from './svg-paths';

const unique = (raw: string) => raw.replaceAll(/[^a-zA-Z0-9]/g, '');

/** What the sea is marked with, by planet type: ripples, floes, lava bubbles, craters. Decoration from the seed. */
function SeaMarks({ marks, palette }: { marks: readonly SeaMark[]; palette: PlanetPalette }) {
  const turned = (mark: SeaMark) => {
    const radians = (mark.turn * Math.PI) / 180;
    return { cos: Math.cos(radians), sin: Math.sin(radians) };
  };
  if (palette.detail === 'waves' || palette.detail === 'lava') {
    const stroke = palette.detail === 'waves' ? 'rgba(225,246,255,.3)' : 'rgba(255,138,61,.5)';
    const d = marks
      .map((mark) => {
        const { cos, sin } = turned(mark);
        const k = mark.size;
        const at = (dx: number, dy: number) =>
          `${(mark.x + dx * cos - dy * sin).toFixed(1)} ${(mark.y + dx * sin + dy * cos).toFixed(1)}`;
        return `M${at(0, 0)}Q${at(k / 2, -k * 0.55)} ${at(k, 0)}T${at(k * 2, 0)}`;
      })
      .join('');
    return <Path d={d} fill="none" stroke={stroke} strokeWidth={2.2} strokeLinecap="round" />;
  }
  if (palette.detail === 'floes')
    return (
      <>
        {marks.map((mark, index) => (
          <Ellipse
            key={index}
            cx={mark.x}
            cy={mark.y}
            rx={mark.size * 0.9}
            ry={mark.size * 0.55}
            fill="#eef8ff"
            opacity={0.85}
            rotation={mark.turn}
            origin={`${mark.x}, ${mark.y}`}
          />
        ))}
      </>
    );
  if (palette.detail === 'craters')
    return (
      <>
        {marks.map((mark, index) => (
          <Circle key={index} cx={mark.x} cy={mark.y} r={mark.size * 0.9} fill="rgba(30,20,44,.28)" />
        ))}
      </>
    );
  return null;
}

/** Soft horizontal bands for a gas giant's "sea". */
function BandsGround({ palette, id }: { palette: PlanetPalette; id: string }) {
  const bands = palette.bands ?? palette.sea;
  return (
    <>
      <Defs>
        <LinearGradient id={`${id}sky`} x1="0" y1="0" x2="0" y2="1">
          {bands.map((colour, index) => (
            <Stop key={index} offset={index / Math.max(1, bands.length - 1)} stopColor={colour} />
          ))}
        </LinearGradient>
      </Defs>
      <Rect x={-400} y={-400} width={1200} height={1700} fill={`url(#${id}sky)`} />
      {Array.from({ length: 22 }, (_, row) => {
        const y = -200 + row * 60;
        let d = `M-400 ${y}`;
        for (let step = 0; step < 14; step++)
          d += `Q${-400 + step * 120 + 60} ${y + (step % 2 ? 14 : -14)} ${-400 + step * 120 + 120} ${y}`;
        return <Path key={row} d={`${d}V${y + 34}H-400Z`} fill={bands[row % bands.length]} opacity={0.7} />;
      })}
    </>
  );
}

export interface MapLandProps {
  readonly world: MapWorld;
  readonly chart: Chart;
  readonly palette: PlanetPalette;
  /** A tap on a formed region's land. */
  readonly onChoose: (objectId: string) => void;
}

/**
 * The land of the landed map in map units: sea, shallows, every formed region in colour with its
 * dashed border, and the land not reached yet in flat grey. It has no text and is hidden from
 * assistive technology: formed regions are named by the targets laid over it, and the grey is
 * outlines only (D-109). Memoised, because only the camera moves while a person browses.
 */
export const MapLand = memo(function MapLand({ world, chart, palette, onChoose }: MapLandProps) {
  const id = unique(useId());
  const charted = chart.charted;
  const chartedLoops = charted.flatMap((cell) => cell.loops);
  const chartedPath = loopsToPath(chartedLoops);
  const unreachedPath = loopsToPath(chart.unreached.flatMap((land) => land.loops));
  const [face, edge, line] = palette.grey;
  return (
    <>
      <Defs>
        <RadialGradient id={`${id}sea`} gradientUnits="userSpaceOnUse" cx={195} cy={380} r={640}>
          <Stop offset={0} stopColor={palette.sea[1]} />
          <Stop offset={0.45} stopColor={palette.sea[2]} />
          <Stop offset={1} stopColor={palette.sea[3]} />
        </RadialGradient>
        <ClipPath id={`${id}charted`}>
          <Path d={chartedPath} clipRule="evenodd" />
        </ClipPath>
      </Defs>
      {palette.detail === 'bands' ? (
        <BandsGround palette={palette} id={id} />
      ) : (
        <>
          <Rect x={-400} y={-400} width={1200} height={1700} fill={`url(#${id}sea)`} />
          <SeaMarks marks={world.marks} palette={palette} />
        </>
      )}
      <Path d={loopsToPath(world.shallowWide)} fill={palette.shallow} opacity={0.3} fillRule="evenodd" />
      <Path d={loopsToPath(world.shallow)} fill={palette.foam} opacity={0.28} fillRule="evenodd" />
      <Path
        d={loopsToPath(world.land)}
        fill={palette.shadow}
        opacity={0.2}
        fillRule="evenodd"
        transform="translate(0 9)"
      />
      <Path
        d={loopsToPath(world.land)}
        fill={palette.shadow}
        opacity={0.25}
        fillRule="evenodd"
        transform="translate(0 5)"
      />
      {palette.glowCoast ? <Path d={chartedPath} fill="none" stroke="#ffb03a" strokeWidth={8} opacity={0.7} /> : null}
      <Path d={chartedPath} fill="none" stroke={palette.foam} strokeWidth={4} strokeLinejoin="round" opacity={0.85} />
      {charted.map((cell) => (
        <Path
          key={cell.objectId}
          d={loopsToPath(cell.loops)}
          fill={palette.land[cell.site % 4]}
          fillRule="evenodd"
          onPress={() => onChoose(cell.objectId)}
        />
      ))}
      <G clipPath={`url(#${id}charted)`}>
        <Path d={loopsToPath(world.lowland)} fill={palette.lowland} opacity={0.5} fillRule="evenodd" />
        <Path d={loopsToPath(world.highland)} fill={palette.highland} opacity={0.55} fillRule="evenodd" />
      </G>
      {charted.map((cell) => (
        <Path
          key={`border-${cell.objectId}`}
          d={loopsToPath(cell.loops)}
          fill="none"
          stroke={palette.ink}
          strokeOpacity={0.5}
          strokeWidth={1.2}
          strokeDasharray="4 4"
        />
      ))}
      <Path
        d={chartedPath}
        fill="none"
        stroke={palette.ink}
        strokeOpacity={0.75}
        strokeWidth={1.6}
        strokeLinejoin="round"
      />
      {unreachedPath ? (
        <>
          <Path d={unreachedPath} fill={edge} fillRule="evenodd" transform="translate(0 4)" />
          <Path d={unreachedPath} fill={face} fillRule="evenodd" />
          <Path
            d={unreachedPath}
            fill="none"
            stroke={line}
            strokeOpacity={0.6}
            strokeWidth={1.4}
            strokeLinejoin="round"
          />
        </>
      ) : null}
    </>
  );
});

/**
 * The cloud over the map: a veil over each piece of land not reached yet, and a frame of cumulus at
 * the edge. Drawn above the dimming of a chosen region, as in the design. Decoration, from the seed.
 */
export const MapClouds = memo(function MapClouds({
  world,
  chart,
  palette,
}: {
  world: MapWorld;
  chart: Chart;
  palette: PlanetPalette;
}) {
  const id = unique(useId());
  const veils = chart.unreached.flatMap((land) => (land.veil ? [land.veil] : []));
  return (
    <>
      <Defs>
        <RadialGradient id={`${id}veil`} cx="50%" cy="50%" r="50%">
          <Stop offset={0} stopColor="#ffffff" stopOpacity={0.42} />
          <Stop offset={0.62} stopColor="#eef6fb" stopOpacity={0.26} />
          <Stop offset={1} stopColor="#e2eef8" stopOpacity={0} />
        </RadialGradient>
      </Defs>
      {veils.map((veil, index) => (
        <G key={index}>
          <Ellipse cx={veil.at.x} cy={veil.at.y} rx={veil.rx} ry={veil.ry} fill={`url(#${id}veil)`} />
          <Path d={puffsToPath(veil.puffs)} fill={palette.cloud[1]} transform="translate(0 4)" />
          <Path d={puffsToPath(veil.puffs)} fill={palette.cloud[0]} />
        </G>
      ))}
      <Path d={puffsToPath(world.frame)} fill={palette.cloud[1]} transform="translate(0 5)" />
      <Path d={puffsToPath(world.frame)} fill={palette.cloud[0]} />
    </>
  );
});
