import { canonicalJson, canonicalSha256, canonicalSize } from '../canonical.js';
import { INTEGRITY_METHOD } from '../document.js';
import { issueFromSchema } from '../issues.js';
import { beatsOfV3, ScrollDocumentV3, type Beat } from './document.js';
import { uniqueIssuesV3, type IssueV3 } from './issues.js';
import { LIMITS_V3 } from './limits.js';
import { beatWords, computeMeasuresV3, READING_SECONDS_V3 } from './measures.js';
import { controlIssues, partIds, pictureDataIssues, pictureStateIssues } from './picture-rules.js';
import type { Picture } from './pictures.js';

/** SHA-256 of the canonical JSON of the document without its `integrity` member. */
export function computeIntegrityV3(document: Omit<ScrollDocumentV3, 'integrity'> & { integrity?: unknown }): string {
  return canonicalSha256({ ...document, integrity: undefined });
}

export interface ValidateV3Options {
  /**
   * Recompute the reading measures, the reading time and the integrity hash (the default). Only `parseDocumentV3`, the
   * client path, turns it off, as v1 and v2 do: SHA-256 over up to 128 KiB is cheap on a JIT and not on Hermes.
   */
  readonly verify?: boolean;
}

export type DocumentV3Outcome =
  | {
      readonly kind: 'valid';
      readonly document: ScrollDocumentV3;
      /** Things a person must still settle before the Scroll joins the library; they do not refuse the document. */
      readonly notices: readonly IssueV3[];
    }
  | { readonly kind: 'invalid'; readonly issues: readonly IssueV3[] };

/** A beat with where it sits, so each rule names the path of what it refuses. */
interface LocatedBeat {
  readonly beat: Beat;
  readonly path: string;
  readonly sectionIndex: number;
}

function locateBeats(document: ScrollDocumentV3): LocatedBeat[] {
  return document.sections.flatMap((section, sectionIndex) =>
    section.beats.map((beat, beatIndex) => ({
      beat,
      path: `sections.${sectionIndex}.beats.${beatIndex}`,
      sectionIndex,
    })),
  );
}

const picturesById = (document: ScrollDocumentV3): ReadonlyMap<string, Picture> =>
  new Map(document.pictures.map((picture) => [picture.id, picture]));

/** Sections, beats, asides and pictures share one id space, so a link, an anchor or a show can never be ambiguous. */
function idIssues(document: ScrollDocumentV3): IssueV3[] {
  const entries: [string, string][] = [
    ...document.pictures.map((picture, index): [string, string] => [picture.id, `pictures.${index}.id`]),
    ...document.sections.flatMap((section, sectionIndex): [string, string][] => [
      [section.id, `sections.${sectionIndex}.id`],
      ...section.beats.map((beat, beatIndex): [string, string] => [
        beat.id,
        `sections.${sectionIndex}.beats.${beatIndex}.id`,
      ]),
    ]),
    ...document.asides.map((aside, index): [string, string] => [aside.id, `asides.${index}.id`]),
  ];
  const seen = new Set<string>();
  const issues: IssueV3[] = [];
  for (const [id, path] of entries) {
    if (seen.has(id)) issues.push({ code: 'id_duplicate', path });
    seen.add(id);
  }
  return issues;
}

/** The number of beats, and the words of each: one beat, the first beat (the cover's lede) and the plainer version. */
function beatTextIssues(document: ScrollDocumentV3, located: readonly LocatedBeat[]): IssueV3[] {
  const issues: IssueV3[] = [];
  if (located.length < LIMITS_V3.beats.min) issues.push({ code: 'beats_too_few', path: 'sections' });
  if (located.length > LIMITS_V3.beats.max) issues.push({ code: 'beats_too_many', path: 'sections' });
  located.forEach(({ beat, path }, index) => {
    const words = beatWords(beat);
    if (words > LIMITS_V3.beatWords) issues.push({ code: 'beat_too_long', path: `${path}.text` });
    if (index === 0 && words > LIMITS_V3.firstBeatWords)
      issues.push({ code: 'first_beat_too_long', path: `${path}.text` });
    if (beatWords({ text: beat.simple }) > LIMITS_V3.beatWords)
      issues.push({ code: 'simple_too_long', path: `${path}.simple` });
  });
  const { mainWords } = computeMeasuresV3(document);
  if (mainWords < LIMITS_V3.mainWords.min) issues.push({ code: 'main_text_too_short', path: 'sections' });
  if (mainWords > LIMITS_V3.mainWords.max) issues.push({ code: 'main_text_too_long', path: 'sections' });
  return issues;
}

