import type { Journey, JourneyStep } from './journey.js';

const COLUMN_STAGE = 30;

function clock(date: Date): string {
  return date.toISOString().slice(11, 23);
}

function durationOf(step: JourneyStep): string {
  if (step.endedAt === null) return '';
  const seconds = (step.endedAt.getTime() - step.at.getTime()) / 1000;
  return `+${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
}

function lineOf(step: JourneyStep): string {
  const detail = [step.state, step.code, step.label, step.count === null ? null : `n=${step.count}`]
    .filter((part) => part !== null)
    .join(' ');
  return [
    clock(step.at),
    step.scope === 'shared' ? 'shared  ' : 'personal',
    step.stage.padEnd(COLUMN_STAGE),
    detail,
    durationOf(step),
    step.ref ?? '',
  ]
    .filter((part) => part !== '')
    .join('  ');
}

/**
 * A journey as readable lines for the operator's terminal: a header, one line per step (time of
 * day, whose record it is, stage, state, code, label, duration, record ID), then the gaps. It
 * prints only what the journey carries: IDs, codes, counts and times.
 */
export function renderJourney(journey: Journey): string {
  const first = journey.steps[0];
  const lines = [
    `journey ${journey.subject} ${journey.subjectId} (${journey.steps.length} steps${
      first === undefined ? '' : `, from ${first.at.toISOString().slice(0, 10)}`
    })`,
    ...journey.steps.map(lineOf),
    ...journey.gaps.map((gap) => `gap  ${gap.stage}${gap.ref === null ? '' : ` ${gap.ref}`}: ${gap.note}`),
  ];
  if (journey.truncated) lines.push('Only the newest steps are shown.');
  return lines.join('\n');
}
