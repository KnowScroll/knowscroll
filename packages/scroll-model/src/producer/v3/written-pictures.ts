import type { IssueV3 } from '../../v3/issues.js';
import type { Picture } from '../../v3/pictures.js';
import type { WrittenPictureV3 } from './written-schema.js';

/**
 * Stands in for an id the model's label did not resolve, so the picture is still complete enough for the validator to
 * run on and report everything else. The unresolved label has its own finding.
 */
export const UNKNOWN_ID = 'unknown-ref';

/** A picture built from what a model wrote, with the names its paragraphs may use for its parts. */
export interface BuiltPicture {
  readonly picture: Picture;
  /** Part label to id, for a paragraph's links and the `lit` of a state. On a repeated label the first part wins. */
  readonly parts: ReadonlyMap<string, string>;
  /** Region label to id, for the `region` of a state. */
  readonly regions: ReadonlyMap<string, string>;
  /**
   * Labels more than one grid cell carries ("Yes", "No"): a fine table, but a phrase or a `lit` cannot name such a cell,
   * so a reference to one is a finding at the reference.
   */
  readonly ambiguous: ReadonlySet<string>;
  /** Findings at `pictures.N…`: a repeated label, a reference to a part that is not there. */
  readonly issues: readonly IssueV3[];
}

/** A picture of one kind as the model wrote it, less the handles, which belong to the whole part. */
type Written<Kind extends WrittenPictureV3['kind']> = Omit<Extract<WrittenPictureV3, { kind: Kind }>, 'cites'>;

/** Labels of one picture, with the repeats they hide: two parts one phrase could name are a finding. */
class LabelBook {
  readonly parts = new Map<string, string>();
  readonly ambiguous = new Set<string>();
  readonly issues: IssueV3[] = [];
  constructor(private readonly base: string) {}

  /**
   * Names a grid cell. Cells may repeat a text, as a table's cells often do, so a repeat is no finding here: the text no
   * longer names one part, and only a reference to it is refused.
   */
  nameCell(text: string, id: string): string {
    if (this.ambiguous.has(text)) return id;
    if (this.parts.has(text)) {
      this.parts.delete(text);
      this.ambiguous.add(text);
    } else this.parts.set(text, id);
    return id;
  }

  /** Names a part: returns its id, and reports a label some other part of this picture already has. */
  name(label: string, id: string, field: string): string {
    if (this.parts.has(label)) this.issues.push({ code: 'picture_label_duplicate', path: `${this.base}.${field}` });
    else this.parts.set(label, id);
    return id;
  }

  /** The id a reference names in `scope` (a group of parts of one role), or a finding at `field`. */
  ref(scope: ReadonlyMap<string, string>, label: string, field: string): string {
    const id = scope.get(label);
    if (id === undefined) this.issues.push({ code: 'picture_ref_unknown', path: `${this.base}.${field}` });
    return id ?? UNKNOWN_ID;
  }
}

/** The first part of a role to carry a label, as the role's own scope. */
function scopeOf(entries: readonly { readonly label: string; readonly id: string }[]): Map<string, string> {
  const scope = new Map<string, string>();
  for (const { label, id } of entries) if (!scope.has(label)) scope.set(label, id);
  return scope;
}

/** An item with the id its position gives it; `field` is where the label sits, so a repeat is found there. */
function items<Entry extends { readonly label: string }>(
  book: LabelBook,
  list: readonly Entry[],
  idOf: (index: number) => string,
  field: string,
): (Entry & { readonly id: string })[] {
  return list.map((entry, index) => ({
    ...entry,
    id: book.name(entry.label, idOf(index), `${field}.${index}.label`),
  }));
}

function grid(written: Written<'grid'>, pid: string, book: LabelBook) {
  const rows = written.rows.map((row, index) => ({
    ...row,
    id: book.name(row.label, `${pid}-r${index + 1}`, `rows.${index}.label`),
  }));
  const columns = written.columns.map((column, index) => ({
    ...column,
    id: book.name(column.label, `${pid}-k${index + 1}`, `columns.${index}.label`),
  }));
  const rowScope = scopeOf(rows);
  const columnScope = scopeOf(columns);
  const cells = written.cells.map(({ row, column, text, ...rest }, index) => ({
    id: book.nameCell(text, `${pid}-x${index + 1}`),
    row: book.ref(rowScope, row, `cells.${index}.row`),
    column: book.ref(columnScope, column, `cells.${index}.column`),
    text,
    ...rest,
  }));
  return { rows, columns, cells };
}

