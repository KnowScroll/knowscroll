/**
 * A person's post in the room's Feed (v3 R-8b, D-269, D-270): what a post may say, what a source may be, and how many posts one
 * person may make. Pure: text in, a verdict out, with no database, clock, model or network. A person's words are never judged by a
 * model; code only checks their shape, and a source is checked as text and never fetched.
 */

/** What a person may post, and how often. Shown to members from these numbers, so a screen cannot say another. */
export const POST_RULES = {
  /** The most posts one member makes in one room on one UTC day. The cost of posting, so promotion cannot fill the Feed. */
  perDay: 3,
  /** The post's headline: it is the discussion's title. */
  titleMaxChars: 80,
  /** The member's own words under the headline. */
  wordsMaxChars: 500,
  /** The longest address kept, after it was made plain. */
  sourceMaxChars: 500,
} as const;

/** What a post is called once the account that wrote it is deleted: its headline and its source were that person's words. */
export const NEUTRAL_POST_TITLE = 'A post from a deleted account';

export type PostTextProblem = 'empty' | 'too_long' | 'has_link' | 'has_control';

/** A link belongs in the source, where it is checked; the headline and the words carry none. */
const LINK_IN_TEXT = /https?:\/\/|www\./iu;
/** Controls other than a line break in the words, and every control in the headline. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;

/**
 * What is wrong with the headline or the words of a post, if anything. Both are the member's own: they are trimmed by the contract,
 * must say something, must fit, and carry no address (one link per post, and it is the checked source or the library asset).
 */
export function postTextProblem(text: string, maxChars: number, multiline: boolean): PostTextProblem | undefined {
  if (text.trim() === '') return 'empty';
  if ([...text].length > maxChars) return 'too_long';
  if (LINK_IN_TEXT.test(text)) return 'has_link';
  if (CONTROL.test(text) || (!multiline && /[\n\r]/u.test(text))) return 'has_control';
  return undefined;
}

// --- A source ---------------------------------------------------------------------------------

export type SourceProblem =
  'empty' | 'too_long' | 'not_an_address' | 'not_http' | 'has_credentials' | 'has_port' | 'not_a_site' | 'shortener';

/** What a checked source is: the plain address that is stored and shown, and the site's name for the link's words. */
export interface Source {
  readonly url: string;
  /** The host without a leading `www.`, for the words of the link. */
  readonly host: string;
}

/** Link shorteners hide where a link goes, which is the one thing a source is for. A closed list: not a promise to catch all. */
const SHORTENERS: ReadonlySet<string> = new Set([
  'bit.ly',
  'buff.ly',
  'cutt.ly',
  'goo.gl',
  'is.gd',
  'lnkd.in',
  'ow.ly',
  'rb.gy',
  'rebrand.ly',
  'shorturl.at',
  't.co',
  't.ly',
  'tiny.cc',
  'tinyurl.com',
]);

/** Parameters that only say where a click came from. They are dropped, so one page is one source. */
const TRACKING_PARAMETER = /^(?:utm_[a-z0-9_]+|fbclid|gclid|dclid|msclkid|mc_eid|igshid|ref_src)$/iu;

/** A host that can only be reached from inside a network, or is a name for this machine. */
const INTERNAL_SUFFIX = /\.(?:local|localhost|internal|lan|home|corp|test|invalid|example)$/iu;
/** A dotted-number or bracketed address: a source is a site's name, not a machine's number. */
const IP_LITERAL = /^\[|^\d{1,3}(?:\.\d{1,3}){3}$|^\d+$/u;
/** Letters, digits and hyphens in dotted labels, ending in a top-level name of letters (or punycode). */
const DNS_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/u;

/**
 * Checks and tidies the address a member pastes as a post's source (D-270). It must be one address of at most 500 characters, with
 * `http` or `https`, a site's own name (no number, no `localhost`, no inside-network name, no user or password, no port), not a
 * link shortener. Tidying drops the fragment and tracking parameters and lowercases the host, so the same page is one source. It never
 * reaches the network: whether the page exists, or is what the member says, is for the people who open it to judge, and a report
 * handles the rest.
 */
export function checkSource(
  input: string,
): { readonly kind: 'ok'; readonly source: Source } | { readonly kind: 'refused'; readonly problem: SourceProblem } {
  const text = input.trim();
  if (text === '') return { kind: 'refused', problem: 'empty' };
  if ([...text].length > POST_RULES.sourceMaxChars) return { kind: 'refused', problem: 'too_long' };
  if (/\s/u.test(text) || CONTROL.test(text)) return { kind: 'refused', problem: 'not_an_address' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { kind: 'refused', problem: 'not_an_address' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { kind: 'refused', problem: 'not_http' };
  if (url.username !== '' || url.password !== '') return { kind: 'refused', problem: 'has_credentials' };
  if (url.port !== '') return { kind: 'refused', problem: 'has_port' };
  const host = url.hostname.toLowerCase();
  if (IP_LITERAL.test(host) || host === 'localhost' || INTERNAL_SUFFIX.test(host) || !DNS_NAME.test(host))
    return { kind: 'refused', problem: 'not_a_site' };
  const plainHost = host.replace(/^www\./u, '');
  if (SHORTENERS.has(plainHost)) return { kind: 'refused', problem: 'shortener' };
  url.hash = '';
  for (const name of [...url.searchParams.keys()]) if (TRACKING_PARAMETER.test(name)) url.searchParams.delete(name);
  const tidy = url.href.endsWith('?') ? url.href.slice(0, -1) : url.href;
  if ([...tidy].length > POST_RULES.sourceMaxChars) return { kind: 'refused', problem: 'too_long' };
  return { kind: 'ok', source: { url: tidy, host: plainHost } };
}

/** The site's name for the words of a stored source's link: its host without a leading `www.`. */
export function hostOf(url: string): string {
  return new URL(url).hostname.toLowerCase().replace(/^www./u, '');
}

// --- How many a person may post ------------------------------------------------------------------

/** Whether a member who has made `postsToday` posts in this room since the UTC day began may make another. */
export const mayPost = (postsToday: number): boolean => postsToday < POST_RULES.perDay;
