import { View } from 'react-native';
import Svg, { Circle, Ellipse, Path, Polygon, Rect } from 'react-native-svg';
import { content, iconStroke } from '@knowscroll/design-tokens';
import { iconShapes, type IconName, type IconShape } from './icon-paths';

export interface IconProps {
  readonly name: IconName;
  /** Rendered size in logical px (22 nav and icon buttons, 20 strips, 18 chips, 14 segment, 12 tags). */
  readonly size?: number;
  readonly color?: string;
  /** Paint stroked shapes as filled (the pressed Like and Save glyphs). */
  readonly filled?: boolean;
  /** Override the export's stroke width for this size. */
  readonly strokeWidth?: number;
}

function Shape({ shape, color, filled }: { shape: IconShape; color: string; filled: boolean }) {
  // Solid shapes (play, the ⋯ dots) are painted without an outline; pressed glyphs keep theirs.
  const solid = 'filled' in shape && shape.filled === true;
  const paint = solid ? { fill: color, stroke: 'none' } : filled ? { fill: color } : { fill: 'none' };
  switch (shape.kind) {
    case 'path':
      return <Path d={shape.d} {...paint} />;
    case 'circle':
      return <Circle cx={shape.cx} cy={shape.cy} r={shape.r} {...paint} />;
    case 'rect':
      return <Rect x={shape.x} y={shape.y} width={shape.width} height={shape.height} rx={shape.rx} {...paint} />;
    case 'ellipse':
      return (
        <Ellipse
          cx={shape.cx}
          cy={shape.cy}
          rx={shape.rx}
          ry={shape.ry}
          rotation={shape.rotate}
          origin={`${shape.cx}, ${shape.cy}`}
          {...paint}
        />
      );
    case 'polygon':
      return <Polygon points={shape.points} {...paint} />;
  }
}

/**
 * A decorative line icon. Icons are always hidden from assistive technology: the control that
 * holds one carries the accessible name.
 */
export function Icon({ name, size = 22, color = content.ink, filled = false, strokeWidth }: IconProps) {
  const shapes: readonly IconShape[] = iconShapes[name];
  return (
    <View
      accessible={false}
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={{ width: size, height: size }}
    >
      <Svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        stroke={color}
        strokeWidth={strokeWidth ?? iconStroke(size)}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {shapes.map((shape, index) => (
          <Shape key={index} shape={shape} color={color} filled={filled} />
        ))}
      </Svg>
    </View>
  );
}
