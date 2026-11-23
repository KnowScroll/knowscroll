import { canonicalJson } from '../canonical.js';
import type { Control, Show } from './document.js';
import type { IssueV3 } from './issues.js';
import { STATE_KEYS, type PlanCell, type Picture, type PictureState, type Tone } from './pictures.js';

/**
 * The rules of each picture kind that are not shape: which parts it names, which items a state or a control walks, and
 * whether its data and a state hang together. Pure; shared by the validator, the reader and the server, so a picture
 * means the same thing wherever it is read.
 */

/** One item a state can light, a scrub can reach or a pick can choose, in the picture's own order. */
export interface PictureItemView {
  readonly id: string;
  readonly label: string;
  readonly note?: string | undefined;
  readonly tone?: Tone | undefined;
}

/** The items of a picture in its own order: a flow's steps, a ring's items, a grid's cells by row, a chart's points, a plan's places. */
export function orderedItems(picture: Picture): readonly PictureItemView[] {
  switch (picture.kind) {
    case 'statement':
      return picture.statement.form === 'list' ? picture.statement.items : [];
    case 'flow':
      return picture.steps;
    case 'cycle':
      return picture.items;
    case 'grid': {
      const rowLabel = new Map(picture.rows.map((row) => [row.id, row.label]));
      const columnLabel = new Map(picture.columns.map((column) => [column.id, column.label]));
      const rowOrder = new Map(picture.rows.map((row, index) => [row.id, index]));
      const columnOrder = new Map(picture.columns.map((column, index) => [column.id, index]));
      return [...picture.cells]
        .sort(
          (a, b) =>
            (rowOrder.get(a.row) ?? 0) - (rowOrder.get(b.row) ?? 0) ||
            (columnOrder.get(a.column) ?? 0) - (columnOrder.get(b.column) ?? 0),
        )
        .map((cell) => ({
          id: cell.id,
          label: `${rowLabel.get(cell.row) ?? cell.row}, ${columnLabel.get(cell.column) ?? cell.column}`,
          note: cell.note,
          tone: cell.tone,
        }));
    }
    case 'chart':
      return picture.points;
    case 'plan':
      return picture.places;
  }
}

/** How many things `upTo` counts for a kind: steps, ring items, grid rows or chart points. Zero where it does not apply. */
export function revealCount(picture: Picture): number {
  switch (picture.kind) {
    case 'flow':
      return picture.steps.length;
    case 'cycle':
      return picture.items.length;
    case 'grid':
      return picture.rows.length;
    case 'chart':
      return picture.points.length;
    case 'statement':
    case 'plan':
      return 0;
  }
}

/** Every id a linked phrase may name and a state may light, in the picture's own order. */
export function partIds(picture: Picture): readonly string[] {
  switch (picture.kind) {
    case 'statement':
      return picture.statement.form === 'list'
        ? picture.statement.items.map((item) => item.id)
        : [picture.statement.form === 'number' ? 'value' : 'quote'];
    case 'flow':
      return picture.steps.map((step) => step.id);
    case 'cycle':
      return [...(picture.centre === undefined ? [] : [picture.centre.id]), ...picture.items.map((item) => item.id)];
    case 'grid':
      return [
        ...picture.rows.map((row) => row.id),
        ...picture.columns.map((column) => column.id),
        ...picture.cells.map((cell) => cell.id),
      ];
    case 'chart':
      return picture.points.map((point) => point.id);
    case 'plan':
      return [
        ...picture.ways.map((way) => way.id),
        ...picture.places.map((place) => place.id),
        ...picture.regions.map((region) => region.id),
        ...picture.routes.map((route) => route.id),
      ];
  }
}

const duplicates = (ids: readonly string[]): boolean => new Set(ids).size !== ids.length;

const inside = (cell: PlanCell, size: { readonly columns: number; readonly rows: number }): boolean =>
  cell.column < size.columns && cell.row < size.rows;

function gridIssues(picture: Extract<Picture, { kind: 'grid' }>, path: string): IssueV3[] {
  const issues: IssueV3[] = [];
  const rows = new Set(picture.rows.map((row) => row.id));
  const columns = new Set(picture.columns.map((column) => column.id));
  const taken = new Set<string>();
  picture.cells.forEach((cell, index) => {
    if (!rows.has(cell.row) || !columns.has(cell.column))
      issues.push({ code: 'picture_ref_unknown', path: `${path}.cells.${index}` });
    const key = `${cell.row}/${cell.column}`;
    if (taken.has(key)) issues.push({ code: 'picture_cell_taken', path: `${path}.cells.${index}` });
    taken.add(key);
  });
  return issues;
}

