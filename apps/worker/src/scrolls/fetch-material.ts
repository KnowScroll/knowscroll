/**
 * #162 — fetching one allowlisted page as a model-written Scroll's material (ADR-0041 §1–§2).
 *
 * Every URL, the first and each redirect hop, is checked by `checkMaterialUrl` before it is
 * requested, so nothing off the allowlist is ever asked for. Redirects are followed by hand (at most
 * `MATERIAL_LIMITS.maxRedirects`); no cookie or credential is sent; at most `maxBytes` is read.
 * The page's visible text, normalized, is the material; its SHA-256 is what the snapshot records.
 * Nothing is logged or persisted here.
 */
import { createHash } from 'node:crypto';
import { checkMaterialUrl, extractVisibleText, MATERIAL_LIMITS, type MaterialHost, type MaterialUrlRefusal } from '../../../../packages/core/src/scrolls/material.ts';

const USER_AGENT = 'KnowScroll-material/1 (+personal non-commercial)';
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export interface FetchedMaterial {
  /** The final URL, after any allowlisted redirects: the source's URL. */
  url: string;
  host: MaterialHost;
  title: string | null;
  /** The whole page's normalized visible text: what is stored and hashed. */
  text: string;
  /** Its `<main>` text, a passage of `text`, offered to the model first. */
  focus: string | null;
  contentSha256: string;
  retrievedAt: string;
}
export type MaterialFetchRefusal = MaterialUrlRefusal | 'too_many_redirects' | 'http_status' | 'not_html' | 'too_large' | 'too_little_text' | 'fetch_failed';
export type MaterialFetch =
  | { ok: true; material: FetchedMaterial }
  | { ok: false; reason: Exclude<MaterialFetchRefusal, 'http_status'> }
  | { ok: false; reason: 'http_status'; httpStatus: number };

/** The body, or null once it is known to exceed `max` bytes (declared or streamed). */
async function readBounded(response: Response, max: number): Promise<Uint8Array | null> {
  if (Number(response.headers.get('content-length') ?? 0) > max) { await response.body?.cancel(); return null; }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    total += read.value.length;
    if (total > max) { await reader.cancel(); return null; }
    chunks.push(read.value);
  }
  return Buffer.concat(chunks);
}

function decoderFor(contentType: string): TextDecoder {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  try { return new TextDecoder(charset ?? 'utf-8'); } catch { return new TextDecoder('utf-8'); }
}

export async function fetchMaterial(url: string, options: { fetchImpl?: typeof fetch; signal?: AbortSignal; timeoutMs?: number; now?: () => Date } = {}): Promise<MaterialFetch> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(options.timeoutMs ?? 30_000)]);
  let checked = checkMaterialUrl(url);
  for (let hop = 0; ; hop += 1) {
    if (!checked.ok) return { ok: false, reason: checked.reason };
    let response: Response;
    try {
      response = await fetchImpl(checked.url, {
        method: 'GET', redirect: 'manual', credentials: 'omit', signal,
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
      });
    } catch { return { ok: false, reason: 'fetch_failed' }; }
    if (REDIRECTS.has(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (location === null) return { ok: false, reason: 'http_status', httpStatus: response.status };
      if (hop >= MATERIAL_LIMITS.maxRedirects) return { ok: false, reason: 'too_many_redirects' };
      checked = checkMaterialUrl(URL.canParse(location, checked.url) ? new URL(location, checked.url).href : location);
      continue;
    }
    if (response.status !== 200) { await response.body?.cancel(); return { ok: false, reason: 'http_status', httpStatus: response.status }; }
    const contentType = response.headers.get('content-type') ?? '';
    if (!/^\s*(text\/html|application\/xhtml\+xml)\b/i.test(contentType)) { await response.body?.cancel(); return { ok: false, reason: 'not_html' }; }
    let bytes: Uint8Array | null;
    try { bytes = await readBounded(response, MATERIAL_LIMITS.maxBytes); } catch { return { ok: false, reason: 'fetch_failed' }; }
    if (bytes === null) return { ok: false, reason: 'too_large' };
    const page = extractVisibleText(decoderFor(contentType).decode(bytes));
    if (page.text.length < MATERIAL_LIMITS.minTextChars) return { ok: false, reason: 'too_little_text' };
    return {
      ok: true,
      material: {
        url: checked.url, host: checked.host, title: page.title, text: page.text, focus: page.focus,
        contentSha256: createHash('sha256').update(page.text, 'utf8').digest('hex'),
        retrievedAt: (options.now ?? (() => new Date()))().toISOString(),
      },
    };
  }
}
