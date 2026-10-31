import { describe, expect, it } from 'vitest';
import {
  ROOM_EMBLEM_FRAMES,
  ROOM_EMBLEM_GLYPHS,
  ROOM_KIT_VERSION,
  ROOM_MOTIFS,
  ROOM_MOTIONS,
  ROOM_SWATCHES,
  ROOM_SWATCH_NAMES,
  RoomKitSchema,
  type RoomKitDraft,
} from '@knowscroll/contracts';
import {
  ACCENT_CONTRAST_MIN,
  DEFAULT_GLYPHS,
  INK_CONTRAST_MIN,
  contrastRatio,
  defaultKit,
  kitAnswerSchema,
  kitIsValid,
  kitOfDraft,
  kitProblem,
  kitToShow,
} from './kit.js';

const draft = (overrides: Partial<RoomKitDraft['palette']> = {}): RoomKitDraft => ({
  palette: { ground: 'midnight', accent: 'sun', ink: 'cream', ...overrides },
  emblem: { frame: 'circle', glyph: 'ringed-planet' },
  motif: 'constellation',
  motion: 'twinkle',
  cast: { explainer: 'star', skeptic: 'hourglass' },
});

const ids = Array.from({ length: 400 }, (_, index) => {
  const hex = index.toString(16).padStart(4, '0');
  return `0192f0a0-${hex}-7000-8000-00000000${hex}`;
});

describe('the closed vocabulary', () => {
  it('has a colour for exactly the swatch names the schema accepts', () => {
    expect([...ROOM_SWATCH_NAMES].sort()).toEqual(Object.keys(ROOM_SWATCHES).sort());
  });
});

describe('contrast', () => {
  it('is the WCAG ratio: near black on cream is high, a colour on itself is 1', () => {
    expect(contrastRatio('soot', 'cream')).toBeGreaterThan(17);
    expect(contrastRatio('cream', 'cream')).toBe(1);
    expect(contrastRatio('soot', 'cream')).toBeCloseTo(contrastRatio('cream', 'soot'), 10);
  });

  it('accepts a palette that reads and says why it refuses one that does not', () => {
    expect(kitProblem(draft())).toBeUndefined();
    expect(kitProblem(draft({ ink: 'forest' }))).toBe('ink_contrast');
    expect(kitProblem(draft({ accent: 'plum' }))).toBe('accent_contrast');
    expect(kitProblem(draft({ ink: 'midnight' }))).toBe('same_swatch');
    expect(kitProblem(draft({ accent: 'midnight' }))).toBe('same_swatch');
  });

  it('is judged on the fixed colour of the swatch, so a model cannot pass it with a word', () => {
    expect(kitProblem(draft({ ground: 'cream', ink: 'paper' }))).toBe('ink_contrast');
    expect(kitProblem(draft({ ground: 'mist', ink: 'soot', accent: 'coral' }))).toBeUndefined();
  });
});