/** A value as a number: thousands commas dropped. `FigureText` has already admitted the form. */
export function figureValue(text: string): number {
  return Number(text.replaceAll(',', ''));
}

function chartIssues(picture: Extract<Picture, { kind: 'chart' }>, path: string): IssueV3[] {
  const issues: IssueV3[] = [];
  const points = new Set(picture.points.map((point) => point.id));
  picture.marks.forEach((mark, index) => {
    if (!points.has(mark.point)) issues.push({ code: 'picture_ref_unknown', path: `${path}.marks.${index}.point` });
  });
  // A bar grows from zero, so a negative bar has no length to draw; a line can dip below zero.
  if (picture.form === 'bars')
    picture.points.forEach((point, index) => {
      if (figureValue(point.value) < 0)
        issues.push({ code: 'picture_value_invalid', path: `${path}.points.${index}.value` });
    });
  return issues;
}

function planIssues(picture: Extract<Picture, { kind: 'plan' }>, path: string): IssueV3[] {
  const issues: IssueV3[] = [];
  const { size } = picture;
  picture.ways.forEach((way, index) => {
    if (!inside(way.from, size) || !inside(way.to, size))
      issues.push({ code: 'picture_cell_outside', path: `${path}.ways.${index}` });
    const straight = way.from.row === way.to.row || way.from.column === way.to.column;
    const someLength = way.from.row !== way.to.row || way.from.column !== way.to.column;
    if (!straight || !someLength) issues.push({ code: 'picture_way_bent', path: `${path}.ways.${index}` });
  });
  const occupied = new Set<string>();
  picture.places.forEach((place, index) => {
    if (!inside(place.at, size)) issues.push({ code: 'picture_cell_outside', path: `${path}.places.${index}.at` });
    const key = `${place.at.column}/${place.at.row}`;
    if (occupied.has(key)) issues.push({ code: 'picture_cell_taken', path: `${path}.places.${index}.at` });
    occupied.add(key);
  });
  const steps = picture.steps?.length ?? 0;
  picture.tallies.forEach((tally, index) => {
    if (!inside(tally.at, size)) issues.push({ code: 'picture_cell_outside', path: `${path}.tallies.${index}.at` });
    if (tally.step === undefined) return;
    if (steps === 0) issues.push({ code: 'picture_steps_missing', path: `${path}.steps` });
    else if (tally.step >= steps) issues.push({ code: 'picture_tally_step_invalid', path: `${path}.tallies.${index}` });
  });
  const places = new Set(picture.places.map((place) => place.id));
  picture.regions.forEach((region, index) => {
    if (
      !region.among.includes(region.nearest) ||
      duplicates(region.among) ||
      region.among.some((place) => !places.has(place))
    )
      issues.push({ code: 'picture_region_invalid', path: `${path}.regions.${index}` });
  });
  picture.routes.forEach((route, index) => {
    if (!places.has(route.from) || !places.has(route.to) || route.from === route.to)
      issues.push({ code: 'picture_ref_unknown', path: `${path}.routes.${index}` });
  });
  return issues;
}

/**
 * Whether a picture's data hangs together: its ids are unique, everything it refers to exists, a plan's cells are on
 * the plan and its ways are straight, a bar is not negative. `path` is the picture's own path in the document.
 */
export function pictureDataIssues(picture: Picture, path: string): IssueV3[] {
  const issues: IssueV3[] = duplicates(partIds(picture)) ? [{ code: 'picture_ids_duplicate', path }] : [];
  switch (picture.kind) {
    case 'grid':
      return [...issues, ...gridIssues(picture, path)];
    case 'chart':
      return [...issues, ...chartIssues(picture, path)];
    case 'plan':
      return [...issues, ...planIssues(picture, path)];
    case 'statement':
    case 'flow':
    case 'cycle':
      return issues;
  }
}

/**
 * Whether a state is one this picture can be in: only the keys its kind understands, `upTo` within its items, lit ids
 * that are its parts, a plan's step within its steps and a region it declares. Every problem is `show_state_invalid`
 * at `path`.
 */