/**
 * Each picture's own data, then each `show`: its picture is declared and its state is one that picture can be in.
 * Last, every declared picture is shown by some beat, because a picture nobody shows is dead weight in a document.
 */
function pictureIssues(document: ScrollDocumentV3, located: readonly LocatedBeat[]): IssueV3[] {
  const issues = document.pictures.flatMap((picture, index) => pictureDataIssues(picture, `pictures.${index}`));
  const byId = picturesById(document);
  const shown = new Set<string>();
  for (const { beat, path } of located) {
    if (beat.show === undefined) continue;
    const picture = byId.get(beat.show.picture);
    if (picture === undefined) {
      issues.push({ code: 'show_picture_unknown', path: `${path}.show.picture` });
      continue;
    }
    shown.add(picture.id);
    issues.push(...pictureStateIssues(picture, beat.show.state, `${path}.show.state`));
  }
  document.pictures.forEach((picture, index) => {
    if (!shown.has(picture.id)) issues.push({ code: 'picture_unshown', path: `pictures.${index}` });
  });
  return issues;
}

/**
 * How many times `phrase` occurs in `text`. Overlapping matches count, so a phrase that could be found in two places
 * ("aa" in "aaa") is not "once": the reader would have no one place to underline.
 */
function occurrences(text: string, phrase: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(phrase, from);
    if (at < 0) return count;
    count += 1;
    from = at + 1;
  }
}

/**
 * A beat's links name parts of the picture on screen at that beat: the one its own `show` names, else the last one an
 * earlier beat of the same section showed. A new section starts without a picture, because a reader may arrive at it
 * from a place that does not show the previous one. Each phrase is in the text exactly once.
 */
function linkIssues(document: ScrollDocumentV3, located: readonly LocatedBeat[]): IssueV3[] {
  const issues: IssueV3[] = [];
  const byId = picturesById(document);
  let section = -1;
  let onScreen: Picture | undefined;
  for (const { beat, path, sectionIndex } of located) {
    if (sectionIndex !== section) {
      section = sectionIndex;
      onScreen = undefined;
    }
    const own = beat.show === undefined ? undefined : byId.get(beat.show.picture);
    // A show naming an undeclared picture is already `show_picture_unknown`; its links have no picture to be judged by.
    const skip = beat.show !== undefined && own === undefined;
    const picture = beat.show === undefined ? onScreen : own;
    const spans = beat.links.map((link) => {
      const start = beat.text.indexOf(link.phrase);
      return [start, start + link.phrase.length] as const;
    });
    beat.links.forEach((link, index) => {
      const linkPath = `${path}.links.${index}`;
      if (occurrences(beat.text, link.phrase) !== 1)
        issues.push({ code: 'link_phrase_not_once', path: `${linkPath}.phrase` });
      // Two links over the same words would leave the reader nothing single to underline.
      const [start, end] = spans[index] ?? [-1, -1];
      if (start >= 0 && spans.some(([from, to], other) => other < index && from >= 0 && from < end && start < to))
        issues.push({ code: 'link_phrases_overlap', path: `${linkPath}.phrase` });
      if (skip) return;
      if (picture === undefined) issues.push({ code: 'link_without_picture', path: linkPath });
      else if (!partIds(picture).includes(link.part))
        issues.push({ code: 'link_part_unknown', path: `${linkPath}.part` });
    });
    if (own !== undefined) onScreen = own;
  }
  return issues;
}

/** At most `LIMITS_V3.controls` in the document; each sits on a beat that shows a picture and fits that picture. */
function controlRuleIssues(document: ScrollDocumentV3, located: readonly LocatedBeat[]): IssueV3[] {
  const issues: IssueV3[] = [];
  const byId = picturesById(document);
  let count = 0;
  for (const { beat, path } of located) {
    if (beat.kind !== 'plain' || beat.control === undefined) continue;
    const controlPath = `${path}.control`;
    count += 1;
    if (count > LIMITS_V3.controls) issues.push({ code: 'control_budget_exceeded', path: controlPath });
    if (beat.show === undefined) {
      issues.push({ code: 'control_without_show', path: controlPath });
      continue;
    }
    const picture = byId.get(beat.show.picture);
    if (picture !== undefined) issues.push(...controlIssues(picture, beat.control, beat.show, controlPath));
  }
  return issues;
}

