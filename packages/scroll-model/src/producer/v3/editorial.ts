import { z } from '../../zod.js';
import { Framing, INTEGRITY_METHOD, THEME_FAMILIES, type SeriesRef } from '../../document.js';
import { OpaqueId, plainText } from '../../primitives.js';
import { issueFromSchema } from '../../issues.js';
import type { Claim, ProductionRecord, Source } from '../../internal/provenance.js';
import {
  SCROLL_PROVENANCE_V3_SCHEMA_VERSION,
  TAKEAWAY_PART_ID,
  type ScrollProvenanceV3,
} from '../../internal/provenance-v3.js';
import { ASIDE_KINDS, Misconception } from '../../v2/document.js';
import {
  PlainBeat,
  QuoteBeat,
  SCROLL_DOCUMENT_V3_SCHEMA_VERSION,
  SCROLL_SHAPES,
  type Beat,
  type ScrollDocumentV3,
} from '../../v3/document.js';
import { uniqueIssuesV3, type IssueV3 } from '../../v3/issues.js';
import { FIELD_LIMITS_V3 as F, LIMITS_V3 as L, SCROLL_LIMITS_V3_VERSION } from '../../v3/limits.js';
import { computeMeasuresV3 } from '../../v3/measures.js';
import { Picture } from '../../v3/pictures.js';
import { computeIntegrityV3, validateDocumentV3 } from '../../v3/validate.js';
import { copiedRunsOfFields, copyDetailV3, copyMaterialOf, type NamedText } from './copy-detail.js';
import { numberDetailOfTexts, numberDetailOfUnit, numberDetailOfValue, type PassageText } from './number-detail.js';
import { MAGNITUDES, type Magnitude } from '../../v2/blocks.js';
import { digitFiguresIn, plainFigure, pointAgrees, readingsOf, unitInPassages, unstatedFigures } from '../figures.js';

/**
 * `scroll-authoring.v3`: a document v3 as a person writes it by hand, before code sets what is code's (ids, measures,
 * the hash). Every beat, aside, picture and the takeaway names the claims it rests on (`cites`), as the v2 writer's
 * items do. The future document v3 writer will have its own shape; this one is the editorial form (#759).
 */
export const SCROLL_AUTHORING_V3_VERSION = 'scroll-authoring.v3';

const Cites = z.array(OpaqueId).min(1).max(8);

export const AuthoredBeatV3 = z.discriminatedUnion('kind', [
  PlainBeat.omit({ id: true }).extend({ cites: Cites }),
  QuoteBeat.omit({ id: true }).extend({ cites: Cites }),
]);
export type AuthoredBeatV3 = z.infer<typeof AuthoredBeatV3>;

export const AuthoredScrollV3 = z.strictObject({
  schemaVersion: z.literal(SCROLL_AUTHORING_V3_VERSION),
  theme: z.strictObject({ family: z.enum(THEME_FAMILIES) }),
  kicker: plainText(1, 40),
  title: plainText(4, 90),
  dek: plainText(10, 200),
  shape: z.enum(SCROLL_SHAPES),
  framing: Framing,
  misconception: Misconception,
  pictures: z
    .array(z.strictObject({ picture: Picture, cites: Cites }))
    .min(L.pictures.min)
    .max(L.pictures.max),
  sections: z
    .array(
      z.strictObject({
        title: plainText(1, F.sectionTitleChars),
        beats: z.array(AuthoredBeatV3).min(L.beatsPerSection.min).max(L.beatsPerSection.max),
      }),
    )
    .min(L.sections.min)
    .max(L.sections.max),
  asides: z
    .array(
      z.strictObject({
        kind: z.enum(ASIDE_KINDS),
        title: plainText(1, F.asideTitleChars),
        text: plainText(1, F.asideChars),
        /** The beat it sits beside, counted from 1 in reading order across sections. */
        beat: z.number().int().min(1).max(L.beats.max),
        collapsed: z.boolean(),
        cites: Cites,
      }),
    )
    .min(L.asides.min)
    .max(L.asides.max),
  takeaway: z.strictObject({ text: plainText(F.takeawayChars.min, F.takeawayChars.max), cites: Cites }),
  askSuggestions: z.array(plainText(8, F.suggestionChars)).min(1).max(L.askSuggestions),
});
export type AuthoredScrollV3 = z.infer<typeof AuthoredScrollV3>;

