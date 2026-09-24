import { useEffect, useId, useRef } from 'react';
import { ENCOUNTER_SUPPRESSION_DAYS, type ComposerFamily, type EncounterFeedbackKind, type EvidenceStep } from '../api/types.ts';
import type { WhyView } from '../state/readerStore.ts';

/**
 * #133 (ADR-0032 §4–§5, journey G): "What led here", the web half of Android's `WhySection`
 * (apps/mobile/.../ui/scroll/ScrollScreen.kt, ui/why/WhyPresentation.kt). Everything shown comes
 * from the recorded explanation: the family that chose the encounter and one line per recorded
 * evidence step, built from its recorded fields only -- no interest, profile or guessed motive.
 * Only the corrections the explanation supports and the reader has not made are offered, each
 * saying what it does before it is pressed and what it did after.
 */

/** The family's own words (ADR-0032's objective: "continue a thread, go deeper, cross an admitted
 * sourced bridge, meet a credible challenge, revisit something newly relevant, or step outside on
 * purpose -- with honest fallback"). Shown beside the recorded family literal, never instead of it. */
const FAMILY_TEXT: Record<ComposerFamily, string> = {
  continue: 'continue a thread you started',
  deepen: 'go deeper into something you acted on',
  bridge: 'cross a sourced connection',
  challenge: 'meet a credible challenge',
  revisit: 'revisit something newly relevant',
  frontier: 'step outside on purpose',
  seed: 'open a first door',
  fallback: 'keep the whole library reachable',
};

export function whyStepText(step: EvidenceStep): string {
  switch (step.kind) {
    case 'mark': {
      const title = step.title.trim().length > 0 ? `“${step.title}”` : 'a Scroll';
      if (step.markKind === 'keep') return `You kept ${title}`;
      if (step.markKind === 'branch') return `You followed a connection from ${title}`;
      return `You asked about ${title}`;
    }
    case 'bridge':
      return step.sentence;
    case 'question':
      return 'A question you asked that has no answer yet';
    case 'outside':
      return 'Somewhere you have not been shown before';
  }
}

function stepKey(step: EvidenceStep, index: number): string {
  switch (step.kind) {
    case 'mark':
      return `${index}:mark:${step.eventId}`;
    case 'bridge':
      return `${index}:bridge:${step.bridgeId}`;
    case 'question':
      return `${index}:question:${step.concept}`;
    case 'outside':
      return `${index}:outside:${step.domain}`;
  }
}

const CORRECTION_LABEL: Record<EncounterFeedbackKind, string> = {
  less_like_this: 'Less like this',
  wrong_connection: 'Wrong connection',
};

/** What a correction will do, said before it is pressed. */
const CORRECTION_EFFECT: Record<EncounterFeedbackKind, string> = {
  less_like_this: `Shows you less of this route for ${ENCOUNTER_SUPPRESSION_DAYS} days. Nothing shared changes.`,
  wrong_connection: 'Hides this connection for you. The sources stay unchanged.',
};

/** What it did, said once the server has recorded it. */
const CORRECTED_TEXT: Record<EncounterFeedbackKind, string> = {
  less_like_this: `You will see less of this route for ${ENCOUNTER_SUPPRESSION_DAYS} days. Nothing shared changed.`,
  wrong_connection: 'This connection is hidden for you. The sources are unchanged.',
};

export interface WhatLedHereProps {
  view: Extract<WhyView, { status: 'open' }>;
  onCorrect: (kind: EncounterFeedbackKind) => void;
  onRetry: () => void;
}

export function WhatLedHere({ view, onCorrect, onRetry }: WhatLedHereProps) {
  const id = useId();
  const headingId = `${id}-heading`;
  const { availability, notice } = view;
  const confirmationRef = useRef<HTMLParagraphElement | null>(null);
  const correctedCount = view.corrected.length;
  // A recorded correction is no longer offered, so the button that was pressed disappears and the
  // browser drops focus to <body>. Hand it to the confirmation instead -- only when it was really
  // lost, never taken from wherever the reader has since moved it.
  useEffect(() => {
    if (correctedCount > 0 && (document.activeElement === null || document.activeElement === document.body)) confirmationRef.current?.focus();
  }, [correctedCount]);
  return (
    <section className="why-path" aria-labelledby={headingId} aria-busy={availability.status === 'loading'}>
      <h3 id={headingId}>What led here</h3>
      {availability.status === 'loading' && <p className="why-path-quiet">Reading what was recorded…</p>}
      {availability.status === 'unrecorded' && <p>This step was not chosen by the Composer, so there is no recorded path to show.</p>}
      {availability.status === 'failed' && (
        <>
          <p role="alert">The recorded path could not be read. {availability.message}</p>
          <button type="button" className="pill ghost" onClick={onRetry} aria-label="Try reading the recorded path again">
            Try again
          </button>
        </>
      )}
      {availability.status === 'loaded' && (
        <>
          <p className="why-family">
            <span className="why-family-code">{availability.why.family}</span> Chosen to {FAMILY_TEXT[availability.why.family]}.
          </p>
          {availability.why.evidence.length === 0 ? (
            <p>Nothing you did led here; it was offered so nothing in the library stays hidden.</p>
          ) : (
            <ol className="why-steps" aria-label="Recorded path">
              {availability.why.evidence.map((step, index) => (
                <li key={stepKey(step, index)}>{whyStepText(step)}</li>
              ))}
            </ol>
          )}
          <Corrections
            offered={availability.why.corrections.filter(kind => !view.corrected.includes(kind))}
            sending={view.sending}
            onCorrect={onCorrect}
            idPrefix={id}
          />
        </>
      )}
      {/* Always present, so a screen reader is already watching it when the confirmation arrives. */}
      <p role="status" className="why-notice" ref={confirmationRef} tabIndex={-1}>
        {notice?.kind === 'corrected' ? CORRECTED_TEXT[notice.correction] : ''}
      </p>
      {notice?.kind === 'no-route' && (
        <p role="alert" className="why-notice">
          This encounter has no route that can be corrected.
        </p>
      )}
      {notice?.kind === 'failed' && (
        <p role="alert" className="why-notice">
          “{CORRECTION_LABEL[notice.correction]}” could not be confirmed. {notice.message}
        </p>
      )}
    </section>
  );
}

function Corrections({
  offered,
  sending,
  onCorrect,
  idPrefix,
}: {
  offered: EncounterFeedbackKind[];
  sending: EncounterFeedbackKind | null;
  onCorrect: (kind: EncounterFeedbackKind) => void;
  idPrefix: string;
}) {
  if (offered.length === 0) return null;
  return (
    <div className="why-corrections" role="group" aria-label="Correct this route">
      {offered.map(kind => {
        const effectId = `${idPrefix}-${kind}-effect`;
        return (
          <div className="why-correction" key={kind}>
            <button type="button" className="pill ghost" onClick={() => onCorrect(kind)} disabled={sending !== null} aria-describedby={effectId}>
              {CORRECTION_LABEL[kind]}
            </button>
            <p id={effectId} className="why-correction-effect">
              {CORRECTION_EFFECT[kind]}
            </p>
          </div>
        );
      })}
      {sending !== null && <p className="why-path-quiet">Recording “{CORRECTION_LABEL[sending]}”…</p>}
    </div>
  );
}
