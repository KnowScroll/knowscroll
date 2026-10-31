import type { RoomEmblemFrame, RoomEmblemGlyph } from '@knowscroll/contracts';

/**
 * The drawings of a room's emblem (v3 R-4, D-170): every frame and glyph the closed vocabulary names, as plain filled
 * outlines on a 24 by 24 grid. One description serves both places an emblem is drawn: SVG on screens, and pixels for the
 * station on the 3D map. Nothing here comes from a server: the kit names a word, and this file owns what the word looks like.
 */

export type Point = readonly [number, number];
/**
 * A filled shape of one or more outlines, filled by the non-zero rule: an outline that winds the other way cuts a hole.
 * `mark` is drawn in the room's accent, `cut` in its ground, so a glyph can carve a gap in itself.
 */
export interface Shape {
  readonly role: 'mark' | 'cut';
  readonly contours: readonly (readonly Point[])[];
}

/** The centre of the grid, which every frame and glyph is drawn around. */
export const CENTRE = 12;
/** How far the frame's inner face is drawn in from its edge, so a border shows. */
export const BORDER_INSET = 0.86;

const area = (points: readonly Point[]): number => {
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const [x1, y1] = points[index]!;
    const [x2, y2] = points[(index + 1) % points.length]!;
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
};
/** The outline wound so its signed area is positive (a body) or negative (a hole). */
const wound = (points: readonly Point[], positive: boolean): Point[] =>
  area(points) > 0 === positive ? [...points] : [...points].reverse();

function circle(cx: number, cy: number, radius: number, steps = 40): Point[] {
  return Array.from({ length: steps }, (_, step) => {
    const angle = (step / steps) * Math.PI * 2;
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)] as Point;
  });
}

function ellipse(cx: number, cy: number, rx: number, ry: number, tilt: number, steps = 40): Point[] {
  return Array.from({ length: steps }, (_, step) => {
    const angle = (step / steps) * Math.PI * 2;
    const x = rx * Math.cos(angle);
    const y = ry * Math.sin(angle);
    return [cx + x * Math.cos(tilt) - y * Math.sin(tilt), cy + x * Math.sin(tilt) + y * Math.cos(tilt)] as Point;
  });
}

const ngon = (cx: number, cy: number, radius: number, sides: number, start: number): Point[] =>
  Array.from({ length: sides }, (_, step) => {
    const angle = start + (step / sides) * Math.PI * 2;
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)] as Point;
  });

const quad = (from: Point, control: Point, to: Point, steps = 6): Point[] =>
  Array.from({ length: steps }, (_, step) => {
    const t = step / steps;
    const u = 1 - t;
    return [
      u * u * from[0] + 2 * u * t * control[0] + t * t * to[0],
      u * u * from[1] + 2 * u * t * control[1] + t * t * to[1],
    ] as Point;
  });

const body = (...contours: Point[][]): Shape['contours'] => contours.map((points) => wound(points, true));

function bar(x1: number, y1: number, x2: number, y2: number, width: number): Point[] {
  const length = Math.hypot(x2 - x1, y2 - y1) || 1;
  const nx = (-(y2 - y1) / length) * (width / 2);
  const ny = ((x2 - x1) / length) * (width / 2);
  return [
    [x1 + nx, y1 + ny],
    [x2 + nx, y2 + ny],
    [x2 - nx, y2 - ny],
    [x1 - nx, y1 - ny],
  ];
}

/** A line of the given width through the points, with a round join at every bend. */
function stroke(points: readonly Point[], width: number): Shape['contours'] {
  const contours: Point[][] = [];
  for (let index = 0; index + 1 < points.length; index += 1) {
    const [x1, y1] = points[index]!;
    const [x2, y2] = points[index + 1]!;
    contours.push(bar(x1, y1, x2, y2, width));
  }
  for (const [x, y] of points) contours.push(circle(x, y, width / 2, 10));
  return body(...contours);
}

const ringOf = (cx: number, cy: number, radius: number, width: number): Shape['contours'] => [
  wound(circle(cx, cy, radius + width / 2), true),
  wound(circle(cx, cy, radius - width / 2), false),
];

const ellipseRingOf = (rx: number, ry: number, tilt: number, width: number): Shape['contours'] => [
  wound(ellipse(CENTRE, CENTRE, rx + width / 2, ry + width / 2, tilt), true),
  wound(ellipse(CENTRE, CENTRE, rx - width / 2, ry - width / 2, tilt), false),
];

const starOf = (cx: number, cy: number, outer: number, inner: number, points: number): Point[] =>
  Array.from({ length: points * 2 }, (_, step) => {
    const angle = -Math.PI / 2 + (step / (points * 2)) * Math.PI * 2;
    const radius = step % 2 === 0 ? outer : inner;
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)] as Point;
  });

const mark = (...contours: Point[][]): Shape => ({ role: 'mark', contours: body(...contours) });
const cut = (...contours: Point[][]): Shape => ({ role: 'cut', contours: body(...contours) });

