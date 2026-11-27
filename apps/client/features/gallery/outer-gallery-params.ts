import type { OuterStatus } from '../universe/voyage/outer/outer-copy';

/** What `/gallery-space?scene=outer` reads from its address. */
export interface OuterGalleryParams {
  /** How many sample friends the field holds, 0 to 200. */
  readonly friends: number;
  /** The field's offset in px (held inside what the field allows). */
  readonly panX: number;
  readonly panY: number;
  /** Where the read of the friends has got to. */
  readonly status: OuterStatus;
  /** The friend buttons are live. */
  readonly buttons: boolean;
  /** The list of all friends starts open. */
  readonly list: boolean;
  /** Draw a web for your own bubble. */
  readonly web: boolean;
}

type Raw = Readonly<Record<string, string | string[] | undefined>>;
const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);
const STATUSES: readonly OuterStatus[] = ['ready', 'loading', 'offline', 'failed'];
/** The most friends a sample holds. */
export const MOST_SAMPLE_FRIENDS = 200;

const number = (value: string | undefined, otherwise: number): number => {
  const read = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(read) ? read : otherwise;
};

/**
 * Reads `friends` (0 to 200, default 14), `panx` and `pany` (px, default 0), `status` (`ready`, `loading`, `offline`,
 * `failed`; default `ready`), `buttons=0` (friend buttons off), `list=1` (the list open) and `web=0` (no web drawn for
 * your own bubble). Anything else falls back to the default.
 */
export function readOuterParams(raw: Raw): OuterGalleryParams {
  const friends = Math.round(number(first(raw['friends']), 14));
  const status = first(raw['status']);
  return {
    friends: Math.min(MOST_SAMPLE_FRIENDS, Math.max(0, friends)),
    panX: number(first(raw['panx']), 0),
    panY: number(first(raw['pany']), 0),
    status: STATUSES.find((known) => known === status) ?? 'ready',
    buttons: first(raw['buttons']) !== '0',
    list: first(raw['list']) === '1',
    web: first(raw['web']) !== '0',
  };
}
