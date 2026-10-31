import { ROOM_HERE_COUNT_FROM, type RoomFace, type RoomHere } from '@knowscroll/contracts';

/** Longer than this without a message and the room says it is quiet. */
export const QUIET_AFTER_MS = 10 * 60_000;

export interface HereFaceView {
  readonly personId: string;
  readonly name: string;
  /** One or two letters for the face. */
  readonly initials: string;
  readonly you: boolean;
}

/** What the strip of faces says. */
export interface HereView {
  readonly faces: readonly HereFaceView[];
  /**
   * A number of people, only from three here ("4 here"). Never "0 here" or "1 here": the contract carries no
   * count below three and this refuses one if it ever did.
   */
  readonly countLabel: string | undefined;
  /** Who is here in words, for the caption and a screen reader; absent when only the reader is here. */
  readonly caption: string | undefined;
}

export const initialsOf = (name: string): string => {
  const parts = name
    .trim()
    .split(/\s+/u)
    .filter((part) => part !== '');
  const letters = parts.length > 1 ? [parts[0]!, parts[parts.length - 1]!] : [parts[0] ?? '?'];
  return letters.map((part) => [...part][0]!.toLocaleUpperCase()).join('');
};

const faceView = (face: RoomFace): HereFaceView => ({
  personId: face.person.personId,
  name: face.person.displayName,
  initials: initialsOf(face.person.displayName),
  you: face.you,
});

/**
 * The words and faces for who is here (D-069): faces always, a number only at three or more, never an AI. With
 * two people the faces are named ("You and Asha"); from three the number stands in for the names.
 */
export function hereView(here: RoomHere): HereView {
  const faces = here.faces.map(faceView);
  const count = here.count !== undefined && here.count >= ROOM_HERE_COUNT_FROM ? here.count : undefined;
  const others = faces.filter((face) => !face.you);
  const caption =
    count !== undefined
      ? `${String(count)} here`
      : others.length === 0
        ? undefined
        : `You and ${others.map((face) => face.name).join(' and ')} are here`;
  return { faces, countLabel: count === undefined ? undefined : `${String(count)} here`, caption };
}

/** How long ago, in the few words a quiet pill has room for. */
export function agoWords(ageMs: number): string {
  const minutes = Math.max(0, Math.floor(ageMs / 60_000));
  if (minutes < 60) return `${String(Math.max(1, minutes))} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${String(hours)} h ago`;
  return `${String(Math.floor(hours / 24))} d ago`;
}

/**
 * The honest quiet pill: present only when nothing has been said for a while, and it says when the last message
 * was. A room nobody has written in says so. It reads the device clock against the server's time of the last
 * message, so a clock that runs behind never makes a busy room look quiet: a message in the future is not quiet.
 */
export function quietPill(lastMessageAt: string | undefined, now: Date): string | undefined {
  if (lastMessageAt === undefined) return 'Quiet right now · no messages yet';
  const age = now.getTime() - new Date(lastMessageAt).getTime();
  if (age < QUIET_AFTER_MS) return undefined;
  return `Quiet right now · last message ${agoWords(age)}`;
}
