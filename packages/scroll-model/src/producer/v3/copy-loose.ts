import type { IssueV3 } from '../../v3/issues.js';
import { copiedRunsOfFields, copyDetailV3, copyMaterialOf, type NamedText } from './copy-detail.js';

type Plain = Readonly<Record<string, unknown>>;

const isPlain = (value: unknown): value is Plain =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const stringAt = (object: Plain, key: string): string | undefined => {
  const value = object[key];
  return typeof value === 'string' ? value : undefined;
};
const named = (field: string, text: string | undefined): NamedText[] => (text === undefined ? [] : [{ field, text }]);

/** What the keys of a picture's lists are called in a finding: `steps[1].label` is "step 2 label". */
const NOUNS: Readonly<Record<string, string>> = {
  steps: 'step',
  items: 'item',
  cells: 'cell',
  points: 'point',
  places: 'place',
  rows: 'row',
  columns: 'column',
  marks: 'mark',
  ways: 'way',
  regions: 'region',
  routes: 'route',
};

/** The keys of a picture whose string a reader reads. A reference to another part (`row`, `column`, `nearest`, `point`) is not one. */
const READ_KEYS = new Set(['title', 'caption', 'unit', 'value', 'label', 'text', 'note', 'who', 'work', 'year']);

/** The order the compile reads a picture in: its own strings, a statement or a centre, then each list; the model's key order does not matter. */
const READ_ORDER = [
  ...['title', 'caption', 'unit', 'value', 'label', 'text', 'note', 'who', 'work', 'year'],
  ...['statement', 'centre'],
  ...['ways', 'places', 'steps', 'regions', 'routes', 'items', 'rows', 'columns', 'cells', 'points', 'marks'],
];
const readRank = (key: string): number => {
  const at = READ_ORDER.indexOf(key);
  return at < 0 ? READ_ORDER.length : at;
};

/** The strings of a picture, named, from whatever shape the reply gave it; nothing is rejected, whatever else is wrong. */
function pictureFieldsOf(picture: Plain): NamedText[] {
  const found: NamedText[] = [];
  const walk = (node: Plain, prefix: string, inChart: boolean, inQuote: boolean): void => {
    for (const [key, value] of Object.entries(node).sort(([first], [second]) => readRank(first) - readRank(second))) {
      if (typeof value === 'string') {
        // A chart's values are figures, not prose; a quotation set large is the passage's own words.
        if (!READ_KEYS.has(key) || (inChart && key === 'value') || (inQuote && key === 'text')) continue;
        found.push({ field: `${prefix}${key === 'who' ? 'speaker' : key}`, text: value });
      } else if (Array.isArray(value)) {
        const noun = NOUNS[key];
        if (noun === undefined) continue;
        value.forEach((entry, index) => {
          if (typeof entry === 'string') found.push({ field: `${noun} ${String(index + 1)} name`, text: entry });
          else if (isPlain(entry)) walk(entry, `${noun} ${String(index + 1)} `, inChart, inQuote);
        });
      } else if (isPlain(value) && (key === 'statement' || key === 'centre')) {
        walk(value, key === 'centre' ? 'centre ' : '', inChart, key === 'statement' && value['form'] === 'quote');
      }
    }
  };
  walk(picture, '', picture['kind'] === 'chart', false);
  return found;
}

/** The strings of one item of the reply that the copy rule reads (a quotation's own text is the one it leaves out). */
function itemFieldsOf(item: Plain): NamedText[] {
  switch (item['type']) {
    case 'section':
      return named('text', stringAt(item, 'title'));
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
 * The `copied_passage` findings of a reply that is not (yet) a valid `WrittenScrollV3` or `WrittenProseV3`: the reply
 * parsed as JSON, but a field is missing or too long, so the compile (and its copy rule) never ran on it. A model that is
 * only told about that fault keeps its copy through the repair (D-440), so the repair is told about the copies too. The same
 * rule as the compile's strict one, run over whatever strings the reply holds, at the same paths and with the same detail:
 * a run of nine words that also stands in a research text, outside a quotation. It finds only what the compile would also
 * find in a valid reply, and nothing else is judged. Pure; `[]` for anything that is not an object.
 */
export function looseCopyIssuesV3(reply: unknown, sources: readonly string[]): IssueV3[] {
  if (!isPlain(reply)) return [];
  const material = copyMaterialOf(sources);
  const issues: IssueV3[] = [];
  const check = (path: string, fields: readonly NamedText[]): void => {
    const runs = copiedRunsOfFields(fields, material);
    if (runs.length > 0) issues.push({ code: 'copied_passage', path, detail: copyDetailV3(runs) });
  };
  check('title', named('text', stringAt(reply, 'title')));
  check('dek', named('text', stringAt(reply, 'dek')));
  const items = Array.isArray(reply['items']) ? (reply['items'] as readonly unknown[]) : [];
  items.forEach((item, index) => {
    if (!isPlain(item)) return;
    const fields = itemFieldsOf(item);
    // The compile reports a section's title at its own path and every other item at the item.
    check(item['type'] === 'section' ? `items.${String(index)}.title` : `items.${String(index)}`, fields);
  });
  const takeaway = reply['takeaway'];
  if (isPlain(takeaway)) check('takeaway', named('text', stringAt(takeaway, 'text')));
  const suggestions = Array.isArray(reply['askSuggestions']) ? (reply['askSuggestions'] as readonly unknown[]) : [];
  suggestions.forEach((text, index) => {
    if (typeof text === 'string') check(`askSuggestions.${String(index)}`, named('text', text));
  });
  const pictures = Array.isArray(reply['pictures']) ? (reply['pictures'] as readonly unknown[]) : [];
  pictures.forEach((picture, index) => {
    if (isPlain(picture)) check(`pictures.${String(index)}`, pictureFieldsOf(picture));
  });
  return issues;
}
