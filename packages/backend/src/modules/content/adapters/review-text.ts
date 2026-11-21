import {
  beatsOfV3,
  describeChart,
  describeFork,
  describePicture,
  describeScale,
  orderedItems,
  pickItems,
  readingWords,
  scrubPositions,
  sortedItems,
  type Beat,
  type Interactive,
  type Picture,
  type ScrollDocumentV2,
  type ScrollDocumentV3,
} from '@knowscroll/scroll-model';
import type { AnswerCheckSummary, CallVerdict } from '../domain/answer-check.js';
import { LIBRARY_SUPPORT_POLICY, countsOf, decideRevision } from '../domain/library-support.js';
import { NOT_COVERED_LINE } from '../production/library-support.js';
import type { StoredLibraryCheck } from '../production/library-support-store.js';

/**
 * What an operator reads to judge a v2 Scroll before it is released (D-138): the title, every stop
 * with its picture, every call with its answer and the explanation, the asides and the recap, in
 * reading order. It is the document as stored, nothing the reader never sees, plus (when the cited
 * passages are given) the exact source passages each part rests on, so a statement can be checked
 * against its source.
 */
export interface ReviewEvidence {
  /** The quotes each part (a stop id, an aside id or `recap`) cites, in the order they were cited. */
  readonly quotesByPart: ReadonlyMap<string, readonly string[]>;
  /** One line for each page the quotes come from. */
  readonly sources: readonly string[];
}

const OPTION_LABELS = ['A', 'B', 'C', 'D'] as const;

function callLines(
  stop: Extract<ScrollDocumentV2['stops'][number], { kind: 'call_it' | 'final_call' }>,
  pictures: ReadonlyMap<string, string>,
): string[] {
  const label = stop.kind === 'final_call' ? 'FINAL CALL' : 'CALL IT';
  const lines = [`[${stop.id}] ${label}: ${stop.prompt}`];
  stop.options.forEach((option, index) => {
    const marks = [
      index === stop.answer ? 'correct' : undefined,
      stop.kind === 'call_it' && stop.commonGuess?.option === index
        ? `common guess, source: ${stop.commonGuess.source.label}`
        : undefined,
    ].filter((mark): mark is string => mark !== undefined);
    lines.push(
      `  ${OPTION_LABELS[index] ?? String(index + 1)}. ${option}${marks.length > 0 ? ` (${marks.join('; ')})` : ''}`,
    );
  });
  lines.push(`  Explanation: ${stop.explain}`, `  After a wrong pick: ${stop.twist}`, `  Simpler: ${stop.simple}`);
  // The picture a wrong pick turns the stage to (D-383): the operator reads it with the twist it comes with.
  if (stop.kind === 'call_it' && stop.revealStage !== undefined)
    lines.push(
      `  After a wrong pick the picture turns to: ${pictures.get(stop.revealStage) ?? '(the stop it names sets none)'}`,
    );
  return lines;
}

/** The play block of a read stop as an operator checks it: the answer key of a sort, both paths of a fork, every figure of a scale or a chart. */
function interactiveLines(interactive: Interactive): string[] {
  switch (interactive.type) {
    case 'sort':
      return [
        `  SORT, correct order: ${sortedItems(interactive)
          .map((item, index) => `${String(index + 1)}. ${item}`)
          .join(' ')}`,
        `  SORT, why: ${interactive.explain}`,
      ];
    case 'fork':
      return [`  FORK: ${describeFork(interactive)}`];
    case 'scale':
      return [`  SCALE: ${describeScale(interactive)}`];
    case 'chart':
      return [`  CHART: ${describeChart(interactive)}`];
  }
}

function quoteLines(evidence: ReviewEvidence | undefined, part: string): string[] {
  return (evidence?.quotesByPart.get(part) ?? []).map((quote) => `  > source passage: ${quote}`);
}

/** A flag with the call as the checker saw it, when the job kept it, so it can be read without the draft. */
function flagLines(flag: CallVerdict): string[] {
  const lines = [`    [${flag.id}] ${flag.problem ?? 'flagged'}`];
  if (flag.call === undefined) return lines;
  lines.push(`      Question: ${flag.call.prompt}`);
  flag.call.options.forEach((option, index) => {
    const mark = index === flag.call?.answer ? ' (marked correct)' : '';
    lines.push(`        ${OPTION_LABELS[index] ?? String(index + 1)}. ${option}${mark}`);
  });
  lines.push(`      Explanation: ${flag.call.explain}`);
  return lines;
}

