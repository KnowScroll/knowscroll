/**
 * #162 — where a model-written Scroll's material may come from, and what of a page it is
 * (ADR-0041 §1–§2). No I/O: the fetcher (`apps/worker/src/scrolls/fetch-material.ts`) asks
 * `checkMaterialUrl` before every request and every redirect hop, and turns the page it read into
 * material with `extractVisibleText`.
 */
import { normalizeSnapshotText } from '../semantic/source-text.ts';

export const MATERIAL_POLICY_VERSION = 'material-hosts-v1';
/** Bench values. */
export const MATERIAL_LIMITS = Object.freeze({ maxBytes: 2_000_000, maxRedirects: 3, minTextChars: 400 });

/** Evidence families as the substrate defines them; one it already loaded must match exactly. */
export interface MaterialFamily { key: string; kind: 'publisher'; description: string }
export const MATERIAL_FAMILIES = Object.freeze({
  nasa: { key: 'fam.nasa', kind: 'publisher', description: 'NASA public-domain science education pages (science.nasa.gov, spaceplace.nasa.gov).' },
  noaa: { key: 'fam.noaa', kind: 'publisher', description: 'NOAA National Ocean Service public-domain fact pages (oceanservice.noaa.gov).' },
  usgs: { key: 'fam.usgs', kind: 'publisher', description: 'USGS public-domain science pages (www.usgs.gov).' },
} satisfies Record<string, MaterialFamily>);

export interface MaterialHost { publisher: string; family: MaterialFamily; keyPrefix: 'nasa' | 'noaa' | 'usgs' }
const NASA: MaterialHost = { publisher: 'NASA', family: MATERIAL_FAMILIES.nasa, keyPrefix: 'nasa' };
const NOAA: MaterialHost = { publisher: 'NOAA', family: MATERIAL_FAMILIES.noaa, keyPrefix: 'noaa' };
// US federal works are public domain. The National Weather Service is part of NOAA, so its pages are
// not independent evidence from NOAA's own.
const HOSTS: Readonly<Record<string, MaterialHost>> = Object.freeze({
  'science.nasa.gov': NASA, 'spaceplace.nasa.gov': NASA, 'www.nasa.gov': NASA,
  'oceanservice.noaa.gov': NOAA, 'www.noaa.gov': NOAA,
  'www.weather.gov': { ...NOAA, publisher: 'NOAA National Weather Service' },
  'www.usgs.gov': { publisher: 'USGS', family: MATERIAL_FAMILIES.usgs, keyPrefix: 'usgs' },
});

export type MaterialUrlRefusal = 'not_a_url' | 'openstax_excluded' | 'not_https' | 'credentials_in_url' | 'port_not_allowed' | 'host_not_allowed';

/** The one question asked of every URL before it is requested, the first and every redirect alike. */
export function checkMaterialUrl(raw: string): { ok: true; url: string; host: MaterialHost } | { ok: false; reason: MaterialUrlRefusal } {
  if (!URL.canParse(raw)) return { ok: false, reason: 'not_a_url' };
  const url = new URL(raw);
  // Refused by name, whatever the scheme: its pages say CC BY-NC-SA (owner decision, 2026-09-24).
  if (url.hostname === 'openstax.org' || url.hostname.endsWith('.openstax.org')) return { ok: false, reason: 'openstax_excluded' };
  if (url.protocol !== 'https:') return { ok: false, reason: 'not_https' };
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'credentials_in_url' };
  if (url.port !== '') return { ok: false, reason: 'port_not_allowed' };
  const host = HOSTS[url.hostname];
  if (!host) return { ok: false, reason: 'host_not_allowed' };
  url.hash = '';
  return { ok: true, url: url.href, host };
}