function chart(written: Written<'chart'>, pid: string, book: LabelBook) {
  const points = written.points.map((point, index) => ({
    ...point,
    id: book.name(point.label, `${pid}-v${index + 1}`, `points.${index}.label`),
  }));
  const scope = scopeOf(points);
  const marks = written.marks.map((mark, index) => ({
    ...mark,
    point: book.ref(scope, mark.point, `marks.${index}.point`),
  }));
  return { points, marks };
}

function plan(written: Written<'plan'>, pid: string, book: LabelBook) {
  const ways = written.ways.map((way, index) => {
    const id = `${pid}-w${index + 1}`;
    return { ...way, id: way.label === undefined ? id : book.name(way.label, id, `ways.${index}.label`) };
  });
  const places = items(book, written.places, (index) => `${pid}-l${index + 1}`, 'places');
  const placeScope = scopeOf(places);
  const regions = written.regions.map((region, index) => ({
    id: book.name(region.label, `${pid}-g${index + 1}`, `regions.${index}.label`),
    label: region.label,
    nearest: book.ref(placeScope, region.nearest, `regions.${index}.nearest`),
    among: region.among.map((label, among) => book.ref(placeScope, label, `regions.${index}.among.${among}`)),
  }));
  const routes = written.routes.map(({ label, from, to }, index) => {
    const id = `${pid}-t${index + 1}`;
    return {
      id: label === undefined ? id : book.name(label, id, `routes.${index}.label`),
      ...(label === undefined ? {} : { label }),
      from: book.ref(placeScope, from, `routes.${index}.from`),
      to: book.ref(placeScope, to, `routes.${index}.to`),
    };
  });
  return { ways, places, regions, routes };
}

/** The picture itself, with ids assigned. Each builder names its parts in the order `partIds` lists them. */
function pictureOf(written: WrittenPictureV3, pid: string, book: LabelBook): Picture {
  const { cites: _cites, ...own } = written;
  switch (own.kind) {
    case 'statement': {
      const body = own.statement;
      if (body.form === 'list')
        return {
          ...own,
          id: pid,
          statement: { ...body, items: items(book, body.items, (i) => `${pid}-i${i + 1}`, 'statement.items') },
        };
      const part = body.form === 'number' ? 'value' : 'quote';
      book.name(part, part, 'statement');
      return { ...own, id: pid, statement: body };
    }
    case 'flow':
      return { ...own, id: pid, steps: items(book, own.steps, (i) => `${pid}-s${i + 1}`, 'steps') };
    case 'cycle': {
      const { centre, ...ring } = own;
      return {
        ...ring,
        id: pid,
        ...(centre === undefined
          ? {}
          : { centre: { ...centre, id: book.name(centre.label, `${pid}-c`, 'centre.label') } }),
        items: items(book, ring.items, (i) => `${pid}-i${i + 1}`, 'items'),
      };
    }
    case 'grid':
      return { ...own, id: pid, ...grid(own, pid, book) };
    case 'chart':
      return { ...own, id: pid, ...chart(own, pid, book) };
    case 'plan':
      return { ...own, id: pid, ...plan(own, pid, book) };
  }
}

/**
 * A model's picture as the document's: ids assigned by position (`p2`; a flow's steps `p2-s1`, a ring's items `p2-i1`
 * and its centre `p2-c`, a grid's rows `p2-r1`, columns `p2-k1` and cells `p2-x1`, a chart's points `p2-v1`, a plan's
 * ways `p2-w1`, places `p2-l1`, regions `p2-g1` and routes `p2-t1`), and every reference by label turned into an id.
 * `number` counts from 1, as a paragraph's `show.picture` does. A statement `number` has the one part `value` and a
 * statement `quote` the one part `quote`, the ids `partIds` gives them.
 */
export function buildPicture(written: WrittenPictureV3, number: number): BuiltPicture {
  const book = new LabelBook(`pictures.${number - 1}`);
  const picture = pictureOf(written, `p${number}`, book);
  const regions = picture.kind === 'plan' ? scopeOf(picture.regions) : new Map<string, string>();
  return { picture, parts: book.parts, regions, ambiguous: book.ambiguous, issues: book.issues };
}
