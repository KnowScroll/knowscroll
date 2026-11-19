/** What a key does while the reader has focus (D-134, D-425). */
export type ReaderKey =
  | { readonly action: 'next-stop' }
  | { readonly action: 'previous-stop' }
  | { readonly action: 'next-part' }
  | { readonly action: 'previous-part' }
  | { readonly action: 'next-topic' }
  | { readonly action: 'universe' }
  | { readonly action: 'ask' }
  | { readonly action: 'text-version' }
  | { readonly action: 'format' }
  | { readonly action: 'save' }
  | { readonly action: 'share-moment' }
  | { readonly action: 'challenge' }
  | { readonly action: 'simpler' }
  | { readonly action: 'small-print' }
  | { readonly action: 'report' };

const BY_KEY: Readonly<Record<string, ReaderKey>> = {
  ArrowDown: { action: 'next-stop' },
  ' ': { action: 'next-stop' },
  ArrowUp: { action: 'previous-stop' },
  ArrowRight: { action: 'next-part' },
  ArrowLeft: { action: 'previous-part' },
  n: { action: 'next-topic' },
  u: { action: 'universe' },
  a: { action: 'ask' },
  '?': { action: 'ask' },
  t: { action: 'text-version' },
  f: { action: 'format' },
  // The rows of the ••• sheet each have a key (V3 G5). Shift + S is Simpler; S alone is Save.
  s: { action: 'save' },
  h: { action: 'share-moment' },
  c: { action: 'challenge' },
  'Shift+S': { action: 'simpler' },
  p: { action: 'small-print' },
  r: { action: 'report' },
};

/** Every key the reader listens to, as `KeyboardEvent.key` names; the keyboard map lists each one. */
export const READER_KEY_NAMES: readonly string[] = Object.keys(BY_KEY);

/**
 * The reader's action for a `KeyboardEvent.key`, or none. Letters are case-insensitive, so Caps Lock changes nothing;
 * Shift is told apart only for S (Simpler), by the event's own shift flag.
 */
export function readerKeyOf(key: string, shift = false): ReaderKey | undefined {
  if (shift && key.toLowerCase() === 's') return BY_KEY['Shift+S'];
  return BY_KEY[key.length === 1 ? key.toLowerCase() : key];
}
