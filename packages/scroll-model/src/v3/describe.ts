import { revealCount } from './picture-rules.js';
import type { Picture, PictureOfKind, PictureState } from './pictures.js';

/** The most characters the text version of a picture may have: a screen reader's patience, and the room of a cover's alt text. */
export const DESCRIPTION_MAX_CHARS = 600;

/** What a reader is told about a part that stands out: its name, and the note to read after it. */
interface NamedPart {
  readonly label: string;
  readonly note?: string | undefined;
}

/** Ends a sentence with a full stop unless it already ends with one (or with a closing quote or bracket after one). */
const withStop = (text: string): string => (/[.!?…]["”’)]?$/u.test(text) ? text : `${text}.`);

const countOf = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** "A", "A or B", "A, B or C". */
function joinWithOr(labels: readonly string[]): string {
  const last = labels[labels.length - 1] ?? '';
  return labels.length < 2 ? last : `${labels.slice(0, -1).join(', ')} or ${last}`;
}

/** A figure with its unit: a unit that opens with a letter stands apart ("12 hours"), a sign sticks ("93.6%"). */
const figureWithUnit = (value: string, unit: string | undefined): string =>
  unit === undefined ? value : /^\p{L}/u.test(unit) ? `${value} ${unit}` : `${value}${unit}`;

/** How many of a picture's reveal-counted things the state draws. */
function drawnCount(picture: Picture, state: PictureState): number {
  const total = revealCount(picture);
  return state.upTo === undefined ? total : Math.min(total, state.upTo);
}

function statementSentences(picture: PictureOfKind<'statement'>): string[] {
  const body = picture.statement;
  switch (body.form) {
    case 'number':
      return [withStop(`${body.label}: ${body.value}`)];
    case 'quote': {
      const cite = [body.who, body.work, body.year].filter((part) => part !== undefined).join(', ');
      return [withStop(`“${body.text}” — ${cite}`)];
    }
    case 'list':
      return [withStop(`The list: ${body.items.map((item) => item.label).join(', ')}`)];
  }
}

function flowSentences(picture: PictureOfKind<'flow'>, state: PictureState): string[] {
  const steps = picture.steps.slice(0, drawnCount(picture, state));
  return [withStop(steps.map((step) => step.label).join(', then '))];
}

function cycleSentences(picture: PictureOfKind<'cycle'>, state: PictureState): string[] {
  const count = drawnCount(picture, state);
  const labels = picture.items.slice(0, count).map((item) => item.label);
  // The ring only closes once every item is drawn; before that the last drawn one leads nowhere yet.
  const closed = count === picture.items.length ? `, and back to ${labels[0] ?? ''}` : '';
  const lead = picture.centre === undefined ? 'Around the ring, in order' : 'Around it, in order';
  return [
    ...(picture.centre === undefined ? [] : [withStop(`At the centre: ${picture.centre.label}`)]),
    withStop(`${lead}: ${labels.join(', ')}${closed}`),
  ];
}

function gridSentences(picture: PictureOfKind<'grid'>, state: PictureState): string[] {
  return picture.rows.slice(0, drawnCount(picture, state)).map((row) => {
    const cells = picture.columns.flatMap((column) =>
      picture.cells
        .filter((cell) => cell.row === row.id && cell.column === column.id)
        .map((cell) => `${column.label} ${cell.text}`),
    );
    return withStop(`${row.label}: ${cells.length === 0 ? 'nothing' : cells.join('; ')}`);
  });
}

function chartSentences(picture: PictureOfKind<'chart'>, state: PictureState): string[] {
  const points = picture.points.slice(0, drawnCount(picture, state));
  const drawn = new Map(points.map((point) => [point.id, point.label]));
  // The picture may print no numbers, but the words always do: they are the accessible equivalent.
  return [
    picture.form === 'bars' ? 'Bar chart.' : 'Line chart.',
    ...points.map((point) => withStop(`${point.label}: ${figureWithUnit(point.value, picture.unit)}`)),
    ...picture.marks.flatMap((mark) => {
      const pointLabel = drawn.get(mark.point);
      return pointLabel === undefined ? [] : [withStop(`Marked: ${pointLabel}, ${mark.label}`)];
    }),
  ];
}

/** The tallies a plan has drawn at a state: those with no step, or arriving at or before it. */
function talliesDrawn(picture: PictureOfKind<'plan'>, state: PictureState): number {
  return picture.tallies
    .filter((tally) => tally.step === undefined || state.step === undefined || tally.step <= state.step)
    .reduce((total, tally) => total + tally.count, 0);
}

function planSentences(picture: PictureOfKind<'plan'>, state: PictureState): string[] {
  const placeLabel = (id: string): string => picture.places.find((place) => place.id === id)?.label ?? id;
  const namedWays = picture.ways.flatMap((way) => (way.label === undefined ? [] : [way.label]));
  const unnamedWays = picture.ways.length - namedWays.length;
  const wayNames = [...namedWays, ...(unnamedWays > 0 ? [`${countOf(unnamedWays, 'way')} without a name`] : [])];
  const stepLabel = state.step === undefined ? undefined : (picture.steps?.[state.step] ?? `step ${state.step + 1}`);
  const marks = countOf(talliesDrawn(picture, state), 'mark');
  const region = picture.regions.find((candidate) => candidate.id === state.region);
  const others = region?.among.filter((id) => id !== region.nearest).map(placeLabel) ?? [];
  return [
    withStop(`Places: ${picture.places.map((place) => place.label).join(', ')}`),
    ...(wayNames.length === 0 ? [] : [withStop(`Ways: ${wayNames.join(', ')}`)]),
    ...(picture.tallies.length === 0 ? [] : [withStop(stepLabel === undefined ? `${marks} in all` : `By ${stepLabel}: ${marks}`)]),
    ...(region === undefined
      ? []
      : [
          withStop(
            `Shaded: ${region.label}, the part of the plan nearer to ${placeLabel(region.nearest)} than to ${joinWithOr(others)}`,
          ),
        ]),
    ...picture.routes.map((route) =>
      withStop(
        `A route runs from ${placeLabel(route.from)} to ${placeLabel(route.to)}${route.label === undefined ? '' : ` (${route.label})`}`,
      ),
    ),
  ];
}

function statementParts(picture: PictureOfKind<'statement'>): ReadonlyMap<string, NamedPart> {
  const body = picture.statement;
  switch (body.form) {
    case 'number':
      return new Map([['value', { label: body.label }]]);
    case 'quote':
      return new Map([['quote', { label: 'the quotation' }]]);
    case 'list':
      return new Map(body.items.map((item) => [item.id, item]));
  }
}

/** The parts of a picture the state draws, by id: what a lit id can name. Mirrors `partIds`, less what is still waiting. */
function drawnParts(picture: Picture, state: PictureState): ReadonlyMap<string, NamedPart> {
  const count = drawnCount(picture, state);
  switch (picture.kind) {
    case 'statement':
      return statementParts(picture);
    case 'flow':
      return new Map(picture.steps.slice(0, count).map((step) => [step.id, step]));
    case 'cycle':
      return new Map([
        ...(picture.centre === undefined ? [] : [[picture.centre.id, picture.centre] as const]),
        ...picture.items.slice(0, count).map((item) => [item.id, item] as const),
      ]);
    case 'grid': {
      const rows = picture.rows.slice(0, count);
      const rowLabel = new Map(rows.map((row) => [row.id, row.label]));
      const columnLabel = new Map(picture.columns.map((column) => [column.id, column.label]));
      return new Map<string, NamedPart>([
        ...rows.map((row) => [row.id, row] as const),
        ...picture.columns.map((column) => [column.id, column] as const),
        ...picture.cells.flatMap((cell) => {
          const row = rowLabel.get(cell.row);
          return row === undefined
            ? []
            : [[cell.id, { label: `${row}, ${columnLabel.get(cell.column) ?? cell.column}`, note: cell.note }] as const];
        }),
      ]);
    }
    case 'chart':
      return new Map(picture.points.slice(0, count).map((point) => [point.id, point]));
    case 'plan':
      return new Map<string, NamedPart>([
        ...picture.ways.map((way) => [way.id, { label: way.label ?? 'a way' }] as const),
        ...picture.places.map((place) => [place.id, place] as const),
        ...picture.regions.map((region) => [region.id, region] as const),
        ...picture.routes.map((route) => [route.id, { label: route.label ?? 'a route' }] as const),
      ]);
  }
}

/** The sentences for what stands out: the names first, then the note of each that has one. */
function litSentences(picture: Picture, state: PictureState): string[] {
  const parts = drawnParts(picture, state);
  const lit = (state.lit ?? []).flatMap((id) => {
    const part = parts.get(id);
    return part === undefined ? [] : [part];
  });
  if (lit.length === 0) return [];
  const notes = lit.flatMap((part) =>
    part.note === undefined ? [] : [withStop(lit.length === 1 ? part.note : `${part.label}: ${part.note}`)],
  );
  return [withStop(`Standing out: ${lit.map((part) => part.label).join(', ')}`), ...notes];
}

function bodySentences(picture: Picture, state: PictureState): string[] {
  switch (picture.kind) {
    case 'statement':
      return statementSentences(picture);
    case 'flow':
      return flowSentences(picture, state);
    case 'cycle':
      return cycleSentences(picture, state);
    case 'grid':
      return gridSentences(picture, state);
    case 'chart':
      return chartSentences(picture, state);
    case 'plan':
      return planSentences(picture, state);
  }
}

/** Joins sentences, and when they pass the bound keeps whole sentences from the start and ends with an ellipsis. */
function fitSentences(sentences: readonly string[]): string {
  const whole = sentences.join(' ');
  if (whole.length <= DESCRIPTION_MAX_CHARS) return whole;
  const budget = DESCRIPTION_MAX_CHARS - 1;
  const kept: string[] = [];
  let length = 0;
  for (const sentence of sentences) {
    const next = length + (kept.length === 0 ? 0 : 1) + sentence.length;
    if (next > budget) break;
    kept.push(sentence);
    length = next;
  }
  const text = kept.length === 0 ? (sentences[0] ?? '').slice(0, budget) : kept.join(' ');
  return `${text.endsWith('.') ? text.slice(0, -1) : text}…`;
}

/**
 * The text version of a picture in a state: plain sentences derived from the picture's data alone, never from a
 * document's prose. It is what a screen reader hears, what the Text chip shows and a cover's alt text, so it says only
 * what the state draws (items still waiting are left out), names what stands out, and states every value even when the
 * picture prints none. It starts with the title, ends with the caption when there is one, is pure and carries no
 * locale-dependent formatting. A text longer than {@link DESCRIPTION_MAX_CHARS} is cut at a sentence boundary and ends
 * with an ellipsis.
 *
 * @param picture a picture as the document declares it
 * @param state the state a beat shows it in; an empty state shows the whole picture
 */
export function describePicture(picture: Picture, state: PictureState): string {
  return fitSentences([
    withStop(picture.title),
    ...bodySentences(picture, state),
    ...litSentences(picture, state),
    ...(picture.caption === undefined ? [] : [withStop(picture.caption)]),
  ]);
}
