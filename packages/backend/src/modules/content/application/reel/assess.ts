import { checkReelScript, type ReelFinding } from '../../domain/reel/check.js';
import {
  findRepetition,
  reelFingerprints,
  type ReelFingerprints,
  type Repetition,
} from '../../domain/reel/fingerprint.js';
import { LEGACY_REELS_ON_RECORD } from '../../domain/reel/legacy-corpus.js';
import { RECIPES, type RecipeKey } from '../../domain/library/index.js';
import type { ReelScript } from '../../domain/reel/script.js';
import type { ReelPorts, TwinScroll } from './ports.js';

export type ScriptRefusal =
  | { readonly code: 'script_unknown' }
  | { readonly code: 'script_findings'; readonly findings: readonly ReelFinding[] }
  | { readonly code: 'repetition'; readonly repetition: Repetition }
  | { readonly code: 'scroll_not_published'; readonly assetId: string; readonly revision: number }
  | { readonly code: 'twin_unit_mismatch' };

export interface RecipeFacts {
  readonly assetId: string;
  readonly explanationUnitId: string;
  readonly topicId: string;
}

export const recipeOf = (script: ReelScript): RecipeFacts => RECIPES[script.recipe as RecipeKey];

export interface LintedScript {
  /** The name an operator orders it by. */
  readonly name: string;
  readonly script: ReelScript;
  readonly fingerprints: ReelFingerprints;
}

/**
 * The offline half of every order: the script passes the product's own checks and shares no
 * fingerprint with a Reel v1 made (CF-63). No database, no network.
 */
export function lintReelScript(
  p: Pick<ReelPorts, 'sha256'>,
  name: string,
  script: ReelScript,
): { readonly kind: 'linted'; readonly linted: LintedScript } | ({ readonly kind: 'refused' } & ScriptRefusal) {
  const findings = checkReelScript(script);
  if (findings.length > 0) return { kind: 'refused', code: 'script_findings', findings };
  const fingerprints = reelFingerprints(script.brief, p.sha256);
  const repetition = findRepetition(fingerprints, LEGACY_REELS_ON_RECORD);
  if (repetition !== undefined) return { kind: 'refused', code: 'repetition', repetition };
  return { kind: 'linted', linted: { name, script, fingerprints } };
}

/** The same, for a script that ships in this release, by the name an operator orders it by. */
export function lintScript(p: Pick<ReelPorts, 'scripts' | 'sha256'>, scriptName: string) {
  const script = p.scripts.get(scriptName);
  return script === undefined
    ? ({ kind: 'refused', code: 'script_unknown' } as const)
    : lintReelScript(p, scriptName, script);
}

/**
 * The online half: the Scroll every claim rests on is admitted here at the revision the script
 * names, it is the recipe's own unit, and no Reel already in this world repeats the script.
 */
export async function checkAgainstWorld(
  p: Pick<ReelPorts, 'catalogue'>,
  linted: LintedScript,
): Promise<{ readonly kind: 'ready'; readonly twin: TwinScroll } | ({ readonly kind: 'refused' } & ScriptRefusal)> {
  const { script, fingerprints } = linted;
  const recipe = recipeOf(script);
  // The check that linted the script guarantees every claim names the recipe's Scroll at one revision.
  const source = script.brief.claimSources[0]!;
  const twin = await p.catalogue.admittedScroll(source.assetId, source.assetRevision);
  if (twin === undefined)
    return { kind: 'refused', code: 'scroll_not_published', assetId: source.assetId, revision: source.assetRevision };
  if (twin.explanationUnitId !== recipe.explanationUnitId) return { kind: 'refused', code: 'twin_unit_mismatch' };
  const repetition = findRepetition(fingerprints, await p.catalogue.reelsOnRecord(script.id));
  if (repetition !== undefined) return { kind: 'refused', code: 'repetition', repetition };
  return { kind: 'ready', twin };
}
