import { seedState } from '../seed.js';
import type { Point } from '../types.js';
import type { Chart } from './chart.js';
import type { Loop } from './contours.js';
import type { World } from './types.js';

/** The most landmarks drawn on one planet; more are counted in its list, not painted. */
export const MAX_LANDMARK_SPOTS = 12;

const STEP = 12;
/** A name's room: about 108 across and 24 high around its place, so a marker never covers a name. */
const NAME_HALF_WIDTH = 56;
const NAME_HALF_HEIGHT = 16;
/** Markers are about 16 units across and 26 high; keep their feet this far apart. */
const SPACING = 30;

/** A loop with its bounding box, so a place far from it is ruled out without walking its outline. */
interface BoxedLoop {
  readonly loop: Loop;
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

function boxed(loops: readonly Loop[]): readonly BoxedLoop[] {
  return loops.map((loop) => {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let at = 0; at < loop.length; at += 2) {
      const x = loop[at] ?? 0;
      const y = loop[at + 1] ?? 0;
      minX = x < minX ? x : minX;
      maxX = x > maxX ? x : maxX;
      minY = y < minY ? y : minY;
      maxY = y > maxY ? y : maxY;
    }
    return { loop, minX, maxX, minY, maxY };
  });
}

function inside(shape: BoxedLoop, x: number, y: number): boolean {
  if (x < shape.minX || x > shape.maxX || y < shape.minY || y > shape.maxY) return false;
  const { loop } = shape;
  let within = false;
  for (let at = 0, last = loop.length - 2; at < loop.length; last = at, at += 2) {
    const ax = loop[at] ?? 0;
    const ay = loop[at + 1] ?? 0;
    const bx = loop[last] ?? 0;
    const by = loop[last + 1] ?? 0;
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) within = !within;
  }
  return within;
}

/** Even-odd across the loops of one shape: a loop inside another is a hole. */
const onLand = (shapes: readonly BoxedLoop[], x: number, y: number): boolean => {
  let count = 0;
  for (const shape of shapes) if (inside(shape, x, y)) count++;
  return count % 2 === 1;
};

/** A fixed 32-bit rank for one place on one planet: integer mixing only, so it is the same on every engine. */
function rankOf(state: number, x: number, y: number): number {
  let mixed = (state ^ Math.imul(x, 0x85ebca6b) ^ Math.imul(y, 0xc2b2ae35)) >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x2c1b3c6d);
  mixed = Math.imul(mixed ^ (mixed >>> 12), 0x297a2d39);
  return (mixed ^ (mixed >>> 15)) >>> 0;
}

interface Candidate {
  readonly at: Point;
  /** 0 on land that has formed, 1 on any other land. */
  readonly tier: number;
  readonly rank: number;
}

/**
 * Where a planet's landmarks stand (D-089): on land that has formed first, and on any land when that
 * has no room, clear of every region's name and of each other. A place's rank is a fixed hash of the
 * planet's seed, its variant and the place itself, so the planet alone decides it: the first `n`
 * spots of a longer list are the same as a list of `n`, a landmark never moves when another is
 * earned, and a region forming only moves a landmark whose place it outranks. The world is drawn from
 * the planet alone (D-108); which landmarks exist and their gold or plain finish change neither it
 * nor these places.
 *
 * Pure and bounded (at most a few thousand places); it uses only the integer-safe arithmetic that the
 * world generator pins.
 */
export function landmarkSpots(
  seed: string,
  variant: number,
  world: World,
  chart: Chart,
  count: number,
): readonly Point[] {
  const wanted = Math.min(Math.max(Math.floor(count), 0), MAX_LANDMARK_SPOTS);
  if (wanted === 0) return [];
  const formed = chart.charted.map((cell) => boxed(cell.loops));
  const land = boxed(world.land);
  const names = chart.charted.map((cell) => cell.label);
  const state = seedState(`${seed}|landmarks|${String(variant)}`);
  const candidates: Candidate[] = [];
  for (let y = STEP; y < world.height; y += STEP)
    for (let x = STEP; x < world.width; x += STEP) {
      const cleared = names.every(
        (name) => Math.abs(name.x - x) >= NAME_HALF_WIDTH || Math.abs(name.y - y) >= NAME_HALF_HEIGHT,
      );
      if (!cleared) continue;
      if (formed.some((loops) => onLand(loops, x, y)))
        candidates.push({ at: { x, y }, tier: 0, rank: rankOf(state, x, y) });
      else if (onLand(land, x, y)) candidates.push({ at: { x, y }, tier: 1, rank: rankOf(state, x, y) });
    }
  candidates.sort((a, b) => a.tier - b.tier || a.rank - b.rank || a.at.y - b.at.y || a.at.x - b.at.x);
  const spots: Point[] = [];
  for (const candidate of candidates) {
    if (spots.length === wanted) break;
    const apart = spots.every((spot) => {
      const across = spot.x - candidate.at.x;
      const down = spot.y - candidate.at.y;
      return across * across + down * down >= SPACING * SPACING;
    });
    if (apart) spots.push(candidate.at);
  }
  return spots;
}
