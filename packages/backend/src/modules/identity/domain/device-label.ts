const MAX_LABEL_LENGTH = 80;

/** Browsers, most specific first: Edge, Opera and Chrome on iOS all also say `Chrome` or `Safari`. */
const browsers: readonly (readonly [RegExp, string])[] = [
  [/\b(?:Edg|EdgA|EdgiOS)\//, 'Edge'],
  [/\bOPR\//, 'Opera'],
  [/\b(?:Firefox|FxiOS)\//, 'Firefox'],
  [/\b(?:Chrome|CriOS)\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
];

/** Operating systems, most specific first: an iPad says `Macintosh` and Android says `Linux`. */
const systems: readonly (readonly [RegExp, string])[] = [
  [/\biPhone\b/, 'iPhone'],
  [/\biPad\b/, 'iPad'],
  [/\bAndroid\b/, 'Android'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bLinux\b/, 'Linux'],
];

function firstMatch(table: readonly (readonly [RegExp, string])[], userAgent: string): string | undefined {
  return table.find(([pattern]) => pattern.test(userAgent))?.[1];
}

/**
 * The coarse label a person sees for one of their sessions: "Chrome on macOS" on the web,
 * "KnowScroll on Android" in the app. It is computed once, when the session is issued, from the
 * `User-Agent` header, and only the label is stored: never the header, an address or a version
 * number. A client that sends nothing recognisable gets a plain label, so the field is never empty.
 */
export function deviceLabelOf(userAgent: string | undefined, client: 'web' | 'native'): string {
  const header = (userAgent ?? '').slice(0, 512);
  const system = firstMatch(systems, header);
  const subject = client === 'native' ? 'KnowScroll' : (firstMatch(browsers, header) ?? 'Web browser');
  const label = system === undefined ? (client === 'native' ? 'KnowScroll app' : subject) : `${subject} on ${system}`;
  return label.slice(0, MAX_LABEL_LENGTH);
}