/**
 * What the answer check said, in words an operator can act on (D-198). It is a model's opinion about
 * whether each call's answer key agrees with the call's own words; it never replaces reading them. A
 * Scroll with no check at all says so, because that is also a fact about how much to trust the read.
 */
export function answerCheckLines(check: AnswerCheckSummary | null): string[] {
  if (check === null)
    return ['Answer check: not run for this revision (it was made before the check existed). Read every call.'];
  switch (check.outcome) {
    case 'passed':
      return [
        `Answer check: passed. The checker found all ${String(check.calls)} calls consistent with their answer keys.`,
      ];
    case 'repaired':
      return [
        `Answer check: repaired. The first draft had ${String(check.firstDraftFlags.length)} flagged call(s); the writer corrected them once and this draft's ${String(check.calls)} calls passed.`,
        'First-draft flags:',
        ...check.firstDraftFlags.flatMap(flagLines),
      ];
    case 'unchecked':
      return [
        `Answer check: NOT CHECKED (${check.code}). The checker gave no usable answer, so no call has a verdict. Read every call's answer key yourself.`,
        ...(check.firstDraftFlags.length === 0
          ? []
          : ['First-draft flags:', ...check.firstDraftFlags.flatMap(flagLines)]),
      ];
    case 'flagged':
      return ['Answer check: FLAGGED. These calls were flagged and not cleared:', ...check.flags.flatMap(flagLines)];
  }
}

/**
 * What the library support check said, in words an operator can act on (D-415). It is a model's opinion about whether the cited passages
 * state each sentence; it never replaces reading the Scroll against its sources, and the "Not covered" line says what it does not read. A sentence
 * it flagged, or could not judge, is listed with where it stands, so the read can begin there, and so is every sentence it passed as stating no fact.
 * A revision with no result says so, because that is also a fact about how much to trust the read.
 */
export function supportCheckLines(check: StoredLibraryCheck | null): string[] {
  if (check === null)
    return ['Support check: not run for this revision yet. Read every sentence against its sources.', NOT_COVERED_LINE];
  if (check.state === 'unchecked')
    return [
      `Support check: NOT CHECKED (${check.code ?? 'unknown'}). No sentence has a verdict. Read every sentence against its sources.`,
      NOT_COVERED_LINE,
    ];
  const counts = countsOf(check.sentences);
  const verdict = decideRevision(counts, LIBRARY_SUPPORT_POLICY) === 'passed' ? 'PASSED' : 'FLAGGED';
  const lines = [
    `Support check: ${verdict} (${check.checkerVersion}, ${LIBRARY_SUPPORT_POLICY.id}). ${String(counts.sentences)} sentences: ${String(counts.supported)} supported, ${String(counts.unsupported)} unsupported, ${String(counts.unclear)} unclear, ${String(counts.noClaim)} state no fact.`,
  ];
  const stated = check.sentences.filter((sentence) => sentence.outcome === 'no_claim');
  if (stated.length > 0) lines.push('Passed as stating no fact (no passage was quoted for them):');
  for (const sentence of stated)
    lines.push(
      `  [${sentence.part} ${sentence.field} #${String(sentence.n)}] ${sentence.ground ?? 'no ground'}: ${sentence.text}`,
    );
  const attention = check.sentences.filter(
    (sentence) => sentence.outcome === 'unsupported' || sentence.outcome === 'unclear',
  );
  if (attention.length > 0) lines.push('Read these first:');
  for (const sentence of attention) {
    const why =
      sentence.outcome === 'unsupported'
        ? `unsupported${sentence.kind === undefined ? '' : ` (${sentence.kind})`}`
        : `unclear${sentence.code === undefined ? '' : ` (${sentence.code})`}`;
    lines.push(
      `  [${sentence.part} ${sentence.field} #${String(sentence.n)}] ${why}: ${sentence.text}${sentence.problem === undefined ? '' : ` -- ${sentence.problem}`}`,
    );
  }
  lines.push(NOT_COVERED_LINE);
  return lines;
}

/**
 * The Scroll as plain text for the operator's terminal. Pure. `support` is the library support check's stored result: `undefined` leaves
 * its line out, `null` says it has not run for this revision.
 */
