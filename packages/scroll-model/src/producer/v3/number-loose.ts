import { plainFigure } from '../figures.js';
import type { IssueV3 } from '../../v3/issues.js';
import type { NamedText } from './copy-detail.js';
import { unitMagnitude } from './editorial.js';
import { pictureFieldsOf } from './copy-loose.js';
import {
  numberDetailOfTexts,
  numberDetailOfUnit,
  numberDetailOfValue,
  type ChartValue,
  type PassageText,
} from './number-detail.js';

type Plain = Readonly<Record<string, unknown>>;

const isPlain = (value: unknown): value is Plain =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const stringAt = (object: Plain, key: string): string | undefined => {
  const value = object[key];
  return typeof value === 'string' ? value : undefined;
};
const named = (field: string, text: string | undefined): NamedText[] => (text === undefined ? [] : [{ field, text }]);
const listAt = (object: Plain, key: string): readonly unknown[] => {
  const value = object[key];
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
};
/** A chart value as the picture schema takes it: digits, with thousands separators and a decimal part. */
const CHART_VALUE = /^\d+(?:,\d{3})*(?:\.\d+)?$/u;

/** The strings of an item of the reply that the figure rule reads: a quotation's own text is one of them. */
function itemFieldsOf(item: Plain): NamedText[] {
  switch (item['type']) {
    case 'para': {
      const control = item['control'];
      return [
        ...named('text', stringAt(item, 'text')),
        ...named('simpler text', stringAt(item, 'simple')),
        ...(isPlain(control) ? named('control label', stringAt(control, 'label')) : []),
      ];
    }
    case 'quote':
      return [
        ...named('text', stringAt(item, 'text')),
        ...named('simpler text', stringAt(item, 'simple')),
        ...named('speaker', stringAt(item, 'who')),
        ...named('work', stringAt(item, 'work')),
        ...named('year', stringAt(item, 'year')),
      ];
    case 'aside':
      return [...named('title', stringAt(item, 'title')), ...named('text', stringAt(item, 'text'))];
    default:
      return [];
  }
}

/**
 * The `authoring_number_not_in_evidence` findings, with their detail, of a reply that is not (yet) a valid `WrittenScrollV3`:
 * the reply parsed as JSON, but a field is missing or too long, so the compile (and its figure rule) never ran on it. As for a
 * copy (`looseCopyIssuesV3`), a model told only about the shape fault repeats its figures, so the repair is told about them
 * too (D-444). The same rule as the compile's strict one (`unstatedFigures` for prose, `pointAgrees` for a chart value,
 * `unitInPassages` for a unit), at the same paths and with the same detail, over whatever strings the reply holds, against
 * the passages each part cites by handle (a handle that is not offered is left out). It finds only what the compile would
 * also find in a valid reply, and nothing else is judged. Pure; `[]` for anything that is not an object.
 */
export function looseNumberIssuesV3(reply: unknown, offered: readonly PassageText[]): IssueV3[] {
  if (!isPlain(reply)) return [];
  const byHandle = new Map(offered.map((passage) => [passage.handle, passage]));
  const passagesOf = (cites: unknown): PassageText[] =>
    (Array.isArray(cites) ? (cites as readonly unknown[]) : []).flatMap((handle) => {
      const passage = typeof handle === 'string' ? byHandle.get(handle) : undefined;
      return passage === undefined ? [] : [passage];
    });
  const issues: IssueV3[] = [];
  const add = (path: string, detail: string | undefined): void => {
    if (detail !== undefined) issues.push({ code: 'authoring_number_not_in_evidence', path, detail });
  };
  const items = listAt(reply, 'items');
  const pictures = listAt(reply, 'pictures');
  const takeaway = reply['takeaway'];
  const everyCite = new Map<string, PassageText>();
  for (const cites of [
    ...items.flatMap((item) => (isPlain(item) ? [item['cites']] : [])),
    ...pictures.flatMap((picture) => (isPlain(picture) ? [picture['cites']] : [])),
    ...(isPlain(takeaway) ? [takeaway['cites']] : []),
  ])
    for (const passage of passagesOf(cites)) everyCite.set(passage.handle, passage);
  const scroll = [...everyCite.values()];
  const own = (path: string, text: string | undefined): void =>
    add(path, text === undefined ? undefined : numberDetailOfTexts(named('text', text), scroll, offered, 'scroll'));
  own('title', stringAt(reply, 'title'));
  own('dek', stringAt(reply, 'dek'));
  items.forEach((item, index) => {
    if (!isPlain(item)) return;
    if (item['type'] === 'section') own(`items.${String(index)}.title`, stringAt(item, 'title'));
    else add(`items.${String(index)}`, numberDetailOfTexts(itemFieldsOf(item), passagesOf(item['cites']), offered));
  });
  if (isPlain(takeaway))
    add(
      'takeaway',
      numberDetailOfTexts(named('text', stringAt(takeaway, 'text')), passagesOf(takeaway['cites']), offered),
    );
  listAt(reply, 'askSuggestions').forEach((text, index) => {
    if (typeof text === 'string') own(`askSuggestions.${String(index)}`, text);
  });
  pictures.forEach((picture, index) => {
    if (!isPlain(picture)) return;
    const cited = passagesOf(picture['cites']);
    add(`pictures.${String(index)}`, numberDetailOfTexts(pictureFieldsOf(picture), cited, offered));
    if (picture['kind'] !== 'chart') return;
    const unit = stringAt(picture, 'unit');
    if (unit !== undefined) add(`pictures.${String(index)}.unit`, numberDetailOfUnit(unit, cited, offered));
    const points = listAt(picture, 'points').filter(isPlain);
    const values = new Set(points.flatMap((point) => stringAt(point, 'value') ?? []).map(plainFigure));
    const magnitude = unitMagnitude(unit);
    points.forEach((point, pointIndex) => {
      const value = stringAt(point, 'value');
      if (value === undefined || !CHART_VALUE.test(value)) return;
      const chartValue: ChartValue = { value, magnitude, values };
      add(
        `pictures.${String(index)}.points.${String(pointIndex)}.value`,
        numberDetailOfValue(`point ${String(pointIndex + 1)}`, chartValue, cited, offered),
      );
    });
  });
  return issues;
}
