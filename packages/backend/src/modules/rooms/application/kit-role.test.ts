import { describe, expect, it } from 'vitest';
import { ROOM_EMBLEM_GLYPHS } from '@knowscroll/contracts';
import { GLYPH_MEANINGS, KIT_ROLE_VERSION, kitRole } from './kit-role.js';

describe('the instructions of the kit role', () => {
  const { instructions } = kitRole();

  it('is the second version of the role', () => {
    expect(KIT_ROLE_VERSION).toBe('station-kit.2');
    expect(kitRole().version).toBe('station-kit.2');
  });

  it('gives every glyph of the vocabulary a meaning, and says it in the instructions', () => {
    const missing = ROOM_EMBLEM_GLYPHS.filter(
      (glyph) =>
        (GLYPH_MEANINGS[glyph] ?? '').trim().length < 8 ||
        !instructions.includes(`${glyph} (${GLYPH_MEANINGS[glyph]})`),
    );
    expect(missing).toEqual([]);
    expect(Object.keys(GLYPH_MEANINGS).sort()).toEqual([...ROOM_EMBLEM_GLYPHS].sort());
  });

  it('keeps the pitch for sport and gives Earth and the body their own glyphs', () => {
    expect(GLYPH_MEANINGS['centre-circle']).toContain('sport only');
    expect(GLYPH_MEANINGS.globe).toContain('Earth');
    expect(GLYPH_MEANINGS.cell).toContain('human body');
    expect(GLYPH_MEANINGS['ringed-planet']).toContain('space');
    expect(GLYPH_MEANINGS.book).toContain('history');
  });

  it('asks for different glyphs for different topics when another fits', () => {
    expect(instructions).toContain('should not share a glyph when another one fits better');
  });

  it('still lets code, not the model, decide what is valid', () => {
    const schema = kitRole().outputSchema;
    const answer = {
      palette: { ground: 'midnight', accent: 'sun', ink: 'cream' },
      emblem: { frame: 'circle', glyph: 'globe' },
      motif: 'rings',
      motion: 'pan',
      cast: { explainer: 'cell', skeptic: 'book' },
    };
    expect(schema.safeParse(answer).success).toBe(true);
    expect(schema.safeParse({ ...answer, emblem: { frame: 'circle', glyph: 'earth' } }).success).toBe(false);
  });
});
