import { INTEGRITY_METHOD } from '../../document.js';
import type { Claim, ProductionRecord, Source } from '../../internal/provenance.js';
import { SCROLL_PROVENANCE_V3_SCHEMA_VERSION, type ScrollProvenanceV3 } from '../../internal/provenance-v3.js';
import type { PictureKind, PictureState } from '../../v3/pictures.js';
import type { Control, Link, ScrollDocumentV3, Show } from '../../v3/document.js';
import { uniqueIssuesV3, type IssueV3 } from '../../v3/issues.js';
import { LIMITS_V3 as L } from '../../v3/limits.js';
import { computeIntegrityV3, validateDocumentV3 } from '../../v3/validate.js';
import type { AuthoringEvidence } from '../authoring-bind.js';
import {
  assemble,
  citationsOf,
  evidenceIssues,
  pictureTexts,
  SCROLL_AUTHORING_V3_VERSION,
  type AuthoredBeatV3,
  type AuthoredScrollV3,
  type PublicationV3,
} from './editorial.js';
import { mergeStagingV3 } from './written-merge.js';
import { buildPicture, UNKNOWN_ID, type BuiltPicture } from './written-pictures.js';
import type {
  WrittenControlV3,
  WrittenItemV3,
  WrittenProseV3,
  WrittenScrollV3,
  WrittenStagingV3,
  WrittenStateV3,
} from './written-schema.js';

/**
 * Phrases of machine prose that no reader should meet in a Scroll (`machine_phrase`), matched as whole words, ignoring
 * case, in every string a model wrote except a quotation. This list grows from the owner's rejections: when a read
 * finds a tic, its words go here so the next repair names it.
 */
export const MACHINE_PHRASES_V3: readonly string[] = [
  'delve',
  'tapestry',
  "in today's world",
  "it's important to note",
  'it is important to note',
  'a testament to',
  'plays a crucial role',
  'in conclusion',
  "let's dive",
  'navigate the complexities',
  'unlock the secrets',
  'the realm of',
  'embark on a journey',
];

/** Words that point at something the reader has not met yet: a first paragraph cannot open with one (`first_beat_points_back`). */
const BACK_POINTERS: ReadonlySet<string> = new Set([
  'this',
  'that',
  'these',
  'those',
  'it',
  'its',
  'they',
  'so',
  'but',
  'and',
  'also',
  'then',
]);

/** The takeaway is the dek again when this share of its words, or more, are the dek's. */
const REPEAT_SHARE = 0.8;

/** The facts of a Scroll that are code's, never the model's: who the asset is and what the recipe fixes. */
export interface WrittenCodeFacts {
  readonly publication: PublicationV3;
  readonly kicker: string;
  readonly theme: AuthoredScrollV3['theme'];
  readonly shape: AuthoredScrollV3['shape'];
  readonly framing: AuthoredScrollV3['framing'];
  readonly misconception: AuthoredScrollV3['misconception'];
}

export interface WrittenCompileInput {
  /** The whole-Scroll reply, already parsed with `WrittenScrollV3`. */
  readonly reply: WrittenScrollV3;
  readonly code: WrittenCodeFacts;
  readonly evidence: AuthoringEvidence;
  /** Every research text (the passages and the pages they came from), for the copy rule. */
  readonly sources: readonly string[];
  readonly claims: readonly Claim[];
  readonly sourceRecords: readonly Source[];
  readonly production: ProductionRecord;
  /** The picture kinds the plan names, in order. Without it the model chooses the kinds. */
  readonly plannedKinds?: readonly PictureKind[] | undefined;
}

export type WrittenCompileOutcome =
  | {
      readonly kind: 'compiled';
      readonly document: ScrollDocumentV3;
      readonly provenance: ScrollProvenanceV3;
      /** The claims each part rests on, by the document's own ids (`b3`, `a1`, `p1`, `takeaway`). Internal; never served. */
      readonly citations: Readonly<Record<string, readonly string[]>>;
    }
  | { readonly kind: 'refused'; readonly issues: readonly IssueV3[] };