/** A leaf: a pointed body along an axis, thickest in the middle. */
function leaf(): Point[] {
  const from: Point = [6.5, 17.5];
  const to: Point = [17.5, 6.5];
  const steps = 12;
  const side = (sign: number) =>
    Array.from({ length: steps + 1 }, (_, step) => {
      const t = step / steps;
      const half = 3.9 * Math.sin(Math.PI * t) ** 0.85;
      const cx = from[0] + (to[0] - from[0]) * t;
      const cy = from[1] + (to[1] - from[1]) * t;
      const nx = 0.7071 * sign;
      return [cx + nx * half, cy + nx * half] as Point;
    });
  return [...side(1), ...side(-1).reverse()];
}

function gear(): Point[] {
  const teeth = 8;
  const points: Point[] = [];
  for (let tooth = 0; tooth < teeth; tooth += 1) {
    const centre = (tooth / teeth) * Math.PI * 2;
    const half = Math.PI / teeth / 2;
    for (const [offset, radius] of [
      [-1, 5.4],
      [-0.55, 7.2],
      [0.55, 7.2],
      [1, 5.4],
    ] as const) {
      const angle = centre + offset * half;
      points.push([CENTRE + radius * Math.cos(angle), CENTRE + radius * Math.sin(angle)]);
    }
  }
  return points;
}

function spiral(): Point[] {
  return Array.from({ length: 34 }, (_, step) => {
    const angle = (step / 33) * Math.PI * 4.2;
    const radius = 0.8 + (angle / (Math.PI * 4.2)) * 6.4;
    return [CENTRE + radius * Math.cos(angle), CENTRE + radius * Math.sin(angle)] as Point;
  });
}

const wave = (offset: number): Point[] =>
  Array.from({ length: 14 }, (_, step) => {
    const x = 5.5 + (step / 13) * 13;
    return [x, CENTRE + offset + 1.7 * Math.sin((step / 13) * Math.PI * 2)] as Point;
  });

const flame = (cx: number, cy: number, scale: number): Point[] =>
  [
    ...quad([12, 18.5], [5.4, 15.2], [9.6, 9.2]),
    ...quad([9.6, 9.2], [11.6, 7.6], [12.4, 5]),
    ...quad([12.4, 5], [15.4, 8.8], [18.4, 14.6]),
    ...quad([18.4, 14.6], [17.6, 18], [12, 18.5]),
  ].map(([x, y]) => [cx + (x - 12) * scale, cy + (y - 12) * scale] as Point);

/** What each glyph of the vocabulary looks like. Complete by type: a word without a drawing does not compile. */
export const GLYPH_SHAPES: Readonly<Record<RoomEmblemGlyph, readonly Shape[]>> = {
  'ringed-planet': [
    { role: 'mark', contours: ellipseRingOf(7, 2.7, -0.45, 1.4) },
    cut(circle(CENTRE, CENTRE, 4.7)),
    mark(circle(CENTRE, CENTRE, 3.8)),
  ],
  star: [mark(starOf(CENTRE, 12.6, 6.8, 2.9, 5))],
  atom: [
    mark(circle(CENTRE, CENTRE, 1.9)),
    { role: 'mark', contours: ellipseRingOf(6.8, 2.6, 0, 1.1) },
    { role: 'mark', contours: ellipseRingOf(6.8, 2.6, Math.PI / 3, 1.1) },
    { role: 'mark', contours: ellipseRingOf(6.8, 2.6, (2 * Math.PI) / 3, 1.1) },
  ],
  leaf: [mark(leaf()), { role: 'cut', contours: body(bar(8.2, 15.8, 15, 9, 0.8)) }],
  wave: [-4.3, 0, 4.3].map((offset) => ({ role: 'mark' as const, contours: stroke(wave(offset), 1.5) })),
  flame: [mark(flame(CENTRE, CENTRE, 1)), cut(flame(CENTRE, 14.8, 0.42))],
  layers: [
    mark([
      [12, 5.5],
      [18.5, 9],
      [12, 12.5],
      [5.5, 9],
    ]),
    {
      role: 'mark',
      contours: stroke(
        [
          [5.5, 12.4],
          [12, 15.9],
          [18.5, 12.4],
        ],
        1.5,
      ),
    },
    {
      role: 'mark',
      contours: stroke(
        [
          [5.5, 15.8],
          [12, 19.3],
          [18.5, 15.8],
        ],
        1.5,
      ),
    },
  ],
  hourglass: [
    mark(bar(6.5, 5.6, 17.5, 5.6, 1.4), bar(6.5, 18.4, 17.5, 18.4, 1.4)),
    mark(
      [
        [7.6, 6.6],
        [16.4, 6.6],
        [12, 12],
      ],
      [
        [12, 12],
        [16.4, 17.4],
        [7.6, 17.4],
      ],
    ),
  ],
  pot: [
    mark(
      [
        [6.5, 11.4],
        [17.5, 11.4],
        [16.4, 18.4],
        [7.6, 18.4],
      ],
      bar(5.6, 10.4, 18.4, 10.4, 1.3),
      bar(4.6, 13, 6.6, 13, 1.2),
      bar(17.4, 13, 19.4, 13, 1.2),
    ),
    {
      role: 'mark',
      contours: stroke(
        [
          [9.2, 8.6],
          [10.2, 7.1],
          [9.2, 5.6],
        ],
        1,
      ),
    },
    {
      role: 'mark',
      contours: stroke(
        [
          [14.2, 8.6],
          [15.2, 7.1],
          [14.2, 5.6],
        ],
        1,
      ),
    },
  ],
  'centre-circle': [
    { role: 'mark', contours: ringOf(CENTRE, CENTRE, 5.2, 1.3) },
    mark(bar(12, 5.2, 12, 18.8, 1.3), circle(CENTRE, CENTRE, 1.5)),
  ],
  book: [
    mark(
      [
        [5.2, 7.4],
        [11.5, 9],
        [11.5, 18.4],
        [5.2, 16.8],
      ],
      [
        [18.8, 7.4],
        [12.5, 9],
        [12.5, 18.4],
        [18.8, 16.8],
      ],
    ),
  ],
  gear: [mark(gear()), cut(circle(CENTRE, CENTRE, 2.3))],
  mountain: [
    mark([
      [4.4, 18],
      [10, 7.6],
      [13.4, 13.2],
      [15.6, 10.4],
      [19.6, 18],
    ]),
    cut([
      [10, 7.6],
      [8.2, 11],
      [9.8, 10.2],
      [11.4, 11],
    ]),
  ],
  spiral: [{ role: 'mark', contours: stroke(spiral(), 1.4) }],
  // The Earth seen from space: a disc with flat continents cut out of it.
  globe: [
    mark(circle(CENTRE, CENTRE, 7.6)),
    cut(
      [
        [6.2, 9.4],
        [8.6, 7.2],
        [11.2, 7],
        [12.4, 8.6],
        [10.6, 10.4],
        [11.6, 12.8],
        [10.2, 15.6],
        [8.8, 16.6],
        [8.2, 13.4],
        [6.6, 11.8],
      ],
      [
        [14, 9.2],
        [16.2, 8],
        [18, 10.2],
        [17.2, 13],
        [15.2, 16.2],
        [14, 13.4],
      ],
    ),
  ],
  // A living cell: a round membrane, a nucleus with its nucleolus, and two organelles.
  cell: [
    { role: 'mark', contours: ringOf(CENTRE, CENTRE, 7, 1.4) },
    mark(circle(10.8, 11, 2.9), ellipse(15.4, 14.8, 1.7, 1, 0.6), circle(8.6, 15.2, 1.1), circle(15, 8.6, 0.9)),
    cut(circle(10.8, 11, 1)),
  ],
};

