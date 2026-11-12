import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { assertOutsideTransaction } from '../postgres/transaction-marker.js';

/** Public research policy. Hosts are individually reviewed; a .gov suffix alone is not authority. */
export const RESEARCH_POLICY = 'public-research.v1';
const hosts = new Set([
  'en.wikipedia.org',
  'arxiv.org',
  'ourworldindata.org',
  'developer.mozilla.org',
  'docs.python.org',
  'www.typescriptlang.org',
  'react.dev',
  'nodejs.org',
  'science.nasa.gov',
  'spaceplace.nasa.gov',
  'www.nasa.gov',
  'climate.nasa.gov',
  'oceanservice.noaa.gov',
  'www.noaa.gov',
  'www.weather.gov',
  'www.usgs.gov',
]);
export const MAX_RESEARCH_BYTES = 2 * 1024 * 1024;
/** Wikimedia's user-agent policy asks every client to say how to reach its operator. */
const USER_AGENT = 'KnowScrollResearch/1.0 (+https://knowscroll.space/; public research page fetcher)';
export interface ResearchPassage {
  readonly id: string;
  readonly text: string;
}
export interface ResearchPage {
  readonly id: string;
  readonly policyVersion: typeof RESEARCH_POLICY;
  readonly url: string;
  readonly retrievedAt: string;
  readonly sha256: string;
  readonly title: string;
  readonly passages: readonly ResearchPassage[];
}
export class ResearchRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ResearchRefusal';
  }
}
/** Rejects unknown hosts, non-default ports, credentials, query-bearing links and OpenStax before DNS. */
export function researchUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ResearchRefusal('url_invalid');
  }
  if (url.protocol !== 'https:') throw new ResearchRefusal('scheme_refused');
  if (url.username || url.password) throw new ResearchRefusal('credentials_refused');
  if (url.port) throw new ResearchRefusal('port_refused');
  if (url.search || url.hash) throw new ResearchRefusal('url_parameters_refused');
  if (url.hostname === 'openstax.org' || url.hostname.endsWith('.openstax.org'))
    throw new ResearchRefusal('openstax_refused');
  if (!hosts.has(url.hostname)) throw new ResearchRefusal('host_refused');
  if (url.hostname === 'arxiv.org' && !/^\/abs\/\d{4}\.\d{4,5}(?:v\d+)?$/u.test(url.pathname))
    throw new ResearchRefusal('path_refused');
  return url;
}
/** Conservative globally routable address test; IPv6 mapped and special-purpose ranges are refused. */
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const p = address.split('.').map(Number);
    const a = p[0] ?? 0;
    const b = p[1] ?? 0;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && ((b === 0 && (p[2] === 0 || p[2] === 2)) || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0)
    );
  }
  // Only global-unicast 2000::/3; conservatively refuse IETF special-use, documentation and 6to4.
  if (isIP(address) !== 6 || !/^[23][0-9a-f]{3}:/iu.test(address)) return false;
  const groups = address.split(':');
  const first = Number.parseInt(groups[0] ?? '', 16);
  const second = Number.parseInt(groups[1] || '0', 16);
  return !(
    first === 0x2002 ||
    (first === 0x2001 && (second <= 0x1ff || second === 0xdb8)) ||
    (first === 0x3fff && second <= 0xfff)
  );
}
function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
function decode(text: string): string {
  const named: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/giu, (whole: string, entity: string) => {
    if (!entity.startsWith('#')) return named[entity.toLowerCase()] ?? whole;
    const n = entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : ' ';
  });
}
/**
 * The part of a page that is prose: comments, scripts, navigation, footnote markers, typeset maths and reference lists are gone, an
 * arXiv abstract becomes a paragraph, and the `main` or `article` element is taken when the page has one. Both the passages and the links
 * of a page are read from this, so a link of the navigation or of a reference list is never one a reader would follow from the text.
 */
