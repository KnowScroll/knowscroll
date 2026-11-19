import type { PictureOfKind, PictureState } from '@knowscroll/scroll-model';
import type { PictureBox, PictureScene, PictureShape } from '../scene';
import { labelSize, textWidth, wrapText } from '../text';
import { inner, isLit, itemOpacity, toneRole } from './common';

type StatementPicture = PictureOfKind<'statement'>;

/** One number, as large as the box allows, with what it is under it. */
function numberShapes(
  body: Extract<StatementPicture['statement'], { form: 'number' }>,
  box: PictureBox,
): PictureShape[] {
  const room = inner(box);
  const label = labelSize(box.height, box.textScale) * 1.15;
  const labelLines = wrapText(body.label, room.width, label, 2);
  const valueSize = Math.min(room.height * 0.5, (room.width / Math.max(1, textWidth(body.value, 1))) * 0.9);
  const block = valueSize + labelLines.length * label * 1.3 + label;
  const top = room.y + (room.height - block) / 2 + valueSize * 0.85;
  return [
    {
      type: 'text',
      key: 'value',
      part: 'value',
      x: box.width / 2,
      y: top,
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
      y: top + label * 1.6,
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

/** One quotation in the essay's display face, with who said it, where and when under it. */
function quoteShapes(body: Extract<StatementPicture['statement'], { form: 'quote' }>, box: PictureBox): PictureShape[] {
  const room = inner(box);
  const by = [body.who, body.work, body.year].filter((part): part is string => part !== undefined).join(', ');
  const small = labelSize(box.height, box.textScale);
  let size = Math.min(22 * box.textScale, room.height / 4);
  let lines = wrapText(`“${body.text}”`, room.width, size, 8);
  // Step the quotation down until it and its attribution fit the box.
  while (size > small && lines.length * size * 1.25 + small * 2.5 > room.height) {
    size -= 1;
    lines = wrapText(`“${body.text}”`, room.width, size, 8);
  }
  const block = lines.length * size * 1.25 + small * 2.2;
  const top = room.y + Math.max(0, (room.height - block) / 2) + size;
  return [
    {
      type: 'text',
      key: 'quote',
      part: 'quote',
      x: room.x,
      y: top,
      lines,
      size,
      lineHeight: size * 1.25,
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
      y: top + lines.length * size * 1.25 + small,
      lines: [`— ${by}`],
      size: small,
      lineHeight: small,
      weight: 'regular',
      anchor: 'start',
      fill: 'ink2',
      family: 'sans',
      opacity: 1,
    },
  ];
}

/** A short list, one item a line, a mark beside each; a lit item is marked and the rest recede. */
function listShapes(
  body: Extract<StatementPicture['statement'], { form: 'list' }>,
  state: PictureState,
  box: PictureBox,
): PictureShape[] {
  const room = inner(box);
  const size = labelSize(box.height, box.textScale) * 1.2;
  const row = Math.min(room.height / body.items.length, size * 3.2);
  const top = room.y + (room.height - row * body.items.length) / 2;
  return body.items.flatMap((item, index): PictureShape[] => {
    const middle = top + row * index + row / 2;
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
        y: middle + size * 0.35,
        lines: wrapText(item.label, room.width - size * 1.3, size, 2),
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