export type WrittenProseOutcome =
  { readonly kind: 'accepted' } | { readonly kind: 'refused'; readonly issues: readonly IssueV3[] };

// ---------------------------------------------------------------------------------------------------------------------
// Reading the reply: sections, beats, asides, shows, links and controls, with every label and handle resolved.
// ---------------------------------------------------------------------------------------------------------------------

type ParaItem = Extract<WrittenItemV3, { type: 'para' }>;
type QuoteItem = Extract<WrittenItemV3, { type: 'quote' }>;
type AuthoredAside = AuthoredScrollV3['asides'][number];

/** The id a `show` gets when its picture number is not one of the reply's pictures. */
const UNKNOWN_PICTURE_ID = 'unknown-picture';
/** The title of a section the model did not open: the first item was not a `section`. */
const IMPLICIT_SECTION_TITLE = 'Section';

interface ReadBeat {
  readonly beat: AuthoredBeatV3;
  readonly item: number;
}

interface ReadSection {
  readonly title: string;
  /** The `section` item, or undefined for a section code opened because the model did not. */
  readonly item: number | undefined;
  readonly beats: ReadBeat[];
  /** The picture the last beat of this section showed: what a later beat's links name when it shows none. */
  onScreen: BuiltPicture | undefined;
}

interface ReadAside {
  readonly aside: Omit<AuthoredAside, 'beat'>;
  readonly item: number;
  /** The item of the paragraph or quotation it follows. */
  readonly anchorItem: number | undefined;
}

/** Where each part of the document came from in the model's reply, so a finding is given at the model's own item. */
interface PathMap {
  readonly sectionItem: readonly (number | undefined)[];
  readonly beatItems: readonly (readonly number[])[];
  readonly beatItem: readonly number[];
  readonly asideItem: readonly (number | undefined)[];
}

/** Turns the handles a part names into claim ids, with a finding at `path` for each handle that is not offered. */
function citer(claimIdOf: ReadonlyMap<string, string>, issues: IssueV3[]) {
  return (handles: readonly string[], path: string): string[] =>
    handles.flatMap((handle) => {
      const claimId = claimIdOf.get(handle);
      if (claimId === undefined) issues.push({ code: 'authoring_cite_unknown', path });
      return claimId === undefined ? [] : [claimId];
    });
}

type Cite = ReturnType<typeof citer>;

/** A state with labels turned into ids. An unknown label is a finding at its own place and is left out. */
function readState(
  written: Pick<WrittenStateV3, 'upTo' | 'lit' | 'step' | 'region'>,
  built: BuiltPicture | undefined,
  path: string,
  issues: IssueV3[],
): PictureState {
  const lit = (written.lit ?? []).flatMap((label, index) => {
    const id = built?.parts.get(label);
    if (id === undefined && built !== undefined)
      issues.push({
        code: built.ambiguous.has(label) ? 'picture_label_duplicate' : 'show_state_invalid',
        path: `${path}.lit.${index}`,
      });
    return id === undefined ? [] : [id];
  });
  const region = written.region === undefined ? undefined : built?.regions.get(written.region);
  if (written.region !== undefined && region === undefined && built !== undefined)
    issues.push({ code: 'show_state_invalid', path: `${path}.region` });
  return {
    ...(written.upTo === undefined ? {} : { upTo: written.upTo }),
    ...(lit.length === 0 ? {} : { lit }),
    ...(written.step === undefined ? {} : { step: written.step }),
    ...(region === undefined ? {} : { region }),
  };
}

interface ReadShow {
  readonly show?: Show;
  /** The picture the show names, when the number is one of the reply's pictures. */
  readonly picture?: BuiltPicture;
}