export function reviewTextOf(
  document: ScrollDocumentV2,
  evidence?: ReviewEvidence,
  check: AnswerCheckSummary | null = null,
  support?: StoredLibraryCheck | null,
): string {
  const words = readingWords(document);
  const lines: string[] = [
    `${document.kicker} · ${document.title}`,
    document.dek,
    `${words} words · ${document.measures.readingMinutes} minutes · ${document.stops.length} stops · ${document.stage === undefined ? 'no picture' : 'with a picture'}`,
    document.misconception.kind === 'myth'
      ? `Misconception: ${document.misconception.claim} (source: ${document.misconception.source.label}, reviewed: ${String(document.misconception.source.reviewed)})`
      : 'Misconception: none',
    ...answerCheckLines(check),
    ...(support === undefined ? [] : supportCheckLines(support)),
    '',
  ];
  const pictures = new Map((document.stage?.states ?? []).map((state) => [state.stop, state.alt]));
  const asidesByStop = new Map<string, ScrollDocumentV2['asides']>();
  for (const aside of document.asides)
    asidesByStop.set(aside.anchorStop, [...(asidesByStop.get(aside.anchorStop) ?? []), aside]);
  for (const stop of document.stops) {
    if (stop.kind === 'read') {
      lines.push(`[${stop.id}]${stop.emphasis === undefined ? '' : ` (${stop.emphasis})`}`);
      for (const block of stop.blocks) lines.push(`  ${block.type === 'heading' ? '# ' : ''}${block.text}`);
      lines.push(`  Simpler: ${stop.simple}`);
      if (stop.guide !== undefined)
        lines.push(`  GUIDE (${stop.guide.character}, ${stop.guide.pose}): ${stop.guide.line}`);
      if (stop.interactive !== undefined) lines.push(...interactiveLines(stop.interactive));
      const picture = pictures.get(stop.id);
      if (picture !== undefined) lines.push(`  PICTURE: ${picture}`);
      lines.push(...quoteLines(evidence, stop.id));
    } else lines.push(...callLines(stop, pictures));
    for (const aside of asidesByStop.get(stop.id) ?? []) {
      lines.push(`  ASIDE (${aside.kind}${aside.collapsed ? ', collapsed' : ''}) ${aside.title}: ${aside.text}`);
      lines.push(...quoteLines(evidence, aside.id));
    }
    lines.push('');
  }
  lines.push('RECAP', ...document.recap.captions.map((caption) => `  ${caption}`), ...quoteLines(evidence, 'recap'));
  lines.push('', 'ASK SUGGESTIONS', ...document.askSuggestions.map((suggestion) => `  ${suggestion}`));
  if (evidence !== undefined && evidence.sources.length > 0)
    lines.push('', 'SOURCES', ...evidence.sources.map((source) => `  ${source}`));
  return lines.join('\n');
}

/** The quotation a quote beat sets apart, with who said it, where and when. */
function citeOf(cite: Extract<Beat, { kind: 'quote' }>['cite']): string {
  return [cite.who, cite.work, cite.year].filter((part): part is string => part !== undefined).join(', ');
}

/** What a beat's control lets a reader reach, in the picture's own words: every position of a scrub, the other side of a switch, the notes of a pick. */
function controlLines(beat: Extract<Beat, { kind: 'plain' }>, picture: Picture | undefined): string[] {
  const control = beat.control;
  if (control === undefined) return [];
  const lines = [
    `  CONTROL (${control.kind}) "${control.label}"${control.kind === 'scrub' ? ` along ${control.along}` : ''}`,
  ];
  if (picture === undefined || beat.show === undefined) return lines;
  switch (control.kind) {
    case 'scrub':
      scrubPositions(picture, beat.show.state, control.along).forEach((position, index) =>
        lines.push(`    ${String(index + 1)}. ${position.label}: ${describePicture(picture, position.state)}`),
      );
      break;
    case 'switch':
      lines.push(`    Switches to: ${describePicture(picture, control.to)}`);
      break;
    case 'pick':
      for (const item of pickItems(picture)) lines.push(`    ${item.label}: ${item.note ?? ''}`);
      break;
  }
  return lines;
}

