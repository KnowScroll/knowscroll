import type { PictureOfKind, PictureState } from '@knowscroll/scroll-model';
import type { PictureBox, PictureScene, PictureShape } from '../scene';
import { labelSize, textWidth, wrapText } from '../text';
import { BOLD_SLACK, inner, isLit, itemOpacity, toneRole } from './common';

type StatementPicture = PictureOfKind<'statement'>;

/** The smallest text a statement is set in; below this it would stop being text. */
const SMALLEST = 9;
/** A line cap no content reaches: a statement shrinks to fit its lines rather than cutting them short. */
const ANY_LINES = 99;

/**
 * One number, as large as the box allows, with what it is under it. The label wraps without a cap and shrinks (to 9 px)
 * until the number keeps at least a third of the box's height or the number's own largest size.
 */
function numberShapes(
  body: Extract<StatementPicture['statement'], { form: 'number' }>,
  box: PictureBox,
): PictureShape[] {
  const room = inner(box);
  const wanted = Math.min(room.height * 0.5, (room.width / Math.max(1, textWidth(body.value, 1))) * 0.9);
  const needed = Math.min(wanted, room.height / 3);
  let label = labelSize(box.height, box.textScale) * 1.15;
  let labelLines = wrapText(body.label, room.width, label, ANY_LINES);
  const labelHeight = () => label * (1 + (labelLines.length - 1) * 1.3);
  while (label > SMALLEST && room.height - labelHeight() - label * 0.5 < needed) {
    label = Math.max(SMALLEST, label - 0.5);
    labelLines = wrapText(body.label, room.width, label, ANY_LINES);
  }
  const valueSize = Math.max(0, Math.min(wanted, room.height - labelHeight() - label * 0.5));
  const block = valueSize + label * 0.5 + labelHeight();
  const top = room.y + Math.max(0, (room.height - block) / 2);
  return [
    {
      type: 'text',
      key: 'value',
      part: 'value',
      x: box.width / 2,
      y: top + valueSize * 0.8,
      lines: [body.value],
      size: valueSize,
      lineHeight: valueSize,
      weight: 'bold',
      anchor: 'middle',
      fill: body.tone ?? 'ink',
      family: 'sans',
      opacity: 1,
    },
    {
      type: 'text',
      key: 'label',
      x: box.width / 2,
      y: top + valueSize + label * 0.5 + label * 0.8,
      lines: labelLines,
      size: label,
      lineHeight: label * 1.3,
      weight: 'regular',
      anchor: 'middle',
      fill: 'ink2',
      family: 'sans',
      opacity: 1,
    },
  ];
}

/**
 * One quotation in the essay's display face, with who said it, where and when under it. The quotation wraps without a
 * line cap and steps down (to 9 px) until its lines and the attribution's, which wraps too, fit the box.
 */
function quoteShapes(body: Extract<StatementPicture['statement'], { form: 'quote' }>, box: PictureBox): PictureShape[] {
  const room = inner(box);
  const by = `— ${[body.who, body.work, body.year].filter((part): part is string => part !== undefined).join(', ')}`;
  const small = labelSize(box.height, box.textScale);
  const quotation = `“${body.text}”`;
  const setAt = (size: number) => {
    const byTextSize = Math.min(small, size);
    const quoteLines = wrapText(quotation, room.width, size, ANY_LINES);
    const byLines = wrapText(by, room.width, byTextSize, ANY_LINES);
    const gap = Math.max(4, byTextSize * 0.6);
    const height =
      size + (quoteLines.length - 1) * size * 1.25 + gap + byTextSize + (byLines.length - 1) * byTextSize * 1.2;
    return { size, byTextSize, quoteLines, byLines, gap, height };
  };
  let set = setAt(Math.min(22 * box.textScale, room.height / 4));
  while (set.size > SMALLEST && set.height > room.height) set = setAt(Math.max(SMALLEST, set.size - 0.5));
  const top = room.y + Math.max(0, (room.height - set.height) / 2);
  const quoteBottom = top + set.size + (set.quoteLines.length - 1) * set.size * 1.25;
  return [
    {
      type: 'text',
      key: 'quote',
      part: 'quote',
      x: room.x,
      y: top + set.size * 0.8,
      lines: set.quoteLines,
      size: set.size,
      lineHeight: set.size * 1.25,
      weight: 'regular',
      anchor: 'start',
      fill: 'ink',
      family: 'serif',
      opacity: 1,
    },
    {
      type: 'text',
      key: 'by',
      x: room.x,
      y: quoteBottom + set.gap + set.byTextSize * 0.8,
      lines: set.byLines,
      size: set.byTextSize,
      lineHeight: set.byTextSize * 1.2,
      weight: 'regular',
      anchor: 'start',
      fill: 'ink2',
      family: 'sans',
      opacity: 1,
    },
  ];
}