const roundedSquare = (): Point[] => {
  const radius = 6;
  const corner = (cx: number, cy: number, from: number) =>
    Array.from({ length: 8 }, (_, step) => {
      const angle = from + (step / 7) * (Math.PI / 2);
      return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)] as Point;
    });
  return [
    ...corner(22.5 - radius, 1.5 + radius, -Math.PI / 2),
    ...corner(22.5 - radius, 22.5 - radius, 0),
    ...corner(1.5 + radius, 22.5 - radius, Math.PI / 2),
    ...corner(1.5 + radius, 1.5 + radius, Math.PI),
  ];
};

/** The outline of each frame, on the same grid, centred and about 22 across. */
export const FRAME_OUTLINES: Readonly<Record<RoomEmblemFrame, readonly Point[]>> = {
  circle: wound(circle(CENTRE, CENTRE, 10.8, 48), true),
  shield: wound(
    [
      [12, 1.2],
      [21, 4.4],
      [21, 11.5],
      ...quad([21, 11.5], [20.4, 18], [12, 22.8], 8),
      ...quad([12, 22.8], [3.6, 18], [3, 11.5], 8),
      [3, 4.4],
    ],
    true,
  ),
  hexagon: wound(ngon(CENTRE, CENTRE, 11.2, 6, -Math.PI / 2), true),
  arch: wound(
    [
      [3.2, 22.4],
      [3.2, 11.6],
      ...Array.from({ length: 21 }, (_, step) => {
        const angle = Math.PI + (step / 20) * Math.PI;
        return [CENTRE + 8.8 * Math.cos(angle), 11.6 + 10.4 * Math.sin(angle)] as Point;
      }),
      [20.8, 22.4],
    ],
    true,
  ),
  'rounded-square': wound(roundedSquare(), true),
  diamond: wound(
    [
      [12, 0.8],
      [23.2, 12],
      [12, 23.2],
      [0.8, 12],
    ],
    true,
  ),
};

/** A frame's inner face: the outline drawn in about its centre, so the gap between them is the border. */
export const innerOutline = (outline: readonly Point[]): Point[] =>
  outline.map(([x, y]) => [CENTRE + (x - CENTRE) * BORDER_INSET, CENTRE + (y - CENTRE) * BORDER_INSET] as Point);

/** One outline as an SVG path (`M … L … Z`). */
export const pathOf = (contours: readonly (readonly Point[])[]): string =>
  contours.map((points) => `M${points.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join('L')}Z`).join('');