export function pictureStateIssues(picture: Picture, state: PictureState, path: string): IssueV3[] {
  const allowed: readonly string[] = STATE_KEYS[picture.kind];
  const parts = new Set(partIds(picture));
  const keys = Object.keys(state) as (keyof PictureState)[];
  const valid =
    keys.every((key) => allowed.includes(key)) &&
    (state.upTo === undefined || state.upTo <= revealCount(picture)) &&
    (state.lit === undefined || (state.lit.every((id) => parts.has(id)) && !duplicates(state.lit))) &&
    (state.step === undefined || (picture.kind === 'plan' && state.step < (picture.steps?.length ?? 0))) &&
    (state.region === undefined ||
      (picture.kind === 'plan' && picture.regions.some((region) => region.id === state.region)));
  return valid ? [] : [{ code: 'show_state_invalid', path }];
}

/** One stop of a scrub: what its tap alternative is called and the state it shows. */
export interface ScrubPosition {
  readonly label: string;
  readonly state: PictureState;
}

/** The 1-based place of an item in what `upTo` reveals (a grid's cell by its row), or undefined where `upTo` counts nothing or the id is no item. */
function revealPlace(picture: Picture, itemId: string): number | undefined {
  switch (picture.kind) {
    case 'flow':
    case 'cycle':
    case 'chart': {
      const at = orderedItems(picture).findIndex((item) => item.id === itemId);
      return at < 0 ? undefined : at + 1;
    }
    case 'grid': {
      const cell = picture.cells.find((each) => each.id === itemId);
      const row = cell === undefined ? -1 : picture.rows.findIndex((each) => each.id === cell.row);
      return row < 0 ? undefined : row + 1;
    }
    case 'statement':
    case 'plan':
      return undefined;
  }
}

/**
 * The state a control gives when it lights one item: the beat's state with that item lit, and revealed. A lit item that
 * `upTo` has not reached is drawn as nothing, so a chip that lit it would change nothing a reader can see; the state
 * raises `upTo` to the item's place instead. With no `upTo` everything is revealed already, and a state that
 * reveals more than the item's place is kept. Shared by the scrub along items and the pick, so they cannot drift. Pure.
 */
export function lightItem(picture: Picture, base: PictureState, itemId: string): PictureState {
  const place = revealPlace(picture, itemId);
  const raised = place !== undefined && base.upTo !== undefined && base.upTo < place ? { upTo: place } : {};
  return { ...base, ...raised, lit: [itemId] };
}

/**
 * Where a scrub can go, from the beat's own state. `steps`: a plan's steps, or the picture's items revealed one more at
 * a time. `items`: the picture's items lit one at a time, each revealed if the beat's `upTo` had not reached it (`lightItem`). A scrub needs two positions or it has nowhere to go.
 */
export function scrubPositions(
  picture: Picture,
  base: PictureState,
  along: 'steps' | 'items',
): readonly ScrubPosition[] {
  if (along === 'items')
    return orderedItems(picture).map((item) => ({ label: item.label, state: lightItem(picture, base, item.id) }));
  if (picture.kind === 'plan') return (picture.steps ?? []).map((label, step) => ({ label, state: { ...base, step } }));
  const count = revealCount(picture);
  const labels =
    picture.kind === 'grid' ? picture.rows.map((row) => row.label) : orderedItems(picture).map((item) => item.label);
  return Array.from({ length: count }, (_, index) => ({
    label: labels[index] ?? String(index + 1),
    state: { ...base, upTo: index + 1 },
  }));
}

/** The items a `pick` offers: those with a note to read. */
export function pickItems(picture: Picture): readonly PictureItemView[] {
  return orderedItems(picture).filter((item) => item.note !== undefined);
}

/**
 * Whether a control fits the picture its beat shows: a scrub with two places to go, a switch to a different state the
 * picture can be in, a pick of at least two items with notes. Each problem is `control_unfit` at `path`.
 */
export function controlIssues(picture: Picture, control: Control, show: Show, path: string): IssueV3[] {
  const unfit: IssueV3[] = [{ code: 'control_unfit', path }];
  switch (control.kind) {
    case 'scrub':
      return scrubPositions(picture, show.state, control.along).length >= 2 ? [] : unfit;
    case 'switch':
      return pictureStateIssues(picture, control.to, `${path}.to`).length === 0 &&
        canonicalJson(control.to) !== canonicalJson(show.state)
        ? []
        : unfit;
    case 'pick':
      return pickItems(picture).length >= 2 ? [] : unfit;
  }
}
