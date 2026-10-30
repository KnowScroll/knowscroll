import { readingWords, type ScrollDocumentV2 } from '@knowscroll/scroll-model';

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

function callLines(stop: Extract<ScrollDocumentV2['stops'][number], { kind: 'call_it' | 'final_call' }>): string[] {
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
  return lines;
}

function quoteLines(evidence: ReviewEvidence | undefined, part: string): string[] {
  return (evidence?.quotesByPart.get(part) ?? []).map((quote) => `  > source passage: ${quote}`);
}

/** The Scroll as plain text for the operator's terminal. Pure. */
export function reviewTextOf(document: ScrollDocumentV2, evidence?: ReviewEvidence): string {
  const words = readingWords(document);
  const lines: string[] = [
    `${document.kicker} · ${document.title}`,
    document.dek,
    `${words} words · ${document.measures.readingMinutes} minutes · ${document.stops.length} stops · ${document.stage === undefined ? 'no picture' : 'with a picture'}`,
    document.misconception.kind === 'myth'
      ? `Misconception: ${document.misconception.claim} (source: ${document.misconception.source.label}, reviewed: ${String(document.misconception.source.reviewed)})`
      : 'Misconception: none',
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
      const picture = pictures.get(stop.id);
      if (picture !== undefined) lines.push(`  PICTURE: ${picture}`);
      lines.push(...quoteLines(evidence, stop.id));
    } else lines.push(...callLines(stop));
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