/** A linked phrase with the part it names; the part's label is added when the picture has one for it. */
function linkLines(beat: Beat, picture: Picture | undefined): string[] {
  const labels = new Map((picture === undefined ? [] : orderedItems(picture)).map((item) => [item.id, item.label]));
  return beat.links.map((link) => {
    const label = labels.get(link.part);
    return `  LINK "${link.phrase}" -> ${link.part}${label === undefined ? '' : ` (${label})`}`;
  });
}

/**
 * The document v3 Scroll as plain text for the operator's terminal, to read before it is released (D-138): kicker, title and
 * promise, every section and beat in reading order with the picture each shows (in its words, derived by code), its linked
 * phrases, its control and what the control reaches, its quotation, its asides, the takeaway and the ask suggestions. It is the
 * document as stored. When `evidence` is given, the exact passages each part cites follow that part (a beat, an aside, a picture
 * or `takeaway`). `support` is the library support check's stored result, as for {@link reviewTextOf}; a document v3 has no calls,
 * so there is no answer check line. Pure.
 */
export function reviewTextV3(
  document: ScrollDocumentV3,
  evidence?: ReviewEvidence,
  support?: StoredLibraryCheck | null,
): string {
  const beats = beatsOfV3(document);
  const controls = beats.filter((beat) => beat.kind === 'plain' && beat.control !== undefined).length;
  const lines: string[] = [
    `${document.kicker} · ${document.title}`,
    document.dek,
    `${document.measures.mainWords} words · ${document.measures.readingMinutes} minutes · ${beats.length} beats · ${document.pictures.length} pictures · ${controls} controls · ${document.shape}`,
    document.misconception.kind === 'myth'
      ? `Misconception: ${document.misconception.claim} (source: ${document.misconception.source.label}, reviewed: ${String(document.misconception.source.reviewed)})`
      : 'Misconception: none',
    ...(support === undefined ? [] : supportCheckLines(support)),
    '',
    'PICTURES',
  ];
  const pictures = new Map(document.pictures.map((picture) => [picture.id, picture]));
  for (const picture of document.pictures) {
    lines.push(
      `  [${picture.id}] ${picture.kind}: ${picture.title}${picture.caption === undefined ? '' : ` (${picture.caption})`}`,
      ...quoteLines(evidence, picture.id).map((line) => `  ${line}`),
    );
  }
  lines.push('');
  const asidesByBeat = new Map<string, ScrollDocumentV3['asides']>();
  for (const aside of document.asides)
    asidesByBeat.set(aside.anchorBeat, [...(asidesByBeat.get(aside.anchorBeat) ?? []), aside]);
  for (const section of document.sections) {
    lines.push(`SECTION [${section.id}] ${section.title}`, '');
    for (const beat of section.beats) {
      const picture = beat.show === undefined ? undefined : pictures.get(beat.show.picture);
      const emphasis = beat.kind === 'plain' && beat.emphasis !== undefined ? ` (${beat.emphasis})` : '';
      lines.push(`[${beat.id}]${emphasis}${beat.kind === 'quote' ? ' (quotation)' : ''}`, `  ${beat.text}`);
      if (beat.kind === 'quote') lines.push(`  QUOTE FROM: ${citeOf(beat.cite)}`);
      lines.push(`  Simpler: ${beat.simple}`);
      if (beat.show !== undefined)
        lines.push(
          `  PICTURE [${beat.show.picture}]: ${picture === undefined ? '(a picture the document does not declare)' : describePicture(picture, beat.show.state)}`,
        );
      lines.push(...linkLines(beat, picture));
      if (beat.kind === 'plain') lines.push(...controlLines(beat, picture));
      lines.push(...quoteLines(evidence, beat.id));
      for (const aside of asidesByBeat.get(beat.id) ?? []) {
        lines.push(`  ASIDE (${aside.kind}${aside.collapsed ? ', collapsed' : ''}) ${aside.title}: ${aside.text}`);
        lines.push(...quoteLines(evidence, aside.id));
      }
      lines.push('');
    }
  }
  lines.push('TO SUM UP', `  ${document.takeaway}`, ...quoteLines(evidence, 'takeaway'));
  lines.push('', 'ASK SUGGESTIONS', ...document.askSuggestions.map((suggestion) => `  ${suggestion}`));
  if (evidence !== undefined && evidence.sources.length > 0)
    lines.push('', 'SOURCES', ...evidence.sources.map((source) => `  ${source}`));
  return lines.join('\n');
}
