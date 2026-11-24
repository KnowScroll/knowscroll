/**
 * The names a reader must not see in a Scroll, from the sources a job offers, and the strings of a written value that the check reads.
 * The v1 writer that first held them is deleted (#818); the document v3 writer (`writer-v3.ts`) checks its replies with them.
 */
/** A name a reader must not see because the Scroll rests on that publisher's or site's pages. */
interface SourceName {
  /** Hostname suffixes of the sources this name belongs to. */
  readonly hosts: readonly string[];
  /** How the name reads in a text. Organisation names only, never ordinary words. */
  readonly pattern: RegExp;
  /** The name as the repair hint says it. Fixed here: the hint never echoes the model's text. */
  readonly label: string;
}

const PUBLISHER_NAMES: readonly SourceName[] = [
  { hosts: ['nasa.gov'], pattern: /\bNASA\b/iu, label: 'NASA' },
  {
    hosts: ['nasa.gov'],
    pattern: /\bNational Aeronautics and Space Administration\b/iu,
    label: 'National Aeronautics and Space Administration',
  },
  { hosts: ['nasa.gov'], pattern: /\bSpace Place\b/u, label: 'Space Place' },
  { hosts: ['noaa.gov'], pattern: /\bNOAA\b/iu, label: 'NOAA' },
  {
    hosts: ['noaa.gov'],
    pattern: /\bNational Oceanic and Atmospheric Administration\b/iu,
    label: 'National Oceanic and Atmospheric Administration',
  },
  { hosts: ['usgs.gov'], pattern: /\bUSGS\b/iu, label: 'USGS' },
  { hosts: ['usgs.gov'], pattern: /\b(?:U\.?S\.? )?Geological Survey\b/iu, label: 'Geological Survey' },
  { hosts: ['weather.gov'], pattern: /\bNWS\b/iu, label: 'NWS' },
  { hosts: ['weather.gov'], pattern: /\bNational Weather Service\b/iu, label: 'National Weather Service' },
  { hosts: ['wikipedia.org'], pattern: /\bWikipedia\b/iu, label: 'Wikipedia' },
  { hosts: ['wikipedia.org'], pattern: /\bWikimedia\b/iu, label: 'Wikimedia' },
  { hosts: ['arxiv.org'], pattern: /\barXiv\b/iu, label: 'arXiv' },
  { hosts: ['ourworldindata.org'], pattern: /\bOur World in Data\b/iu, label: 'Our World in Data' },
  { hosts: ['mozilla.org'], pattern: /\bMDN\b/u, label: 'MDN' },
  { hosts: ['mozilla.org'], pattern: /\bMozilla\b/iu, label: 'Mozilla' },
  { hosts: ['python.org'], pattern: /\bPython Software Foundation\b/iu, label: 'Python Software Foundation' },
  { hosts: ['openstax.org'], pattern: /\bOpenStax\b/iu, label: 'OpenStax' },
];

/** One thing a reader must not see in this job, with the code its finding and hint carry. */
export interface BannedName {
  readonly code: string;
  readonly pattern: RegExp;
  readonly hint: string;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const hostMatches = (hostname: string, suffix: string): boolean =>
  hostname === suffix || hostname.endsWith(`.${suffix}`);
const codeFor = (label: string): string =>
  `source_name_${label
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_|_$/gu, '')}`.slice(0, 64);

/**
 * What a reader must not see for the sources this job offers: the organisation names that belong to
 * those sources' hosts and the hostnames themselves. Ordinary words are never banned, so a recipe
 * on a `science.nasa.gov` page may still write "science". Each entry has its own code, so the repair
 * hint can name the word to remove without echoing anything the model wrote.
 */
export function bannedNames(provenance: {
  readonly sources: readonly { readonly url: string }[];
}): readonly BannedName[] {
  const hostnames = [...new Set(provenance.sources.map((source) => new URL(source.url).hostname))];
  const organisations = PUBLISHER_NAMES.filter((name) =>
    hostnames.some((hostname) => name.hosts.some((suffix) => hostMatches(hostname, suffix))),
  ).map(({ pattern, label }): BannedName => ({
    code: codeFor(label),
    pattern,
    hint: `Remove the name "${label}" from this text. Never name the source or its publisher.`,
  }));
  const addresses = hostnames.map((hostname): BannedName => ({
    code: codeFor(hostname),
    pattern: new RegExp(`(?<![\\p{L}\\p{N}-])${escapeRegExp(hostname)}(?![\\p{L}\\p{N}-])`, 'iu'),
    hint: `Remove the web address "${hostname}" from this text.`,
  }));
  return [...organisations, ...addresses];
}

/** Strings of an authored value, depth first; citations are handles, not reader text. */
export function* readerStrings(value: unknown, key = ''): Generator<string> {
  if (typeof value === 'string') {
    if (key !== 'cites') yield value;
  } else if (Array.isArray(value)) for (const item of value) yield* readerStrings(item, key);
  else if (typeof value === 'object' && value !== null)
    for (const [name, item] of Object.entries(value)) yield* readerStrings(item, name);
}
