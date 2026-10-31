import { createContext, useContext } from 'react';
import { ROOM_SWATCHES, type RoomKit } from '@knowscroll/contracts';
import { space } from '@knowscroll/design-tokens';

/**
 * The colours chrome takes where a room's band sits behind it (D-170): the kit's ground, and its ink for words. The
 * ink is checked against the ground for contrast before a kit can be shown, so text drawn in it reads. A screen with no
 * band, or a room without a face, keeps the space tone the dark header always had.
 */
export interface BandTone {
  readonly ground: string;
  readonly ink: string;
  /** The ink a little softer, for a second line. */
  readonly inkSoft: string;
  /** A hairline edge and a faint wash, for pills and rings. */
  readonly edge: string;
  readonly wash: string;
}

export const SPACE_TONE: BandTone = {
  ground: space.s0,
  ink: space.label,
  inkSoft: space.label2,
  edge: space.edge,
  wash: space.s1,
};

/** The tone of a kit: the swatches' own colours, with the ink at 72 %, 22 % and 12 % for secondary text, edges and washes. */
export function toneOf(kit: Pick<RoomKit, 'palette'>): BandTone {
  const ink = ROOM_SWATCHES[kit.palette.ink];
  return {
    ground: ROOM_SWATCHES[kit.palette.ground],
    ink,
    inkSoft: `${ink}B8`,
    edge: `${ink}38`,
    wash: `${ink}1F`,
  };
}

export const BandToneContext = createContext<BandTone>(SPACE_TONE);

/** The tone of the band the caller is drawn on. */
export const useBandTone = (): BandTone => useContext(BandToneContext);
