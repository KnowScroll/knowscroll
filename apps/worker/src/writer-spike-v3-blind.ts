import { randomInt } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { describePicture, ScrollDocumentV3, type SpikeArm } from '@knowscroll/backend/modules/content/nest-providers';

type Print = (result: Record<string, unknown>) => void;

/** One accepted document of a spike, as `writer-spike-v3 --out` wrote it. */
export interface BlindInput {
  readonly key: string;
  readonly arm: SpikeArm;
  readonly document: ScrollDocumentV3;
}

/** What the owner opens after reading: which recipe and arm each essay letter was. */
export type BlindKey = Readonly<Record<string, { readonly key: string; readonly arm: string }>>;

/** The page is for people, so the number of essays is what a letter can name. */
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const escapeHtml = (text: string): string =>
  text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');

/** A small seeded generator (mulberry32), so a seed reproduces an order. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** The items in an order the seed decides (Fisher-Yates). The same seed gives the same order. */
export function shuffleSeeded<T>(items: readonly T[], seed: number): T[] {
  const random = seededRandom(seed);
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[other]] = [shuffled[other] as T, shuffled[index] as T];
  }
  return shuffled;
}

type Beat = ScrollDocumentV3['sections'][number]['beats'][number];

/** The words of a quotation's speaker: who, the work in italics, the year. */
function quoteSource(beat: Extract<Beat, { kind: 'quote' }>): string {
  const parts = [
    escapeHtml(beat.cite.who),
    ...(beat.cite.work === undefined ? [] : [`<cite>${escapeHtml(beat.cite.work)}</cite>`]),
    ...(beat.cite.year === undefined ? [] : [escapeHtml(beat.cite.year)]),
  ];
  return parts.join(', ');
}

/** What a beat shows, as one boxed line of words: the picture's title and what a reader without the drawing would hear. */
function pictureBox(document: ScrollDocumentV3, beat: Beat): string {
  if (beat.show === undefined) return '';
  const { picture: pictureId, state } = beat.show;
  const picture = document.pictures.find((candidate) => candidate.id === pictureId);
  if (picture === undefined) return '';
  return `<p class="picture"><strong>Picture: ${escapeHtml(picture.title)}</strong> ${escapeHtml(describePicture(picture, state))}</p>`;
}

function beatHtml(beat: Beat): string {
  if (beat.kind === 'plain') return `<p>${escapeHtml(beat.text)}</p>`;
  return `<blockquote><p>${escapeHtml(beat.text)}</p><footer>${quoteSource(beat)}</footer></blockquote>`;
}

const asideHtml = (aside: ScrollDocumentV3['asides'][number]): string =>
  `<aside><p class="tag">Aside</p><p><strong>${escapeHtml(aside.title)}</strong> ${escapeHtml(aside.text)}</p></aside>`;

/** One essay: title, dek, each section with its beats in order, the asides after their beats, the takeaway. */
function essayHtml(letter: string, document: ScrollDocumentV3): string {
  const sections = document.sections.map((section) => {
    const beats = section.beats.map((beat) => {
      const asides = document.asides.filter((aside) => aside.anchorBeat === beat.id).map(asideHtml);
      return [beatHtml(beat), pictureBox(document, beat), ...asides].filter((part) => part !== '').join('\n');
    });
    return `<section>\n<h3>${escapeHtml(section.title)}</h3>\n${beats.join('\n')}\n</section>`;
  });
  return [
    `<article id="essay-${letter}">`,
    `<p class="letter">Essay ${letter}</p>`,
    `<h2>${escapeHtml(document.title)}</h2>`,
    `<p class="dek">${escapeHtml(document.dek)}</p>`,
    ...sections,
    `<section class="sum">\n<h3>To sum up</h3>\n<p>${escapeHtml(document.takeaway)}</p>\n</section>`,
    '</article>',
  ].join('\n');
}

const STYLE = `
:root { color-scheme: light dark; --ground: #fbfaf7; --ink: #1d1b18; --quiet: #5d584f; --rule: #d8d3c8; --box: #efece4; }
@media (prefers-color-scheme: dark) {
  :root { --ground: #16150f; --ink: #ece8dd; --quiet: #aaa597; --rule: #3a372e; --box: #25231b; }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; background: var(--ground); color: var(--ink); font: 17px/1.55 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; overflow-wrap: anywhere; }
main { max-width: 38rem; margin: 0 auto; }
article { padding: 32px 0 40px; border-top: 2px solid var(--rule); }
h1 { font-size: 1.3rem; margin: 8px 0 12px; }
h2 { font-size: 1.6rem; line-height: 1.2; margin: 4px 0 8px; }
h3 { font-size: 1.05rem; margin: 28px 0 8px; }
.letter, .tag { color: var(--quiet); font-size: 0.8rem; letter-spacing: 0.08em; text-transform: uppercase; margin: 0; }
.dek { color: var(--quiet); font-size: 1.1rem; margin: 0 0 8px; }
.picture, aside, .sum { background: var(--box); border: 1px solid var(--rule); border-radius: 8px; padding: 10px 12px; font-size: 0.95rem; }
.picture { margin: 12px 0; }
aside { margin: 12px 0; }
aside p { margin: 4px 0; }
blockquote { margin: 16px 0; padding-left: 14px; border-left: 3px solid var(--rule); font-style: italic; }
blockquote p { margin: 0 0 6px; }
blockquote footer { font-style: normal; color: var(--quiet); font-size: 0.9rem; }
.sum { margin-top: 28px; }
.sum h3 { margin-top: 0; }
.sum p { margin: 4px 0 0; }
`;