function bodyOf(html: string): string {
  let body = html
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/<(script|style|nav|header|footer|noscript|svg|form)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, ' ')
    // Footnote markers, typeset maths and reference lists are not prose. A trailing "[1]" also hides
    // the end of a sentence from the quote-candidate splitter, which refuses the whole page.
    .replace(/<sup\b[^>]*\bclass="[^"]*\b(?:reference|noprint)\b[^"]*"[^>]*>[\s\S]*?<\/sup\s*>/giu, '')
    .replace(/<math\b[\s\S]*?<\/math\s*>/giu, ' ')
    .replace(/<ol\b[^>]*\bclass="[^"]*\breferences\b[^"]*"[^>]*>[\s\S]*?<\/ol\s*>/giu, ' ')
    // An arXiv abstract page keeps its abstract in a blockquote rather than a paragraph.
    .replace(/<blockquote\b[^>]*\bclass="[^"]*\babstract\b[^"]*"[^>]*>([\s\S]*?)<\/blockquote\s*>/giu, '<p>$1</p>');
  const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1\s*>/iu.exec(body);
  if (main?.[2]) body = main[2];
  return body;
}
/** Extracts stable paragraph snapshots; scripts/styles/navigation are excluded and never executed. */
export function extractResearch(html: string, url: string, retrievedAt: string): ResearchPage {
  if (!/<html\b|<!doctype\s+html/iu.test(html)) throw new ResearchRefusal('html_invalid');
  const title = decode(
    /<title[^>]*>([\s\S]*?)<\/title\s*>/iu.exec(html)?.[1]?.replace(/<[^>]*>/gu, '') ?? 'Research page',
  )
    .trim()
    .slice(0, 300);
  if (/\b(?:404|page not found|not found|access denied|just a moment|robot check)\b/iu.test(title))
    throw new ResearchRefusal('soft_404');
  const body = bodyOf(html);
  const paragraphs = [...body.matchAll(/<(p|li|h[1-6])\b[^>]*>([\s\S]*?)<\/\1\s*>/giu)]
    .map((m) =>
      decode((m[2] ?? '').replace(/<[^>]*>/gu, ' '))
        .replace(/\s+/gu, ' ')
        .trim(),
    )
    .filter(
      (text) =>
        text.length >= 60 &&
        text.length <= 2400 &&
        !/\b(?:api[_ -]?key|bearer\s+|secret[_ -]?key|access[_ -]?token|x-amz-signature|x-goog-signature|sk-[a-z0-9]{16,})\b/iu.test(
          text,
        ),
    );
  const unique: string[] = [];
  let characters = 0;
  for (const text of new Set(paragraphs)) {
    if (characters + text.length + 1 > 8000) break;
    unique.push(text);
    characters += text.length + 1;
  }
  if (unique.join(' ').length < 400 || /^(?:404|page not found)\b/iu.test(unique[0] ?? ''))
    throw new ResearchRefusal('page_empty_or_soft_404');
  const text = unique.join('\n');
  const sha256 = digest(text);
  const id = `page-${sha256.slice(0, 24)}`;
  return {
    id,
    policyVersion: RESEARCH_POLICY,
    url,
    retrievedAt,
    sha256,
    title,
    passages: unique.map((text) => ({ id: `p-${digest(text).slice(0, 24)}`, text })),
  };
}
/** How many links one page gives: a bound, however long the page. */
export const MAX_RESEARCH_LINKS = 300;

/** A link is worth following only to an article: not a root page, and on Wikipedia not a namespace page (`Category:`, `File:`, `Special:`). */
function articleAddress(url: URL): boolean {
  if (url.pathname === '/' || url.pathname === '') return false;
  if (url.hostname === 'en.wikipedia.org')
    return /^\/wiki\/[^:/]+$/u.test(url.pathname) && url.pathname !== '/wiki/Main_Page';
  return true;
}

/**
 * The links of a page's prose (#674, D-422): the addresses its paragraphs link to, in the order they appear, each made absolute against
 * the page, without its fragment, without a trailing slash, and kept only if the research URL rule allows it (https, a host that was
 * individually reviewed, no credentials, port or query), it names an article and it is not the page itself. The navigation, the footer, a
 * reference list and a footnote marker are not read, and nothing is fetched or executed. A link to a host the list does not name is
 * dropped here, so a page cannot lead the product anywhere a person did not review. At most {@link MAX_RESEARCH_LINKS}, each once.
 */