/** The facts of a publication that are not the writer's: who the asset is, which revision, which language. */
export interface PublicationV3 {
  readonly assetId: string;
  readonly revision: number;
  readonly language: string;
  readonly explanationUnitId: string;
  readonly series?: z.infer<typeof SeriesRef> | undefined;
}

export interface EditorialV3Input {
  readonly authored: unknown;
  readonly publication: PublicationV3;
  readonly claims: readonly Claim[];
  readonly sources: readonly Source[];
  readonly production: ProductionRecord;
}

/** Where a compile stopped: the authored shape, the evidence it cites, or the document it made. */
export type EditorialV3Stage = 'authoring' | 'evidence' | 'document';

export type EditorialV3Outcome =
  | { readonly kind: 'compiled'; readonly document: ScrollDocumentV3; readonly provenance: ScrollProvenanceV3 }
  | { readonly kind: 'refused'; readonly stage: EditorialV3Stage; readonly issues: readonly IssueV3[] };

/** One cited part of the authored Scroll, by where it is, what a reader reads of it (each string with its name), and the claims it names. */
interface CitedPart {
  readonly path: string;
  readonly fields: readonly NamedText[];
  readonly cites: readonly string[];
  /** A quotation, which must match a passage it cites word for word and is the one text exempt from the copy rule. */
  readonly quotation?: string | undefined;
}

const named = (field: string, text: string | undefined): NamedText[] => (text === undefined ? [] : [{ field, text }]);

/** An item's label, then its note, both named after the item (`step 2`, counted from 1 in the order written). */
const itemFields = (
  noun: string,
  index: number,
  entry: { readonly label: string; readonly note?: string | undefined },
): NamedText[] => [
  ...named(`${noun} ${index + 1} label`, entry.label),
  ...named(`${noun} ${index + 1} note`, entry.note),
];

/**
 * Every reader-facing string of a picture with the name a finding gives it (its title, caption, the label of a step, the
 * text of a cell...). A chart's values are left out when `chartValues` is false, because the strict rule reads them as
 * points (`pointAgrees`), not as prose.
 */
export function pictureFields(picture: Picture, chartValues = true): NamedText[] {
  const head = [...named('title', picture.title), ...named('caption', picture.caption)];
  switch (picture.kind) {
    case 'statement': {
      const body = picture.statement;
      if (body.form === 'number') return [...head, ...named('value', body.value), ...named('label', body.label)];
      if (body.form === 'list')
        return [...head, ...body.items.flatMap((entry, index) => itemFields('item', index, entry))];
      return [...head, ...named('speaker', body.who), ...named('work', body.work), ...named('year', body.year)];
    }
    case 'flow':
      return [...head, ...picture.steps.flatMap((entry, index) => itemFields('step', index, entry))];
    case 'cycle':
      return [
        ...head,
        ...(picture.centre === undefined
          ? []
          : [...named('centre label', picture.centre.label), ...named('centre note', picture.centre.note)]),
        ...picture.items.flatMap((entry, index) => itemFields('item', index, entry)),
      ];
    case 'grid':
      return [
        ...head,
        ...picture.rows.flatMap((row, index) => named(`row ${index + 1} label`, row.label)),
        ...picture.columns.flatMap((column, index) => named(`column ${index + 1} label`, column.label)),
        ...picture.cells.flatMap((cell, index) => [
          ...named(`cell ${index + 1} text`, cell.text),
          ...named(`cell ${index + 1} note`, cell.note),
        ]),
      ];
    case 'chart':
      return [
        ...head,
        ...named('unit', picture.unit),
        ...picture.points.flatMap((point, index) => [
          ...(chartValues ? named(`point ${index + 1} value`, point.value) : []),
          ...itemFields('point', index, point),
        ]),
        ...picture.marks.flatMap((mark, index) => named(`mark ${index + 1} label`, mark.label)),
      ];
    case 'plan':
      return [
        ...head,
        ...picture.ways.flatMap((way, index) => named(`way ${index + 1} label`, way.label)),
        ...picture.places.flatMap((place, index) => itemFields('place', index, place)),
        ...(picture.steps ?? []).flatMap((step, index) => named(`step ${index + 1} name`, step)),
        ...picture.regions.flatMap((region, index) => named(`region ${index + 1} label`, region.label)),
        ...picture.routes.flatMap((route, index) => named(`route ${index + 1} label`, route.label)),
      ];
  }
}

