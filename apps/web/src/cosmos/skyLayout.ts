/**
 * Where things sit in the reader's sky, as percentages of the sky container. Pure and
 * deterministic: the same stars in the same order always land in the same places, the first
 * (most developed) star takes the centre, and no two stars overlap at any count the Atlas returns.
 */
import type { StarCondition, StarView } from './starView.ts';

export interface SkySlot {
  left: number;
  top: number;
}

/** A star's drawn radius in CSS px: categorical by condition, never by a count. */
export const STAR_RADIUS: Record<StarCondition, number> = { quiet: 15, stirring: 19, tense: 20, luminous: 23 };

export function starSlots(count: number, portrait: boolean): SkySlot[] {
  if (count <= 0) return [];
  const slots: SkySlot[] = [{ left: 50, top: 50 }];
  const ring = (n: number, rx: number, ry: number, phase: number) => {
    for (let i = 0; i < n; i++) {
      const angle = phase + (i / n) * Math.PI * 2;
      slots.push({ left: 50 + Math.cos(angle) * rx, top: 50 + Math.sin(angle) * ry });
    }
  };
  const rest = count - 1;
  const inner = Math.min(rest, 6);
  const outer = rest - inner;
  // Portrait screens are tall: the ring is narrow and tall so labels stay inside the width.
  const [rx, ry] = portrait ? [30, 30] : [31, 33];
  ring(inner, rx, ry, inner === 1 ? -0.55 : -Math.PI / 2 + 0.35);
  if (outer > 0) ring(outer, portrait ? 40 : 43, portrait ? 41 : 44, -Math.PI / 2 + 0.85);
  return slots.slice(0, count).map(slot => ({ left: clamp(slot.left, 9, 91), top: clamp(slot.top, 8, 92) }));
}

/** Kept lights (saved Traces) gather in a loose arc low in the sky, small and quiet. */
export function keptSlots(count: number, hasStars: boolean): SkySlot[] {
  const slots: SkySlot[] = [];
  for (let i = 0; i < count; i++) {
    if (!hasStars) {
      // Around the gathering cloud, like material it has not yet drawn in.
      const angle = -Math.PI / 2 + (i / Math.max(count, 1)) * Math.PI * 2 + 0.4;
      const r = 17 + (i % 3) * 4;
      slots.push({ left: 50 + Math.cos(angle) * r * 1.05, top: 50 + Math.sin(angle) * r });
    } else {
      const t = count === 1 ? 0.5 : i / (count - 1);
      slots.push({ left: 14 + t * 72, top: 90 - Math.sin(t * Math.PI) * 5 - (i % 2) * 2 });
    }
  }
  return slots.map(slot => ({ left: clamp(slot.left, 6, 94), top: clamp(slot.top, 6, 95) }));
}

/** Worlds orbit their star in the system view: facets on the inner orbits, questions outside. */
export function worldOrbits(star: StarView): { id: string; orbit: number; angle: number }[] {
  return star.worlds.map((world, i) => ({
    id: world.id,
    orbit: world.kind === 'facet' ? 1.2 + Math.min(i, 2) * 0.3 : 1.95 + (i % 2) * 0.25,
    angle: -0.45 + i * 2.39996 + (world.kind === 'question' ? 0.9 : 0),
  }));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export type { StarView };
