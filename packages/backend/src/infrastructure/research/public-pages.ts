import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { assertOutsideTransaction } from '../postgres/transaction-marker.js';

/** Public research policy. Hosts are individually reviewed; a .gov suffix alone is not authority. */
const RESEARCH_POLICY = 'public-research.v1';
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
      (a === 192 && ((b === 0 && p[2] === 0) || b === 168 || b === 2)) ||
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
  let body = html
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/<(script|style|nav|header|footer|noscript|svg|form)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, ' ');
  const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1\s*>/iu.exec(body);
  if (main?.[2]) body = main[2];
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
          headers: { Accept: 'text/html', 'Accept-Encoding': 'identity', 'User-Agent': 'KnowScrollResearch/1.0' },
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
/** Fetches one allowlisted page without cookies; each redirect and every DNS answer is checked, and DNS is pinned. */
export async function fetchResearchPage(
  raw: string,
  deps: ResearchNetwork = network,
  now: () => Date = () => new Date(),
): Promise<ResearchPage> {
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
    return extractResearch(response.body, url.href, now().toISOString());
  }
  throw new ResearchRefusal('redirect_limit');
}