function readShow(
  written: ParaItem['show'],
  pictures: readonly BuiltPicture[],
  path: string,
  issues: IssueV3[],
): ReadShow {
  if (written === undefined) return {};
  const picture = pictures[written.picture - 1];
  if (picture === undefined) {
    issues.push({ code: 'show_picture_unknown', path: `${path}.show.picture` });
    return { show: { picture: UNKNOWN_PICTURE_ID, state: {} } };
  }
  return { show: { picture: picture.picture.id, state: readState(written, picture, `${path}.show`, issues) }, picture };
}

/**
 * The links of a beat. A link names a part of the picture on screen: the beat's own, else the last one its section
 * showed (the validator's rule). A show that names no picture has its own finding, so its links are not judged.
 */
function readLinks(
  written: ParaItem['links'],
  onScreen: BuiltPicture | undefined,
  judged: boolean,
  path: string,
  issues: IssueV3[],
): Link[] {
  return (written ?? []).map(({ phrase, part }, index) => {
    const id = judged ? onScreen?.parts.get(part) : undefined;
    if (judged && onScreen !== undefined && id === undefined)
      issues.push({
        code: onScreen.ambiguous.has(part) ? 'picture_label_duplicate' : 'link_part_unknown',
        path: `${path}.links.${index}.part`,
      });
    return { phrase, part: id ?? UNKNOWN_ID };
  });
}

function readControl(
  written: WrittenControlV3,
  shown: BuiltPicture | undefined,
  path: string,
  issues: IssueV3[],
): Control {
  if (written.kind !== 'switch') return written;
  return { ...written, to: readState(written.to, shown, `${path}.control.to`, issues) };
}

/** One paragraph or quotation as the document's own beat form, with its handles, labels and picture numbers resolved. */
function readBeat(
  item: ParaItem | QuoteItem,
  at: number,
  section: ReadSection,
  pictures: readonly BuiltPicture[],
  cite: Cite,
  issues: IssueV3[],
): AuthoredBeatV3 {
  const path = `items.${at}`;
  const shown = readShow(item.show, pictures, path, issues);
  const picture = item.show === undefined ? section.onScreen : shown.picture;
  const links = readLinks(item.links, picture, item.show === undefined || shown.picture !== undefined, path, issues);
  if (shown.picture !== undefined) section.onScreen = shown.picture;
  const own = {
    text: item.text,
    simple: item.simple,
    links,
    ...(shown.show === undefined ? {} : { show: shown.show }),
    cites: cite(item.cites, path),
  };
  if (item.type === 'quote')
    return {
      kind: 'quote',
      ...own,
      cite: {
        who: item.who,
        ...(item.work === undefined ? {} : { work: item.work }),
        ...(item.year === undefined ? {} : { year: item.year }),
      },
    };
  return {
    kind: 'plain',
    ...own,
    ...(item.emphasis === undefined ? {} : { emphasis: item.emphasis }),
    ...(item.control === undefined ? {} : { control: readControl(item.control, shown.picture, path, issues) }),
  };
}

interface ReadItems {
  readonly sections: ReadSection[];
  readonly asides: ReadAside[];
}

/** Walks the flat item list: a `section` opens a section, a paragraph or quotation is its beat, an aside follows its beat. */
function readItems(
  items: WrittenScrollV3['items'],
  pictures: readonly BuiltPicture[],
  cite: Cite,
  issues: IssueV3[],
): ReadItems {
  const sections: ReadSection[] = [];
  const asides: ReadAside[] = [];
  if (items[0]?.type !== 'section') issues.push({ code: 'section_first_missing', path: 'items.0' });
  let lastBeatItem: number | undefined;
  items.forEach((item, at) => {
    const path = `items.${at}`;
    if (item.type === 'section') {
      sections.push({ title: item.title, item: at, beats: [], onScreen: undefined });
    } else if (item.type === 'aside') {
      if (lastBeatItem === undefined) issues.push({ code: 'aside_without_beat', path });
      asides.push({
        aside: {
          kind: item.kind,
          title: item.title,
          text: item.text,
          collapsed: item.kind === 'limits',
          cites: cite(item.cites, path),
        },
        item: at,
        anchorItem: lastBeatItem,
      });
    } else {
      if (sections.length === 0)
        sections.push({ title: IMPLICIT_SECTION_TITLE, item: undefined, beats: [], onScreen: undefined });
      const section = sections[sections.length - 1];
      if (section === undefined) return;
      section.beats.push({ beat: readBeat(item, at, section, pictures, cite, issues), item: at });
      lastBeatItem = at;
    }
  });
  return { sections, asides };
}