/** Every reader-facing string of a picture: its title, caption, labels, notes, values and cells (see `pictureFields`). */
export function pictureTexts(picture: Picture, chartValues = true): string[] {
  return pictureFields(picture, chartValues).map((entry) => entry.text);
}

function beatFields(beat: AuthoredBeatV3): NamedText[] {
  const control = beat.kind === 'plain' && beat.control !== undefined ? named('control label', beat.control.label) : [];
  const cite =
    beat.kind === 'quote'
      ? [...named('speaker', beat.cite.who), ...named('work', beat.cite.work), ...named('year', beat.cite.year)]
      : [];
  return [...named('text', beat.text), ...named('simpler text', beat.simple), ...control, ...cite];
}

/** The quotation a picture sets large, which is cited like a quote beat. */
const quotationOf = (picture: Picture): string | undefined =>
  picture.kind === 'statement' && picture.statement.form === 'quote' ? picture.statement.text : undefined;

function citedParts(authored: AuthoredScrollV3, chartValues: boolean): CitedPart[] {
  const beats = authored.sections.flatMap((section) => section.beats);
  return [
    ...authored.pictures.map(({ picture, cites }, index): CitedPart => ({
      path: `pictures.${index}`,
      fields: pictureFields(picture, chartValues),
      cites,
      quotation: quotationOf(picture),
    })),
    ...beats.map((beat, index): CitedPart => ({
      path: `beats.${index}`,
      fields: beatFields(beat),
      cites: beat.cites,
      quotation: beat.kind === 'quote' ? beat.text : undefined,
    })),
    ...authored.asides.map((aside, index): CitedPart => ({
      path: `asides.${index}`,
      fields: [...named('title', aside.title), ...named('text', aside.text)],
      cites: aside.cites,
    })),
    { path: 'takeaway', fields: named('text', authored.takeaway.text), cites: authored.takeaway.cites },
  ];
}

/**
 * The figures in digits of `text` that no passage writes the same way (D-208): the same number, the same magnitude word
 * after it ("147.1 million", never "147.1 billion"), the same sign, and no notation a figure cannot state ("8.3bn",
 * "1.5×10⁻⁷"). Unlike the writer's rule, a figure a passage gives as one end of a range ("147.1 to 152.1 million km")
 * is accepted on its own: a person wrote and reads every hand-written Scroll. Figures in words (D-302) are the writer's
 * rule and come with it.
 */
function unstatedDigitFigures(text: string, passages: readonly string[]): string[] {
  return digitFiguresIn(text).filter((figure) => {
    const stated = readingsOf(figure, passages);
    return readingsOf(figure, [text]).some(
      (way) =>
        way.reading === 'unknown' ||
        !stated.some((entry) => entry.reading === way.reading && entry.negative === way.negative),
    );
  });
}