/** Each aside sits beside a beat, and the document owns up to its limits in one `limits` aside (the end plate's small print). */
function asideIssues(document: ScrollDocumentV3): IssueV3[] {
  const beatIds = new Set(beatsOfV3(document).map((beat) => beat.id));
  const issues: IssueV3[] = [];
  document.asides.forEach((aside, index) => {
    if (!beatIds.has(aside.anchorBeat))
      issues.push({ code: 'aside_anchor_unknown', path: `asides.${index}.anchorBeat` });
  });
  if (!document.asides.some((aside) => aside.kind === 'limits'))
    issues.push({ code: 'limits_aside_missing', path: 'asides' });
  return issues;
}

/**
 * How many sentences a takeaway has. A sentence ends at `.`, `!`, `?` or `…`, with any closing quotes or brackets after
 * it, followed by a space or the end of the text, so a decimal point ("23.4") and an abbreviation without a space after
 * it do not end one; a run of enders ("?!", "...") ends one sentence, and so does `.”`. Text after the last ender, or
 * text with no ender at all, is one more sentence.
 */
export function takeawaySentenceCount(takeaway: string): number {
  return takeaway.split(/(?<=[.!?…]["”’)\]]*)\s+/u).filter((sentence) => sentence.trim().length > 0).length;
}

function takeawayIssues(document: ScrollDocumentV3): IssueV3[] {
  const sentences = takeawaySentenceCount(document.takeaway);
  const { min, max } = LIMITS_V3.takeawaySentences;
  return sentences < min || sentences > max ? [{ code: 'takeaway_sentences', path: 'takeaway' }] : [];
}

/** The stored measures, the reading time and the hash, recomputed. */
function storedIssues(document: ScrollDocumentV3): IssueV3[] {
  const issues: IssueV3[] = [];
  const measures = computeMeasuresV3(document);
  if (canonicalJson(measures) !== canonicalJson(document.measures))
    issues.push({ code: 'measures_mismatch', path: 'measures' });
  if (measures.readingSeconds < READING_SECONDS_V3.min || measures.readingSeconds > READING_SECONDS_V3.max)
    issues.push({ code: 'reading_length_out_of_brief', path: 'measures.readingSeconds' });
  if (document.integrity.method !== INTEGRITY_METHOD || computeIntegrityV3(document) !== document.integrity.sha256)
    issues.push({ code: 'integrity_mismatch', path: 'integrity' });
  return issues;
}

function noticesOf(document: ScrollDocumentV3): IssueV3[] {
  return document.misconception.kind === 'myth' && !document.misconception.source.reviewed
    ? [{ code: 'misconception_source_unreviewed', path: 'misconception.source' }]
    : [];
}

/**
 * Admission of a `scroll-document.v3`: the size, the schema, the budget of `scroll-limits.v3`, the rules of
 * its beats, pictures, links, controls, asides and takeaway, and the stored measures and hash, recomputed.
 *
 * Pure and deterministic; the findings carry codes and paths, never the text they are about. Never throws on hostile
 * input. The client path, `parseDocumentV3`, skips the measures and the hash exactly as v1's and v2's do.
 */
export function validateDocumentV3(input: unknown, options: ValidateV3Options = {}): DocumentV3Outcome {
  try {
    if (canonicalSize(input) > LIMITS_V3.documentBytes)
      return { kind: 'invalid', issues: [{ code: 'document_too_large', path: '$' }] };
  } catch {
    return { kind: 'invalid', issues: [{ code: 'document_not_object', path: '$' }] };
  }
  const parsed = ScrollDocumentV3.safeParse(input);
  if (!parsed.success) return { kind: 'invalid', issues: uniqueIssuesV3(parsed.error.issues.map(issueFromSchema)) };
  const document = parsed.data;
  const located = locateBeats(document);
  const issues: IssueV3[] = [
    ...idIssues(document),
    ...beatTextIssues(document, located),
    ...pictureIssues(document, located),
    ...linkIssues(document, located),
    ...controlRuleIssues(document, located),
    ...asideIssues(document),
    ...takeawayIssues(document),
    ...(options.verify === false ? [] : storedIssues(document)),
  ];
  if (issues.length > 0) return { kind: 'invalid', issues: uniqueIssuesV3(issues) };
  return { kind: 'valid', document, notices: noticesOf(document) };
}