// ---------------------------------------------------------------------------------------------------------------------
// The authored form: the structure bounds the document's own schema holds, enforced here so the rest can still run.
// ---------------------------------------------------------------------------------------------------------------------

interface Shaped {
  readonly sections: AuthoredScrollV3['sections'];
  readonly asides: AuthoredScrollV3['asides'];
  readonly map: PathMap;
  /** The structure is too small for the document's schema to read, so its own rules cannot run. */
  readonly unreadable: boolean;
}

/** The number (from 1, across sections) of the beat an aside follows; a beat cut from the copy anchors it to the last one. */
function anchorNumber(anchorItem: number | undefined, beatItem: readonly number[]): number {
  if (anchorItem === undefined) return 1;
  const at = beatItem.indexOf(anchorItem);
  return at < 0 ? Math.max(1, beatItem.length) : at + 1;
}

const itemOf = (section: ReadSection): string => (section.item === undefined ? 'items' : `items.${section.item}`);

/**
 * Fits what the model wrote into the bounds of a document (two or three sections of two to six beats, one to four
 * asides) so the validator can still read it. Too much is cut from the end of the copy that is validated, with a
 * finding at the section or the list; a Scroll with too few sections or beats has a finding and its document rules
 * are not run, because a document that small cannot be read at all. A Scroll with no aside gets `limits_aside_missing`.
 */