/**
 * The blind-read page of an accepted spike: the documents in an order the seed decides, labelled Essay A, B, C and so
 * on, each as plain text with the words of its pictures. Nothing on the page names an arm, a recipe, a run or a model.
 * One self-contained file: no network, no script, system fonts, readable at 390 px and in dark mode. Every string that came
 * from a document is HTML-escaped. At most 26 essays.
 *
 * @returns the page, and the key that says which recipe and arm each letter is, kept apart from the page.
 */
export function renderBlindPage(
  inputs: readonly BlindInput[],
  seed: number,
): { readonly html: string; readonly key: BlindKey } {
  if (inputs.length > LETTERS.length) throw new Error('A blind page holds at most 26 essays.');
  const ordered = shuffleSeeded(inputs, seed);
  const key: Record<string, { key: string; arm: string }> = {};
  const essays = ordered.map((input, index) => {
    const letter = LETTERS.charAt(index);
    key[letter] = { key: input.key, arm: input.arm };
    return essayHtml(letter, input.document);
  });
  const html = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    '<title>Essays to read</title>',
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    '<main>',
    '<h1>Essays to read</h1>',
    '<p>Read each essay on its own. A boxed line says what a picture shows at that point.</p>',
    ...essays,
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
  return { html, key };
}

/** The accepted documents of a `--out` file: one JSON line each. A line that is not one is counted and left out. */
export function readBlindInputs(text: string): { readonly inputs: BlindInput[]; readonly skipped: number } {
  const inputs: BlindInput[] = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    const record = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
    const document = ScrollDocumentV3.safeParse(record.document);
    if (!document.success || typeof record.key !== 'string' || (record.arm !== 'a' && record.arm !== 'b')) {
      skipped += 1;
      continue;
    }
    inputs.push({ key: record.key, arm: record.arm, document: document.data });
  }
  return { inputs, skipped };
}

export interface WriterSpikeV3BlindOptions {
  readonly in: string | undefined;
  readonly page: string | undefined;
  readonly key: string | undefined;
  readonly seed: string | undefined;
}

const usageText = 'content writer-spike-v3-blind --in <out file> --page <html file> --key <key file> [--seed <n>]';

/**
 * `content writer-spike-v3-blind --in <out file> --page <html file> --key <key file> [--seed <n>]`: turns the accepted
 * documents of a `writer-spike-v3 --out` file into one local HTML page to read without knowing which arm wrote which
 * essay, and writes the key (letter to recipe and arm, as JSON) to a separate file to open after reading. Without
 * `--seed` the order is random and the seed is printed, so the same order can be made again.
 *
 * Touches no database, provider or network. The page and the key hold the model's own text about public sources: keep them
 * in a folder outside the repository and never paste them into an issue. Exit status: 0 written, 2 refused, 1 a failure.
 */
export async function writerSpikeV3BlindCommand(
  options: WriterSpikeV3BlindOptions,
  print: Print,
  logEvent: LogEvent,
): Promise<number> {
  const seed = options.seed === undefined ? randomInt(0, 2 ** 31) : Number(options.seed);
  if (
    options.in === undefined ||
    options.page === undefined ||
    options.key === undefined ||
    !Number.isInteger(seed) ||
    seed < 0 ||
    seed > 2 ** 32 - 1 ||
    new Set([resolve(options.in), resolve(options.page), resolve(options.key)]).size !== 3
  ) {
    print({ result: 'usage', usage: usageText });
    return 2;
  }
  try {
    const { inputs, skipped } = readBlindInputs(await readFile(options.in, 'utf8'));
    if (inputs.length === 0 || inputs.length > LETTERS.length) {
      print({ command: 'content writer-spike-v3-blind', result: 'no_usable_essays', skipped, found: inputs.length });
      return 2;
    }
    const { html, key } = renderBlindPage(inputs, seed);
    await writeFile(options.page, html, { mode: 0o600 });
    await writeFile(options.key, `${JSON.stringify(key, null, 2)}\n`, { mode: 0o600 });
    print({ command: 'content writer-spike-v3-blind', result: 'written', essays: inputs.length, skipped, seed });
    return 0;
  } catch (error) {
    logEvent('process.crashed', { reasonCode: 'writer_spike_v3_blind_failed', error });
    return 1;
  }
}
