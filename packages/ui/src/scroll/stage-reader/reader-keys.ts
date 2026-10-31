/** What a key does while the reader has focus (D-134). `pick` carries the option number, 1 to 4. */
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
  | { readonly action: 'lock-in' }
  | { readonly action: 'pick'; readonly option: number };

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
  Enter: { action: 'lock-in' },
  '1': { action: 'pick', option: 1 },
  '2': { action: 'pick', option: 2 },
  '3': { action: 'pick', option: 3 },
  '4': { action: 'pick', option: 4 },
};

/** Every key the reader listens to, as `KeyboardEvent.key` names; the keyboard map lists each one. */
export const READER_KEY_NAMES: readonly string[] = Object.keys(BY_KEY);

/** The reader's action for a `KeyboardEvent.key`, or none. Letters are case-insensitive. */
export function readerKeyOf(key: string): ReaderKey | undefined {
  return BY_KEY[key.length === 1 ? key.toLowerCase() : key];
}