function shape(read: ReadItems, fallbackCite: readonly string[], issues: IssueV3[]): Shaped {
  let unreadable = false;
  if (read.sections.length > L.sections.max) issues.push({ code: 'schema_too_big', path: 'items' });
  if (read.sections.length < L.sections.min) {
    issues.push({ code: 'schema_too_small', path: 'items' });
    unreadable = true;
  }
  const sections = read.sections.slice(0, L.sections.max).map((section) => {
    if (section.beats.length > L.beatsPerSection.max) issues.push({ code: 'schema_too_big', path: itemOf(section) });
    if (section.beats.length < L.beatsPerSection.min) {
      issues.push({ code: 'schema_too_small', path: itemOf(section) });
      unreadable = true;
    }
    return { ...section, beats: section.beats.slice(0, L.beatsPerSection.max) };
  });
  const beatItem = sections.flatMap((section) => section.beats.map((entry) => entry.item));
  if (read.asides.length > L.asides.max) issues.push({ code: 'schema_too_big', path: 'items' });
  const kept = read.asides.slice(0, L.asides.max);
  if (kept.length === 0) issues.push({ code: 'limits_aside_missing', path: 'items' });
  const asides: AuthoredScrollV3['asides'] = kept.map(({ aside, anchorItem }) => ({
    ...aside,
    beat: anchorNumber(anchorItem, beatItem),
  }));
  // A placeholder so the validator can run on a Scroll that has none: it is never stored.
  const padded: AuthoredScrollV3['asides'] =
    kept.length === 0
      ? [
          {
            kind: 'limits',
            title: 'Placeholder',
            text: 'Placeholder',
            collapsed: true,
            beat: 1,
            cites: [...fallbackCite],
          },
        ]
      : asides;
  return {
    sections: sections.map((section) => ({ title: section.title, beats: section.beats.map((entry) => entry.beat) })),
    asides: padded,
    map: {
      sectionItem: sections.map((section) => section.item),
      beatItems: sections.map((section) => section.beats.map((entry) => entry.item)),
      beatItem,
      asideItem: kept.length === 0 ? [undefined] : kept.map((entry) => entry.item),
    },
    unreadable,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Where a finding is reported: the model's own item.
// ---------------------------------------------------------------------------------------------------------------------

const itemPath = (item: number | undefined, field = ''): string =>
  item === undefined ? 'items' : `items.${item}${field}`;

/** The part of a beat's path (after `sections.i.beats.j`) that the model wrote under its own name. */
function beatField(rest: readonly string[]): string {
  const [key, index, name] = rest;
  switch (key ?? '') {
    case 'text':
    case 'simple':
    case 'emphasis':
      return `.${key}`;
    case 'show':
      return index === 'picture' ? '.show.picture' : '.show';
    case 'links':
      return index === undefined ? '' : `.links.${index}${name === undefined ? '' : `.${name}`}`;
    case 'control':
      return index === 'to' ? '.control.to' : '.control';
    case 'cite':
      return index === undefined ? '' : `.${index}`;
    default:
      return '';
  }
}

/** A path of the assembled document, as the item of the model's reply it came from. */
function modelPathOfDocument(path: string, map: PathMap): string {
  const [root, first, second, third, ...rest] = path.split('.');
  switch (root ?? '') {
    case 'sections': {
      const section = Number(first);
      if (second === undefined) return 'items';
      if (second === 'title') return itemPath(map.sectionItem[section], '.title');
      if (second !== 'beats') return itemPath(map.sectionItem[section]);
      if (third === undefined) return itemPath(map.sectionItem[section]);
      return itemPath(map.beatItems[section]?.[Number(third)], beatField(rest));
    }
    case 'asides': {
      if (first === undefined) return 'items';
      const field = second === 'title' || second === 'text' ? `.${second}` : '';
      return itemPath(map.asideItem[Number(first)], field);
    }
    case 'pictures':
      return path.replace(/\.id$/u, '');
    case 'takeaway':
    case 'title':
    case 'dek':
    case 'askSuggestions':
      return path;
    case 'measures':
      return 'items';
    default:
      return '$';
  }
}

/** A path of the evidence rule (`beats.2`, `pictures.0.picture.unit`, `sections.1.title`), as the model's own. */
function modelPathOfEvidence(path: string, map: PathMap): string {
  const [root, first, second] = path.split('.');
  switch (root ?? '') {
    case 'beats':
      return itemPath(map.beatItem[Number(first)]);
    case 'asides':
      return itemPath(map.asideItem[Number(first)]);
    case 'sections':
      return itemPath(map.sectionItem[Number(first)], second === 'title' ? '.title' : '');
    case 'pictures':
      return path.replace('.picture.', '.');
    case 'header':
      return '$';
    default:
      return path;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Writer rules: what makes a Scroll read as written by a person.
// ---------------------------------------------------------------------------------------------------------------------

const comparableWords = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/u)
    .filter((word) => word !== '');

/** Text for matching a phrase: one kind of apostrophe and one kind of space. */
const plainForMatch = (text: string): string => text.replace(/[‘’‛′]/gu, "'").replace(/\s+/gu, ' ');

const MACHINE_PATTERNS: readonly RegExp[] = MACHINE_PHRASES_V3.map(
  (phrase) =>
    new RegExp(`(?<![\\p{L}\\p{N}])${phrase.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu'),
);

const hasMachinePhrase = (text: string): boolean => {
  const plain = plainForMatch(text);
  return MACHINE_PATTERNS.some((pattern) => pattern.test(plain));
};

/** Every string the model wrote for a reader, with where it is, except a quotation (which is the source's, not the model's). */
function readerStrings(reply: WrittenScrollV3, pictures: readonly BuiltPicture[]): { path: string; text: string }[] {
  const items = reply.items.flatMap((item, at): { path: string; text: string }[] => {
    const path = `items.${at}`;
    switch (item.type) {
      case 'section':
        return [{ path: `${path}.title`, text: item.title }];
      case 'para':
        return [
          { path: `${path}.text`, text: item.text },
          { path: `${path}.simple`, text: item.simple },
          ...(item.control === undefined ? [] : [{ path: `${path}.control`, text: item.control.label }]),
        ];
      case 'quote':
        return [{ path: `${path}.simple`, text: item.simple }];
      case 'aside':
        return [
          { path: `${path}.title`, text: item.title },
          { path: `${path}.text`, text: item.text },
        ];
    }
  });
  return [
    { path: 'title', text: reply.title },
    { path: 'dek', text: reply.dek },
    ...items,
    { path: 'takeaway', text: reply.takeaway.text },
    ...reply.askSuggestions.map((text, index) => ({ path: `askSuggestions.${index}`, text })),
    ...pictures.flatMap((built, index) =>
      pictureTexts(built.picture).map((text) => ({ path: `pictures.${index}`, text })),
    ),
  ];
}

/** The rules of writing the Scroll must keep, besides the evidence: each at the model's own item. */
function writerIssues(
  reply: WrittenScrollV3,
  pictures: readonly BuiltPicture[],
  cited: ReadonlySet<string>,
  minDistinctCitations: number,
  plannedKinds: readonly PictureKind[] | undefined,
): IssueV3[] {
  const issues: IssueV3[] = [];
  if (cited.size < minDistinctCitations) issues.push({ code: 'authoring_too_few_cites', path: '$' });
  const openingAt = reply.items.findIndex((item) => item.type === 'para' || item.type === 'quote');
  const opening = reply.items[openingAt];
  if (opening?.type === 'para') {
    const first = comparableWords(opening.text)[0];
    if (first !== undefined && BACK_POINTERS.has(first))
      issues.push({ code: 'first_beat_points_back', path: `items.${openingAt}.text` });
  }
  for (const { path, text } of readerStrings(reply, pictures))
    if (hasMachinePhrase(text)) issues.push({ code: 'machine_phrase', path });
  const takeaway = comparableWords(reply.takeaway.text);
  const dek = comparableWords(reply.dek);
  const shared = takeaway.filter((word) => dek.includes(word)).length;
  if (takeaway.join(' ') === dek.join(' ') || (takeaway.length > 0 && shared / takeaway.length >= REPEAT_SHARE))
    issues.push({ code: 'takeaway_repeats_dek', path: 'takeaway' });
  if (plannedKinds !== undefined) issues.push(...plannedKindIssues(pictures, plannedKinds));
  return issues;
}

/** The pictures have exactly the planned kinds in the planned order: each wrong or surplus picture, or the list when short. */
function plannedKindIssues(pictures: readonly BuiltPicture[], planned: readonly PictureKind[]): IssueV3[] {
  const issues: IssueV3[] = pictures.flatMap((built, index): IssueV3[] =>
    built.picture.kind === planned[index] ? [] : [{ code: 'picture_kind_unplanned', path: `pictures.${index}` }],
  );
  if (pictures.length < planned.length) issues.push({ code: 'picture_kind_unplanned', path: 'pictures' });
  return issues;
}

// ---------------------------------------------------------------------------------------------------------------------
// The compile.
// ---------------------------------------------------------------------------------------------------------------------

/** Findings of the assembled document that a finding of the model's own already says (the same cause, found earlier). */
function repeatsOwn(issue: IssueV3, own: readonly IssueV3[]): boolean {
  return own.some(
    (mine) =>
      (mine.code === issue.code || (issue.code === 'picture_region_invalid' && mine.code === 'picture_ref_unknown')) &&
      (mine.path === issue.path || mine.path.startsWith(`${issue.path}.`)),
  );
}

interface Analysis {
  readonly issues: readonly IssueV3[];
  readonly authored: AuthoredScrollV3;
  readonly document: ScrollDocumentV3 | undefined;
}

/** Every check that can run on the reply, merged. The document is set only when its own validation passed. */
function analyse(input: WrittenCompileInput): Analysis {
  const { reply, code, evidence } = input;
  const own: IssueV3[] = [];
  const cite = citer(evidence.claimIdOf, own);
  const pictures = reply.pictures.map((written, index) => buildPicture(written, index + 1));
  own.push(...pictures.flatMap((built) => built.issues));
  const read = readItems(reply.items, pictures, cite, own);
  const takeawayCites = cite(reply.takeaway.cites, 'takeaway');
  const pictureCites = reply.pictures.map((written, index) => cite(written.cites, `pictures.${index}`));
  const shaped = shape(read, takeawayCites, own);
  const authored: AuthoredScrollV3 = {
    schemaVersion: SCROLL_AUTHORING_V3_VERSION,
    theme: code.theme,
    kicker: code.kicker,
    title: reply.title,
    dek: reply.dek,
    shape: code.shape,
    framing: code.framing,
    misconception: code.misconception,
    pictures: pictures.map(({ picture }, index) => ({ picture, cites: pictureCites[index] ?? [] })),
    sections: shaped.sections,
    asides: shaped.asides,
    takeaway: { text: reply.takeaway.text, cites: takeawayCites },
    askSuggestions: reply.askSuggestions,
  };
  const cited = citedClaims(authored);
  const strict = evidenceIssues(authored, evidence.quoteOf, { figures: 'strict', copySources: input.sources }).map(
    (issue): IssueV3 => ({ ...issue, path: modelPathOfEvidence(issue.path, shaped.map) }),
  );
  const unknownSource = input.claims.some(
    (claim) => cited.has(claim.claimId) && !input.sourceRecords.some((record) => record.sourceId === claim.sourceId),
  );
  const rules = writerIssues(reply, pictures, cited, evidence.minDistinctCitations, input.plannedKinds);
  const checks: IssueV3[] = [
    ...own,
    ...strict,
    ...rules,
    ...(unknownSource ? [{ code: 'authoring_reference_unknown' as const, path: '$' }] : []),
  ];
  const validated = shaped.unreadable ? undefined : validateAssembled(authored, code.publication);
  const fromDocument =
    validated?.kind === 'invalid'
      ? validated.issues
          .map((issue): IssueV3 => ({ code: issue.code, path: modelPathOfDocument(issue.path, shaped.map) }))
          .filter((issue) => !repeatsOwn(issue, own))
      : [];
  return {
    issues: uniqueIssuesV3([...checks, ...fromDocument]),
    authored,
    document: validated?.kind === 'valid' ? validated.document : undefined,
  };
}

/** The distinct claims every part of the Scroll cites. */
function citedClaims(authored: AuthoredScrollV3): Set<string> {
  return new Set([
    ...authored.sections.flatMap((section) => section.beats.flatMap((beat) => beat.cites)),
    ...authored.asides.flatMap((aside) => aside.cites),
    ...authored.pictures.flatMap((entry) => entry.cites),
    ...authored.takeaway.cites,
  ]);
}

function assembleSealed(authored: AuthoredScrollV3, publication: PublicationV3): ScrollDocumentV3 {
  const unsealed = assemble(authored, publication);
  return {
    ...unsealed,
    integrity: { method: INTEGRITY_METHOD, sha256: computeIntegrityV3(unsealed) },
  };
}

function validateAssembled(authored: AuthoredScrollV3, publication: PublicationV3) {
  return validateDocumentV3(JSON.parse(JSON.stringify(assembleSealed(authored, publication))) as unknown);
}

/**
 * Compiles the model's whole-Scroll reply into a stored document v3 and its provenance, or into every finding at once.
 *
 * Code assigns every id (`p1…`, `s1…`, `b1…`, `a1…`) and turns the model's handles, picture numbers and labels into
 * them; each unresolved one is a finding at the model's own item. It then runs, merged and never stopping at the first
 * stage: the structure (a first section, an aside after a beat, the planned picture kinds); the evidence rule in its
 * strict mode (every figure in prose by `unstatedFigures`, chart values by `pointAgrees`, quotations word for word, no
 * copied run against any research text); the writer rules (enough distinct passages, no opening that points back, no
 * machine phrase, a takeaway that is not the dek); and the document's own validation of the sealed bytes. A finding of
 * the document is given at the item of the reply it came from (`items.4.show`, `pictures.1.points.2.value`).
 *
 * Pure and deterministic. A Scroll too small for the document's schema (fewer than two sections, or a section of fewer
 * than two beats) gets its findings from everything else and none from the document's rules, which cannot read it.
 */
export function compileWrittenV3(input: WrittenCompileInput): WrittenCompileOutcome {
  const { issues, authored, document } = analyse(input);
  if (issues.length > 0 || document === undefined) return { kind: 'refused', issues };
  const citations = citationsOf(authored, document);
  const cited = new Set(citations.flatMap((entry) => entry.claimIds));
  const claimsUsed = input.claims.filter((claim) => cited.has(claim.claimId));
  const sourcesUsed = input.sourceRecords.filter((source) =>
    claimsUsed.some((claim) => claim.sourceId === source.sourceId),
  );
  return {
    kind: 'compiled',
    document,
    citations: Object.fromEntries(citations.map((entry) => [entry.partId, entry.claimIds])),
    provenance: {
      schemaVersion: SCROLL_PROVENANCE_V3_SCHEMA_VERSION,
      assetId: input.code.publication.assetId,
      revision: input.code.publication.revision,
      documentSha256: document.integrity.sha256,
      claims: claimsUsed,
      sources: sourcesUsed,
      citations,
      checks: [{ name: 'evidence', version: 'scroll-checks-v3.v1', verdict: 'pass', reasonCodes: [] }],
      production: input.production,
    },
  };
}

/** Findings that are about a picture, what a paragraph shows of it, its links or its control: not the prose's. */
const PICTURE_CODE = /^(?:picture_|show_|link_|control_)/u;

/**
 * Arm (b), first step: runs every check of the compile that is about the prose, and none about pictures.
 *
 * The prose has no picture, but a document needs one (and a beat that shows it), so the prose is merged with a
 * placeholder staging: one statement picture that code makes, shown by the first paragraph. The placeholder is never
 * stored. Every finding about pictures, shows, links or controls, and every finding under `pictures`, is then dropped;
 * what is left is the prose's: structure, handles, figures, copying, the writer rules, lengths, beat and word bounds,
 * the takeaway's sentences and the reading time (which the placeholder's four seconds barely move).
 */
export function compileWrittenProseV3(
  prose: WrittenProseV3,
  input: Omit<WrittenCompileInput, 'reply' | 'plannedKinds'>,
): WrittenProseOutcome {
  // The placeholder cites a passage the prose already cites, so it adds nothing to what the prose is judged on: neither a
  // passage toward the four distinct ones, nor a passage the header's figures could lean on.
  const handle =
    prose.items.flatMap((item) => (item.type === 'section' ? [] : item.cites))[0] ?? prose.takeaway.cites[0] ?? 'e1';
  const placeholder: WrittenStagingV3 = {
    pictures: [
      {
        kind: 'statement',
        title: 'Placeholder',
        cites: [handle],
        statement: { form: 'list', items: [{ label: 'One' }, { label: 'Two' }] },
      },
    ],
    stage: [{ para: 1, show: { picture: 1 } }],
  };
  const { reply } = mergeStagingV3(prose, placeholder);
  const { issues } = analyse({ ...input, reply });
  const kept = issues.filter((issue) => !PICTURE_CODE.test(issue.code) && !issue.path.startsWith('pictures'));
  return kept.length === 0 ? { kind: 'accepted' } : { kind: 'refused', issues: kept };
}