/** How a list is set at a size: each label's lines, wrapped as if bold so a lit label never wraps differently. */
function listSet(items: readonly { readonly label: string }[], size: number, room: ReturnType<typeof inner>) {
  const width = room.width - size * 1.3;
  const lines = items.map((item) => wrapText(item.label, width / BOLD_SLACK, size, ANY_LINES));
  const natural = lines.map((own) => own.length * size * 1.2 + size * 0.8);
  return { size, lines, natural };
}

/**
 * A short list, one item a row, a mark beside each; a lit item is marked and the rest recede. A row is as tall as the
 * lines its label wraps to need, and the size steps down (to 9 px) until every row fits the box.
 */
function listShapes(
  body: Extract<StatementPicture['statement'], { form: 'list' }>,
  state: PictureState,
  box: PictureBox,
): PictureShape[] {
  const room = inner(box);
  const total = (rows: readonly number[]) => rows.reduce((sum, height) => sum + height, 0);
  let set = listSet(body.items, labelSize(box.height, box.textScale) * 1.2, room);
  while (set.size > SMALLEST && total(set.natural) > room.height)
    set = listSet(body.items, Math.max(SMALLEST, set.size - 0.5), room);
  const size = set.size;
  // Rows of one line keep an even rhythm; a row that wraps takes the room its lines need.
  const even = Math.min(room.height / body.items.length, size * 3.2);
  const spacious = set.natural.map((height) => Math.max(height, even));
  const rows = total(spacious) <= room.height ? spacious : set.natural;
  const top = room.y + Math.max(0, (room.height - total(rows)) / 2);
  return body.items.flatMap((item, index): PictureShape[] => {
    const lines = set.lines[index] ?? [];
    const start = top + total(rows.slice(0, index));
    const middle = start + (rows[index] ?? 0) / 2;
    const opacity = itemOpacity(state, item.id);
    const lit = isLit(state, item.id);
    return [
      {
        type: 'circle',
        key: `${item.id}-mark`,
        part: item.id,
        cx: room.x + size * 0.4,
        cy: middle,
        r: size * (lit ? 0.4 : 0.28),
        fill: lit ? 'mark' : toneRole(item.tone),
        stroke: 'none',
        strokeWidth: 0,
        opacity,
      },
      {
        type: 'text',
        key: `${item.id}-label`,
        part: item.id,
        x: room.x + size * 1.3,
        y: middle - ((lines.length - 1) * size * 1.2) / 2 + size * 0.35,
        lines,
        size,
        lineHeight: size * 1.2,
        weight: lit ? 'bold' : 'regular',
        anchor: 'start',
        fill: 'ink',
        family: 'sans',
        opacity,
      },
    ];
  });
}

/** A typographic picture (decision D1): the one kind every Scroll can have, whatever its subject. */
export function layoutStatement(picture: StatementPicture, state: PictureState, box: PictureBox): PictureScene {
  const body = picture.statement;
  const shapes =
    body.form === 'number'
      ? numberShapes(body, box)
      : body.form === 'quote'
        ? quoteShapes(body, box)
        : listShapes(body, state, box);
  return { pictureId: picture.id, width: box.width, height: box.height, shapes };
}
