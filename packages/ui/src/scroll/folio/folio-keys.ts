import { READER_KEY_NAMES, readerKeyOf, type ReaderKey } from '../reader/reader-keys';

/**
 * What a key does in the essay (folio README 5.4: every gesture has a key). The ••• rows, Ask, Part and topic keys are
 * every reader's; reading is scrolling, so ↓ ↑ move a step, Space and Page Down a screen, Home and End to either end.
 */
export type FolioKey =
  | Exclude<ReaderKey, { readonly action: 'pick' } | { readonly action: 'lock-in' }>
  | { readonly action: 'page-down' }
  | { readonly action: 'page-up' }
  | { readonly action: 'to-start' }
  | { readonly action: 'to-end' };

const SCROLL_KEYS: Readonly<Record<string, FolioKey>> = {
  PageDown: { action: 'page-down' },
  PageUp: { action: 'page-up' },
  Home: { action: 'to-start' },
  End: { action: 'to-end' },
};

/** The essay's action for a `KeyboardEvent.key`, or none (the browser keeps the key). Calls are text, so 1 to 4 and Enter do nothing here. */
export function folioKeyOf(key: string, shift = false): FolioKey | undefined {
  if (key === ' ') return { action: shift ? 'page-up' : 'page-down' };
  const scroll = SCROLL_KEYS[key];
  if (scroll !== undefined) return scroll;
  const shared = readerKeyOf(key, shift);
  return shared === undefined || shared.action === 'pick' || shared.action === 'lock-in' ? undefined : shared;
}

/** Every key the essay listens to, as `KeyboardEvent.key` names (Shift + Space is Space's); the keyboard map lists each one. */
export const FOLIO_KEY_NAMES: readonly string[] = [
  ...READER_KEY_NAMES.filter((name) => folioKeyOf(name) !== undefined),
  ...Object.keys(SCROLL_KEYS),
];