// The snapshot tool's rules (scripts/substrate/snapshot_source.py), so a page reads the same in both.
const SKIP = new Set(['script', 'style', 'noscript', 'svg', 'template', 'head']);
const BLOCK = new Set(['p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'tr', 'section', 'article', 'figcaption', 'blockquote']);
/** Their content runs to the matching end tag and is never markup. */
const RAW_TEXT = new Set(['script', 'style']);
const NAMED: Readonly<Record<string, string>> = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '­', ensp: ' ', emsp: ' ', thinsp: ' ',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„',
  hellip: '…', bull: '•', middot: '·', prime: '′', Prime: '″', deg: '°', plusmn: '±', times: '×',
  divide: '÷', minus: '−', micro: 'µ', sup2: '²', sup3: '³', frac12: '½', frac14: '¼', frac34: '¾',
  le: '≤', ge: '≥', ne: '≠', asymp: '≈', infin: '∞', larr: '←', rarr: '→', copy: '©', reg: '®',
  trade: '™', sect: '§', para: '¶', laquo: '«', raquo: '»', eacute: 'é', egrave: 'è', aacute: 'á',
  agrave: 'à', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', ccedil: 'ç', auml: 'ä', ouml: 'ö', uuml: 'ü',
});
/** Numeric references and the common named ones; an unknown name stays as written. */
function decodeEntities(text: string): string {
  return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g, (whole, ref: string) => {
    if (ref[0] !== '#') return NAMED[ref] ?? whole;
    const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : '�';
  });
}
/** Like the snapshot tool: data is decoded as it is read, and the joined text once more before normalizing. */
const finish = (parts: readonly string[]) => normalizeSnapshotText(decodeEntities(parts.join(' ')));

/** Where a tag ends: the first `>` outside a quoted attribute value. */
function tagEnd(html: string, from: number): number {
  let quote = '', previous = '';
  for (let i = from; i < html.length; i += 1) {
    const ch = html[i]!;
    if (quote) { if (ch === quote) quote = ''; continue; }
    if ((ch === '"' || ch === "'") && previous === '=') quote = ch;
    else if (ch === '>') return i;
    if (!/\s/.test(ch)) previous = ch;
  }
  return html.length;
}

export interface VisibleText {
  /** The whole page's visible text, normalized: what is stored and hashed. */
  text: string;
  /** The `<main>` element's visible text, a passage of `text`; offered first when present. */
  focus: string | null;
  /** The document `<title>`, normalized. */
  title: string | null;
}

export function extractVisibleText(html: string): VisibleText {
  const lower = html.toLowerCase();
  const parts: string[] = [];
  const title: string[] = [];
  // Only the first <title> is the document's; an inline SVG may carry its own.
  let skip = 0, mainFrom = -1, mainTo = -1, titleState: 'before' | 'reading' | 'read' = 'before';
  const start = (tag: string) => {
    if (SKIP.has(tag)) skip += 1;
    else if (BLOCK.has(tag)) parts.push(' ');
    if (tag === 'main' && mainFrom < 0) mainFrom = parts.length;
    if (tag === 'title' && titleState === 'before') titleState = 'reading';
  };
  const end = (tag: string) => {
    if (SKIP.has(tag)) { if (skip > 0) skip -= 1; } else if (BLOCK.has(tag)) parts.push(' ');
    if (tag === 'main' && mainFrom >= 0 && mainTo < 0) mainTo = parts.length;
    if (tag === 'title' && titleState === 'reading') titleState = 'read';
  };
  const data = (raw: string) => {
    const text = decodeEntities(raw);
    if (titleState === 'reading') title.push(text);
    if (skip === 0) parts.push(text);
  };
  const TAG = /<(\/?)([a-zA-Z][^\t\n\r\f />\0]*)/y;
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf('<', at);
    if (open < 0) { data(html.slice(at)); break; }
    if (open > at) data(html.slice(at, open));
    if (html.startsWith('<!--', open)) {
      const close = html.indexOf('-->', open + 4);
      at = close < 0 ? html.length : close + 3;
      continue;
    }
    TAG.lastIndex = open;
    const match = TAG.exec(html);
    if (!match) {
      // A declaration or processing instruction is skipped; a lone "<" is text.
      if (html[open + 1] === '!' || html[open + 1] === '?') { at = tagEnd(html, open) + 1; continue; }
      data('<');
      at = open + 1;
      continue;
    }
    const name = match[2]!.toLowerCase();
    const close = tagEnd(html, TAG.lastIndex);
    at = close + 1;
    if (match[1]) { end(name); continue; }
    start(name);
    if (html[close - 1] === '/') { end(name); continue; }
    // Script and style content is never visible (both are skipped), so it is passed over unread.
    if (RAW_TEXT.has(name)) {
      const endTag = lower.indexOf(`</${name}`, at);
      at = endTag < 0 ? html.length : endTag;
    }
  }
  const focus = mainFrom >= 0 ? finish(parts.slice(mainFrom, mainTo < 0 ? parts.length : mainTo)) : '';
  const heading = normalizeSnapshotText(decodeEntities(title.join('')));
  return { text: finish(parts), focus: focus || null, title: heading || null };
}