describe('what a model may answer', () => {
  const schema = kitAnswerSchema();

  it('takes the closed vocabulary with a palette that reads', () => {
    expect(schema.safeParse(draft()).success).toBe(true);
  });

  it.each([
    ['a colour code', { palette: { ground: '#000000', accent: 'sun', ink: 'cream' } }],
    ['an unknown swatch', { palette: { ground: 'midnight', accent: 'pink', ink: 'cream' } }],
    ['an unknown frame', { emblem: { frame: 'blob', glyph: 'star' } }],
    ['markup as a glyph', { emblem: { frame: 'circle', glyph: '<svg onload=alert(1)>' } }],
    ['an unknown motif', { motif: 'fireworks' }],
    ['an unknown motion', { motion: 'spin' }],
    ['a skin that is not a glyph', { cast: { explainer: 'a person', skeptic: 'star' } }],
    ['markup in a field', { motion: '<script>' }],
    ['an extra field', { backdropPrompt: 'a night sky' }],
  ])('refuses %s', (_name, patch) => {
    expect(schema.safeParse({ ...draft(), ...patch }).success).toBe(false);
  });

  it('refuses two residents that wear the same mark, with a fixed code', () => {
    const result = schema.safeParse({ ...draft(), cast: { explainer: 'gear', skeptic: 'gear' } });
    expect(result.success).toBe(false);
    if (!result.success) {
      const [issue] = result.error.issues;
      expect(issue?.path).toEqual(['cast']);
      expect((issue as { params?: { safeCode?: string } }).params?.safeCode).toBe('same_skin');
    }
  });

  it('refuses low contrast with a fixed code, never with anything the model wrote', () => {
    const result = schema.safeParse(draft({ ink: 'forest' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      const [issue] = result.error.issues;
      expect(issue?.code).toBe('custom');
      expect((issue as { params?: { safeCode?: string } }).params?.safeCode).toBe('ink_contrast');
    }
  });
});

describe('the default kit every room has', () => {
  it('is the same every time for the same ID, and differs between rooms', () => {
    expect(defaultKit(ids[0]!)).toEqual(defaultKit(ids[0]!));
    const distinct = new Set(ids.map((id) => JSON.stringify(defaultKit(id))));
    expect(distinct.size).toBeGreaterThan(100);
  });

  it('passes the same rules as a proposed kit, for every ID tried', () => {
    for (const id of ids) {
      const kit = defaultKit(id);
      expect(RoomKitSchema.safeParse(kit).success, id).toBe(true);
      expect(kitProblem(kit), id).toBeUndefined();
      expect(contrastRatio(kit.palette.ground, kit.palette.ink)).toBeGreaterThanOrEqual(INK_CONTRAST_MIN);
      expect(contrastRatio(kit.palette.ground, kit.palette.accent)).toBeGreaterThanOrEqual(ACCENT_CONTRAST_MIN);
      expect(kit.cast.explainer).not.toBe(kit.cast.skeptic);
    }
  });

  it('uses the whole vocabulary across rooms', () => {
    const kits = ids.map(defaultKit);
    expect(new Set(kits.map((kit) => kit.emblem.frame))).toEqual(new Set(ROOM_EMBLEM_FRAMES));
    expect(new Set(kits.map((kit) => kit.emblem.glyph))).toEqual(new Set(DEFAULT_GLYPHS));
    expect(new Set(kits.map((kit) => kit.motif))).toEqual(new Set(ROOM_MOTIFS));
    expect(new Set(kits.map((kit) => kit.motion))).toEqual(new Set(ROOM_MOTIONS));
  });
});

describe('the default as the vocabulary grows', () => {
  it('never wears a glyph added after the first release, so a room without a kit keeps its look', () => {
    expect(DEFAULT_GLYPHS).toHaveLength(14);
    expect(ROOM_EMBLEM_GLYPHS.slice(0, 14)).toEqual(DEFAULT_GLYPHS);
    expect(ROOM_EMBLEM_GLYPHS).toContain('globe');
    expect(ROOM_EMBLEM_GLYPHS).toContain('cell');
    for (const id of ids) {
      const kit = defaultKit(id);
      expect([kit.emblem.glyph, kit.cast.explainer, kit.cast.skeptic]).not.toContain('globe');
      expect([kit.emblem.glyph, kit.cast.explainer, kit.cast.skeptic]).not.toContain('cell');
    }
  });

  it('keeps a stored kit that names a glyph of the first release valid', () => {
    const stored = kitOfDraft({ ...draft(), emblem: { frame: 'circle', glyph: 'centre-circle' } });
    expect(kitIsValid(stored)).toBe(true);
    expect(kitIsValid(kitOfDraft({ ...draft(), emblem: { frame: 'circle', glyph: 'globe' } }))).toBe(true);
    expect(kitIsValid(kitOfDraft({ ...draft(), emblem: { frame: 'circle', glyph: 'cell' } }))).toBe(true);
  });
});

describe('the kit to show', () => {
  const room = ids[7]!;

  it('is the stored approved kit while it validates', () => {
    const stored = kitOfDraft(draft());
    expect(kitToShow(stored, room)).toEqual(stored);
    expect(kitIsValid(stored)).toBe(true);
  });

  it.each([
    ['nothing approved', null],
    ['a vocabulary word that no longer exists', { ...kitOfDraft(draft()), motion: 'spin' }],
    ['another version', { ...kitOfDraft(draft()), version: 'station-kit.v0' }],
    [
      'a palette that does not read',
      { ...kitOfDraft(draft()), palette: { ground: 'midnight', accent: 'sun', ink: 'plum' } },
    ],
    ['two residents wearing the same mark', { ...kitOfDraft(draft()), cast: { explainer: 'star', skeptic: 'star' } }],
    ['not an object', 'station-kit.v1'],
    ['extra markup', { ...kitOfDraft(draft()), html: '<b>hi</b>' }],
  ])('falls back to the default for %s', (_name, stored) => {
    expect(kitToShow(stored, room)).toEqual(defaultKit(room));
    expect(kitIsValid(stored)).toBe(false);
  });

  it('carries the version a stored kit is read under', () => {
    expect(kitOfDraft(draft()).version).toBe(ROOM_KIT_VERSION);
  });
});
