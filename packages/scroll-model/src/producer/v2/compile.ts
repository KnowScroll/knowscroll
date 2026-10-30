import { uniqueIssuesV2, type IssueV2 } from '../../v2/issues.js';
import { validateDocumentV2 } from '../../v2/validate.js';
import type { ScrollDocumentV2 } from '../../v2/document.js';
import { assembleScrollV2, type AssemblyMap, type PublicationV2, type RecipeDataV2 } from './assemble.js';
import type { AuthoredScrollV2 } from './authoring-schema.js';
import { authoringIssuesV2, type AuthoringRulesInput } from './rules.js';

export interface CompileV2Input extends AuthoringRulesInput {
  readonly publication: PublicationV2;
  readonly recipe: RecipeDataV2;
}

export type CompileV2Outcome =
  | {
      readonly kind: 'compiled';
      readonly document: ScrollDocumentV2;
      /** What the library must still settle for this Scroll (an unreviewed misconception source). */
      readonly notices: readonly IssueV2[];
      /** The claims each part rests on, by the document's own ids (`s3`, `a1`, `recap`). Internal; never served. */
      readonly citations: Readonly<Record<string, readonly string[]>>;
    }
  | { readonly kind: 'refused'; readonly stage: 'authoring' | 'document'; readonly issues: readonly IssueV2[] };

/** The writer's item a path of the assembled document came from. */
function authoredPath(path: string, document: ScrollDocumentV2, map: AssemblyMap): string {
  const [root, index, field, blockIndex] = path.split('.');
  if (root === 'stops') {
    const item = index === undefined ? undefined : map.stopItem[Number(index)];
    if (item === undefined) return 'items';
    if (field === undefined) return `items.${item}`;
    if (field === 'answer') return `items.${item}.options`;
    if (field !== 'blocks') return `items.${item}.${field}`;
    const stop = document.stops[Number(index)];
    const block = stop?.kind === 'read' && blockIndex !== undefined ? stop.blocks[Number(blockIndex)] : undefined;
    return `items.${item}${block === undefined || block.type === 'paragraph' ? '.text' : `.${block.type}`}`;
  }
  if (root === 'asides') {
    const item = index === undefined ? undefined : map.asideItem[Number(index)];
    return item === undefined ? 'items' : `items.${item}`;
  }
  if (root === 'stage') {
    const entry = index === 'states' && field !== undefined ? document.stage?.states[Number(field)] : undefined;
    const stopIndex = entry === undefined ? undefined : document.stops.findIndex((stop) => stop.id === entry.stop);
    const item = stopIndex === undefined || stopIndex < 0 ? undefined : map.stopItem[stopIndex];
    return item === undefined ? 'items' : `items.${item}.stage`;
  }
  if (root === 'recap' || root === 'askSuggestions' || root === 'title' || root === 'dek') return root;
  return '$';
}

/** Claim ids each part cites, by document id. */
function citationsOf(
  authored: AuthoredScrollV2,
  document: ScrollDocumentV2,
  map: AssemblyMap,
  claimIdOf: ReadonlyMap<string, string>,
): Record<string, readonly string[]> {
  const claims = (handles: readonly string[]): string[] => [
    ...new Set(handles.flatMap((handle) => (claimIdOf.has(handle) ? [claimIdOf.get(handle) ?? ''] : []))),
  ];
  const out: Record<string, readonly string[]> = {};
  const cited = (itemIndex: number | undefined) => {
    const item = itemIndex === undefined ? undefined : authored.items[itemIndex];
    return item === undefined ? [] : claims(item.cites);
  };
  document.stops.forEach((stop, index) => (out[stop.id] = cited(map.stopItem[index])));
  document.asides.forEach((aside, index) => (out[aside.id] = cited(map.asideItem[index])));
  out['recap'] = claims(authored.recap.cites);
  return out;
}

/**
 * Compiles an authored v2 Scroll: the authoring rules (citations, copying, placement, the recipe's
 * myth and variant), then the assembled document through `validateDocumentV2` (word limits, the
 * budget, the Final call, the limits aside, the stage, reading time, measures, hash). Both sets of
 * findings are reported together, at the writer's items, so a single repair can fix them all.
 *
 * Pure and deterministic: the same input always gives the same outcome. Never throws on model
 * output.
 */
export function compileAuthoredV2(authored: AuthoredScrollV2, input: CompileV2Input): CompileV2Outcome {
  const own = authoringIssuesV2(authored, input);
  const assembly = assembleScrollV2(authored, input.publication, input.recipe);
  if (assembly.kind === 'unassemblable')
    return {
      kind: 'refused',
      stage: 'authoring',
      issues: uniqueIssuesV2([...own, { code: 'stops_too_few', path: 'items' }]),
    };
  const checked = validateDocumentV2(assembly.document);
  const fromDocument =
    checked.kind === 'invalid'
      ? checked.issues.map((issue): IssueV2 => ({
          code: issue.code,
          path: authoredPath(issue.path, assembly.document, assembly.map),
        }))
      : [];
  const issues = uniqueIssuesV2([...own, ...fromDocument]);
  if (issues.length > 0 || checked.kind !== 'valid')
    return { kind: 'refused', stage: own.length > 0 ? 'authoring' : 'document', issues };
  return {
    kind: 'compiled',
    document: checked.document,
    notices: checked.notices,
    citations: citationsOf(authored, checked.document, assembly.map, input.evidence.claimIdOf),
  };
}