export function extractResearchLinks(html: string, url: string): readonly string[] {
  const base = new URL(url);
  const found = new Set<string>();
  for (const paragraph of bodyOf(html).matchAll(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/giu)) {
    for (const anchor of (paragraph[1] ?? '').matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/giu)) {
      const href = decode(anchor[1] ?? anchor[2] ?? '').trim();
      if (href === '' || href.startsWith('#')) continue;
      let target: URL;
      try {
        target = new URL(href, base);
      } catch {
        continue;
      }
      target.hash = '';
      if (target.pathname.length > 1 && target.pathname.endsWith('/')) target.pathname = target.pathname.slice(0, -1);
      let allowed: URL;
      try {
        allowed = researchUrl(target.href);
      } catch {
        continue;
      }
      if (!articleAddress(allowed) || allowed.href === base.href) continue;
      found.add(allowed.href);
      if (found.size >= MAX_RESEARCH_LINKS) return [...found];
    }
  }
  return [...found];
}
export interface ResearchResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
}
export interface ResearchNetwork {
  readonly addresses: (hostname: string) => Promise<readonly { readonly address: string; readonly family: number }[]>;
  readonly read: (
    url: URL,
    address: { readonly address: string; readonly family: number },
  ) => Promise<ResearchResponse>;
}
const network: ResearchNetwork = {
  addresses: async (hostname) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new ResearchRefusal('dns_timeout')), 10_000);
      timer.unref();
    });
    try {
      return await Promise.race([lookup(hostname, { all: true }), expired]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  },
  read: (url, address) =>
    new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          method: 'GET',
          agent: false,
          headers: { Accept: 'text/html', 'Accept-Encoding': 'identity', 'User-Agent': USER_AGENT },
          lookup: (_hostname, options, callback) => {
            if (options.all) callback(null, [{ address: address.address, family: address.family }]);
            else callback(null, address.address, address.family);
          },
          timeout: 20_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > MAX_RESEARCH_BYTES) {
              req.destroy(new ResearchRefusal('page_too_large'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('error', reject);
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: {
                location: res.headers.location,
                'content-type': res.headers['content-type'],
                'content-encoding': res.headers['content-encoding'],
              },
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      const deadline = setTimeout(() => req.destroy(new ResearchRefusal('request_timeout')), 20_000);
      deadline.unref();
      req.on('close', () => clearTimeout(deadline));
      req.on('timeout', () => req.destroy(new ResearchRefusal('request_timeout')));
      req.on('error', (error) =>
        reject(error instanceof ResearchRefusal ? error : new ResearchRefusal('network_failed')),
      );
      req.end();
    }),
};
/** Reads one allowlisted page's HTML without cookies; each redirect and every DNS answer is checked, and DNS is pinned. */
async function readResearchHtml(
  raw: string,
  deps: ResearchNetwork,
): Promise<{ readonly html: string; readonly url: URL }> {
  assertOutsideTransaction('research');
  let url = researchUrl(raw);
  for (let hop = 0; hop <= 3; hop++) {
    const addresses = await deps.addresses(url.hostname);
    const pinned = addresses[0];
    if (pinned === undefined || addresses.some((item) => !publicAddress(item.address)))
      throw new ResearchRefusal('address_refused');
    const response = await deps.read(url, pinned);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (hop === 3) throw new ResearchRefusal('redirect_limit');
      if (!response.headers.location) throw new ResearchRefusal('redirect_invalid');
      url = researchUrl(new URL(response.headers.location, url).href);
      continue;
    }
    if (response.status !== 200) throw new ResearchRefusal('http_refused');
    if (!/^text\/html(?:\s*;|$)/iu.test(response.headers['content-type'] ?? ''))
      throw new ResearchRefusal('content_type_refused');
    const charset = /charset\s*=\s*["']?([^;"'\s]+)/iu.exec(response.headers['content-type'] ?? '')?.[1];
    if (charset !== undefined && !/^(?:utf-?8|us-ascii|ascii)$/iu.test(charset))
      throw new ResearchRefusal('charset_refused');
    if (response.body.includes('\ufffd')) throw new ResearchRefusal('text_encoding_refused');
    if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')
      throw new ResearchRefusal('encoding_refused');
    if (Buffer.byteLength(response.body) > MAX_RESEARCH_BYTES) throw new ResearchRefusal('page_too_large');
    return { html: response.body, url };
  }
  throw new ResearchRefusal('redirect_limit');
}
/** Fetches one allowlisted page without cookies; each redirect and every DNS answer is checked, and DNS is pinned. */
export async function fetchResearchPage(
  raw: string,
  deps: ResearchNetwork = network,
  now: () => Date = () => new Date(),
): Promise<ResearchPage> {
  const { html, url } = await readResearchHtml(raw, deps);
  return extractResearch(html, url.href, now().toISOString());
}
/**
 * The same fetch, and the links of the page's prose besides its passages (#674, D-422): what topic growth reads a research page that is
 * already accepted for a recipe for. The page is the one {@link fetchResearchPage} would return, and every link passed the same URL rule.
 */
export async function fetchResearchWithLinks(
  raw: string,
  deps: ResearchNetwork = network,
  now: () => Date = () => new Date(),
): Promise<{ readonly page: ResearchPage; readonly links: readonly string[] }> {
  const { html, url } = await readResearchHtml(raw, deps);
  return {
    page: extractResearch(html, url.href, now().toISOString()),
    links: extractResearchLinks(html, url.href),
  };
}
