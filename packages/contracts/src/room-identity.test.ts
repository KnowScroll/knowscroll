import { describe, expect, it } from 'vitest';
import {
  ROOM_EMBLEM_FRAMES,
  ROOM_EMBLEM_GLYPHS,
  ROOM_KIT_VERSION,
  ROOM_MOTIFS,
  ROOM_MOTIONS,
  ROOM_SWATCHES,
  ROOM_SWATCH_NAMES,
  RoomIdentitySchema,
  RoomKitSchema,
} from './room-identity.js';
import { RoomSummarySchema } from './rooms.js';

const kit = {
  version: ROOM_KIT_VERSION,
  palette: { ground: 'midnight', accent: 'sun', ink: 'cream' },
  emblem: { frame: 'circle', glyph: 'ringed-planet' },
  motif: 'constellation',
  motion: 'twinkle',
  cast: { explainer: 'star', skeptic: 'hourglass' },
};

describe('a room’s identity on the wire', () => {
  it('is words from closed lists and nothing else', () => {
    expect(RoomKitSchema.safeParse(kit).success).toBe(true);
    for (const name of ROOM_SWATCH_NAMES) expect(ROOM_SWATCHES[name]).toMatch(/^#[0-9A-F]{6}$/);
    expect(new Set(ROOM_SWATCH_NAMES).size).toBe(ROOM_SWATCH_NAMES.length);
    for (const list of [ROOM_EMBLEM_FRAMES, ROOM_EMBLEM_GLYPHS, ROOM_MOTIFS, ROOM_MOTIONS])
      expect(new Set(list).size).toBe(list.length);
    // R3 draws one ambient loop picked from six.
    expect(ROOM_MOTIONS).toHaveLength(6);
  });

  it.each([
    ['a colour code', { ...kit, palette: { ...kit.palette, ground: '#040A17' } }],
    ['markup', { ...kit, motif: '<svg/>' }],
    ['another version', { ...kit, version: 'station-kit.v2' }],
    ['a field it does not have', { ...kit, backdropPrompt: 'anything' }],
    ['no cast skins', { ...kit, cast: { explainer: 'star' } }],
    ['both residents wearing one mark', { ...kit, cast: { explainer: 'star', skeptic: 'star' } }],
  ])('refuses %s', (_name, value) => {
    expect(RoomKitSchema.safeParse(value).success).toBe(false);
  });

  it('names a backdrop only by an address under the media route', () => {
    const digest = 'ab'.repeat(32);
    expect(RoomIdentitySchema.safeParse({ kit, backdrop: { path: `/media/room/${digest}` } }).success).toBe(true);
    for (const path of [
      `https://example.test/${digest}.jpg`,
      `/media/room/${digest}.jpg`,
      `/media/${digest}`,
      '/media/room/../../etc/passwd',
      `//evil.test/media/room/${digest}`,
    ])
      expect(RoomIdentitySchema.safeParse({ kit, backdrop: { path } }).success, path).toBe(false);
  });

  it('is optional on a room summary, so a server or fixture without a face still parses', () => {
    const summary = {
      roomId: '0192f0a0-0001-7000-8000-000000000001',
      name: 'Space room',
      description: 'A room about space.',
      topic: { kind: 'system', id: 'earth-and-sky', label: 'Earth and sky' },
      joinRule: 'open',
      status: 'open',
    };
    expect(RoomSummarySchema.safeParse(summary).success).toBe(true);
    expect(RoomSummarySchema.safeParse({ ...summary, identity: { kit } }).success).toBe(true);
    expect(RoomSummarySchema.safeParse({ ...summary, identity: { kit: { ...kit, motion: 'spin' } } }).success).toBe(
      false,
    );
  });
});