/** Text compared as a reader sees it: curly and straight quotes alike, dashes alike, runs of space as one. */
const comparable = (text: string): string =>
  text
    .replace(/[‘’‛′]/gu, "'")
    .replace(/[“”‟″]/gu, '"')
    .replace(/[–—]/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim();

/**
 * How strictly figures are read. `editorial` is a hand-written Scroll's rule: a figure a passage gives as one end of a
 * range is accepted on its own, figures in words are not read, and a chart's values are read like any text. `strict`
 * is the model writer's (D-208, D-302): every prose string uses `unstatedFigures`, a chart's values use `pointAgrees`
 * with the magnitude word that opens its unit, and the copy rule runs against `copySources`.
 */
export interface EvidenceOptions {
  readonly figures: 'editorial' | 'strict';
  /** What the copy rule compares against: every research text. Without it, the passages a part cites. */
  readonly copySources?: readonly string[] | undefined;
  /**
   * The handle the writer cites each claim by (`e11`), by claim id. With it, a strict finding of `authoring_number_not_in_evidence`
   * carries a `detail` that says where the figure is (D-444); without it, it is a code and a path, as it always was.
   */
  readonly handles?: ReadonlyMap<string, string> | undefined;
}

/** The magnitude word a chart's unit opens with ("million people"), which every value of the chart is written with. */
export function unitMagnitude(unit: string | undefined): Magnitude | undefined {
  const word = unit
    ?.trim()
    .split(/[\s-]+/u)[0]
    ?.toLowerCase();
  return word !== undefined && Object.hasOwn(MAGNITUDES, word) ? (word as Magnitude) : undefined;
}

/**
 * What the authored Scroll says against what it cites: every cited claim exists; every figure a part shows is in a
 * passage that part cites (D-208), and a figure in the kicker, title, dek, a section title or an ask suggestion is in
 * some passage the Scroll cites; a quotation matches a passage it cites word for word; and no other text copies nine
 * words in a row from a cited passage (or, strict, from any research text).
 *
 * In `strict` mode a header string is reported at its own path (`title`, `dek`, `sections.0.title`,
 * `askSuggestions.1`) and the copy rule covers it; a chart value that disagrees with its passages is reported at
 * `pictures.N.points.K.value`. Editorial mode reports every header problem at `header`, as it always has.
 */
export function evidenceIssues(
  authored: AuthoredScrollV3,
  claims: ReadonlyMap<string, string>,
  options: EvidenceOptions = { figures: 'editorial' },
): IssueV3[] {
  const strict = options.figures === 'strict';
  const issues: IssueV3[] = [];
  const parts = citedParts(authored, !strict);
  const quoteOf = (claimId: string): string => claims.get(claimId) ?? '';
  const unstated = (text: string, passages: readonly string[]): boolean =>
    strict ? unstatedFigures(text, passages).length > 0 : unstatedDigitFigures(text, passages).length > 0;
  const supported = (texts: readonly string[], cites: readonly string[]) => {
    const passages = cites.map(quoteOf);
    return texts.every((text) => !unstated(text, passages));
  };
  const everyCite = [...new Set(parts.flatMap((part) => part.cites))];
  // What a figure's detail names: the offered passages by the handle the writer cites them with. Strict mode with handles only.
  const handleOf = strict ? options.handles : undefined;
  const offered: PassageText[] =
    handleOf === undefined
      ? []
      : [...claims].flatMap(([claimId, text]) => {
          const handle = handleOf.get(claimId);
          return handle === undefined ? [] : [{ handle, text }];
        });
  const passagesOfCites = (cites: readonly string[]): PassageText[] =>
    handleOf === undefined
      ? []
      : cites.flatMap((claimId) => {
          const handle = handleOf.get(claimId);
          return handle === undefined || !claims.has(claimId) ? [] : [{ handle, text: quoteOf(claimId) }];
        });
  const withDetail = (path: string, detail: string | undefined): IssueV3 => ({
    code: 'authoring_number_not_in_evidence',
    path,
    ...(detail === undefined ? {} : { detail }),
  });
  // Strict mode (the model writer) compares with every research text: its material is built once. A finding there says what
  // was copied (`copyDetailV3`); a hand-written Scroll's finding is the code and the path, as it always was.
  const sharedMaterial = options.copySources === undefined ? undefined : copyMaterialOf(options.copySources);
  const copyIssue = (
    path: string,
    fields: readonly NamedText[],
    quotation: string | undefined,
    cites: readonly string[],
  ) => {
    const material = sharedMaterial ?? copyMaterialOf(cites.map(quoteOf));
    const runs = copiedRunsOfFields(
      fields.filter((entry) => entry.text !== quotation),
      material,
    );
    if (runs.length > 0)
      issues.push(
        strict ? { code: 'copied_passage', path, detail: copyDetailV3(runs) } : { code: 'copied_passage', path },
      );
  };
  for (const part of parts) {
    if (part.cites.some((claimId) => !claims.has(claimId)))
      issues.push({ code: 'authoring_cite_unknown', path: part.path });
    if (
      !supported(
        part.fields.map((entry) => entry.text),
        part.cites,
      )
    )
      issues.push(
        withDetail(
          part.path,
          handleOf === undefined ? undefined : numberDetailOfTexts(part.fields, passagesOfCites(part.cites), offered),
        ),
      );
    const passages = part.cites.map(quoteOf);
    if (
      part.quotation !== undefined &&
      !passages.some((passage) => comparable(passage).includes(comparable(part.quotation ?? '')))
    )
      issues.push({ code: 'quote_not_in_evidence', path: part.path });
    copyIssue(part.path, part.fields, part.quotation, part.cites);
  }
  const others = [
    authored.kicker,
    ...(authored.misconception.kind === 'myth' ? [authored.misconception.claim] : []),
    ...(authored.framing.kind === 'hypothetical' ? [...authored.framing.assumptions, ...authored.framing.kept] : []),
    ...(authored.framing.kind === 'perspective' ? [authored.framing.lens] : []),
  ];
  if (strict) {
    const own: { readonly path: string; readonly text: string }[] = [
      { path: 'title', text: authored.title },
      { path: 'dek', text: authored.dek },
      ...authored.sections.map((section, index) => ({ path: `sections.${index}.title`, text: section.title })),
      ...authored.askSuggestions.map((text, index) => ({ path: `askSuggestions.${index}`, text })),
    ];
    const passages = everyCite.map(quoteOf);
    for (const { path, text } of own) {
      if (unstated(text, passages))
        issues.push(
          withDetail(
            path,
            handleOf === undefined
              ? undefined
              : numberDetailOfTexts(named('text', text), passagesOfCites(everyCite), offered, 'scroll'),
          ),
        );
      copyIssue(path, named('text', text), undefined, everyCite);
    }
    if (!supported(others, everyCite)) issues.push({ code: 'authoring_number_not_in_evidence', path: 'header' });
  } else {
    const headings = [
      authored.kicker,
      authored.title,
      authored.dek,
      ...authored.sections.map((section) => section.title),
      ...authored.askSuggestions,
      ...others.slice(1),
    ];
    if (!supported(headings, everyCite)) issues.push({ code: 'authoring_number_not_in_evidence', path: 'header' });
  }
  // A chart's unit is words of its passages, as D-208 asks of a v2 chart: "light years" over a passage in kilometres is refused.
  authored.pictures.forEach(({ picture, cites }, index) => {
    if (picture.kind !== 'chart') return;
    const passages = cites.map(quoteOf);
    if (picture.unit !== undefined && !unitInPassages(picture.unit, passages))
      issues.push(
        withDetail(
          `pictures.${index}.picture.unit`,
          handleOf === undefined ? undefined : numberDetailOfUnit(picture.unit, passagesOfCites(cites), offered),
        ),
      );
    if (!strict) return;
    const values = new Set(picture.points.map((point) => plainFigure(point.value)));
    const magnitude = unitMagnitude(picture.unit);
    picture.points.forEach((point, pointIndex) => {
      // `pointAgrees` judges how a stated value is written (its magnitude word, a range's other end) and lets through a value
      // no passage states, which in v2 the ordinary figure check refused. A chart value is outside that check here, so a
      // value no cited passage writes at all is refused first.
      const stated = readingsOf(plainFigure(point.value), passages).length > 0;
      if (!stated || !pointAgrees({ value: point.value, magnitude }, passages, values))
        issues.push(
          withDetail(
            `pictures.${index}.points.${pointIndex}.value`,
            handleOf === undefined
              ? undefined
              : numberDetailOfValue(
                  `point ${pointIndex + 1}`,
                  { value: point.value, magnitude, values },
                  passagesOfCites(cites),
                  offered,
                ),
          ),
        );
    });
  });
  return issues;
}

/** Assigns what is code's: section ids `s1…`, beat ids `b1…` in reading order, aside ids `a1…` next to their beat. */
export function assemble(authored: AuthoredScrollV3, publication: PublicationV3): Omit<ScrollDocumentV3, 'integrity'> {
  let beatNumber = 0;
  const sections = authored.sections.map((section, sectionIndex) => ({
    id: `s${sectionIndex + 1}`,
    title: section.title,
    beats: section.beats.map((beat): Beat => {
      beatNumber += 1;
      const { cites: _cites, ...stored } = beat;
      return { ...stored, id: `b${beatNumber}` };
    }),
  }));
  const asides = authored.asides.map((aside, index) => ({
    id: `a${index + 1}`,
    kind: aside.kind,
    title: aside.title,
    text: aside.text,
    anchorBeat: `b${aside.beat}`,
    collapsed: aside.collapsed,
  }));
  const parts = { sections, asides, takeaway: authored.takeaway.text };
  return {
    schemaVersion: SCROLL_DOCUMENT_V3_SCHEMA_VERSION,
    assetId: publication.assetId,
    revision: publication.revision,
    language: publication.language,
    explanationUnitId: publication.explanationUnitId,
    ...(publication.series === undefined ? {} : { series: publication.series }),
    theme: authored.theme,
    kicker: authored.kicker,
    title: authored.title,
    dek: authored.dek,
    shape: authored.shape,
    framing: authored.framing,
    misconception: authored.misconception,
    pictures: authored.pictures.map(({ picture }) => picture),
    ...parts,
    askSuggestions: authored.askSuggestions,
    limitsVersion: SCROLL_LIMITS_V3_VERSION,
    measures: computeMeasuresV3(parts),
  };
}

export function citationsOf(authored: AuthoredScrollV3, document: ScrollDocumentV3): ScrollProvenanceV3['citations'] {
  const beats = authored.sections.flatMap((section) => section.beats);
  const beatIds = document.sections.flatMap((section) => section.beats.map((beat) => beat.id));
  return [
    ...beats.map((beat, index) => ({ partId: beatIds[index] ?? `b${index + 1}`, claimIds: [...new Set(beat.cites)] })),
    ...authored.asides.map((aside, index) => ({ partId: `a${index + 1}`, claimIds: [...new Set(aside.cites)] })),
    ...authored.pictures.map(({ picture, cites }) => ({ partId: picture.id, claimIds: [...new Set(cites)] })),
    { partId: TAKEAWAY_PART_ID, claimIds: [...new Set(authored.takeaway.cites)] },
  ];
}

/**
 * Compiles a hand-written document v3 into the stored document and its internal provenance. Code sets the ids, the
 * measures and the integrity hash; the evidence rules run on the authored form (every figure and quotation in a passage
 * its part cites, no copying), then the whole document is validated as it will be stored (`validateDocumentV3`).
 *
 * Pure and deterministic: the same input compiles to the same bytes, which is what makes a repeated import a no-op.
 * Findings carry codes and paths, never text. A picture may not be called `takeaway`, the part id of the end summary.
 */
export function compileEditorialV3(input: EditorialV3Input): EditorialV3Outcome {
  const parsed = AuthoredScrollV3.safeParse(input.authored);
  if (!parsed.success)
    return {
      kind: 'refused',
      stage: 'authoring',
      issues: uniqueIssuesV3(parsed.error.issues.map(issueFromSchema)),
    };
  const authored = parsed.data;
  const sourceIds = new Set(input.sources.map((source) => source.sourceId));
  const claims = new Map(input.claims.map((claim) => [claim.claimId, claim.quote]));
  const evidence = uniqueIssuesV3([
    ...evidenceIssues(authored, claims),
    ...input.claims.flatMap((claim, index): IssueV3[] =>
      sourceIds.has(claim.sourceId) ? [] : [{ code: 'authoring_reference_unknown', path: `claims.${index}.sourceId` }],
    ),
    ...authored.pictures.flatMap(({ picture }, index): IssueV3[] =>
      picture.id === TAKEAWAY_PART_ID ? [{ code: 'id_duplicate', path: `pictures.${index}.picture.id` }] : [],
    ),
  ]);
  if (evidence.length > 0) return { kind: 'refused', stage: 'evidence', issues: evidence };
  const unsealed = assemble(authored, input.publication);
  const sealed = {
    ...unsealed,
    integrity: { method: INTEGRITY_METHOD, sha256: computeIntegrityV3(unsealed) },
  } as ScrollDocumentV3;
  const validated = validateDocumentV3(JSON.parse(JSON.stringify(sealed)) as unknown);
  if (validated.kind === 'invalid') return { kind: 'refused', stage: 'document', issues: validated.issues };
  const document = validated.document;
  const cited = new Set(citationsOf(authored, document).flatMap((entry) => entry.claimIds));
  const claimsUsed = input.claims.filter((claim) => cited.has(claim.claimId));
  const sourcesUsed = input.sources.filter((source) => claimsUsed.some((claim) => claim.sourceId === source.sourceId));
  return {
    kind: 'compiled',
    document,
    provenance: {
      schemaVersion: SCROLL_PROVENANCE_V3_SCHEMA_VERSION,
      assetId: input.publication.assetId,
      revision: input.publication.revision,
      documentSha256: document.integrity.sha256,
      claims: claimsUsed,
      sources: sourcesUsed,
      citations: citationsOf(authored, document),
      checks: [{ name: 'evidence', version: 'scroll-checks-v3.v1', verdict: 'pass', reasonCodes: [] }],
      production: input.production,
    },
  };
}
