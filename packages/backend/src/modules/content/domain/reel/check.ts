import { RECIPES } from '../library/index.js';
import type { ReelScript } from './script.js';

/** Cutroom plans six units and refuses a plan it cannot cut from whole sentences (CF-63). */
export const MIN_SENTENCES = 6;
/** More than eight sentences has never helped: a seventh merges two shots into one (sunburn-v4). */
export const MAX_SENTENCES = 8;
/**
 * One sentence is one shot. Narration runs at about 2.5 words a second and a shot over about nine
 * seconds makes a clip larger than the witness model accepts (CF-63, seasons-v4).
 */
export const MAX_WORDS_PER_SENTENCE = 22;

export type ReelFindingCode =
  | 'recipe_unknown'
  | 'sentence_count'
  | 'sentence_not_complete'
  | 'sentence_too_long'
  | 'sentence_ends_on_sun'
  | 'sentence_without_claim'
  | 'claim_listed_twice'
  | 'claim_unlisted'
  | 'claim_unreferenced'
  | 'main_claim_missing'
  | 'claim_without_source'
  | 'claim_source_twice'
  | 'source_claim_unknown'
  | 'source_not_recipe_scroll'
  | 'claim_without_scene'
  | 'criterion_id_twice'
  | 'criterion_claim_unlisted'
  | 'must_not_show_not_presence'
  | 'must_not_show_standing_rules_missing';

/** `at` names the narration index, claim or criterion the finding is about. */
export interface ReelFinding {
  readonly code: ReelFindingCode;
  readonly at?: string;
}

const wordsOf = (text: string): readonly string[] => text.trim().split(/\s+/).filter(Boolean);

/** Cutroom's speech timing repeats a word it cannot place at a sentence end ("Sun. Sun.", P-001). */
function endsOnSun(text: string): boolean {
  const lastWord = /([A-Za-z']+)[^A-Za-z]*$/.exec(text)?.[1];
  return lastWord?.toLowerCase() === 'sun';
}

function checkNarration(script: ReelScript): ReelFinding[] {
  const { narration } = script.brief;
  const findings: ReelFinding[] = [];
  if (narration.length < MIN_SENTENCES || narration.length > MAX_SENTENCES)
    findings.push({ code: 'sentence_count', at: String(narration.length) });
  narration.forEach((sentence, index) => {
    const at = `narration[${index}]`;
    if (!/[.!?]["')\]]*$/.test(sentence.text.trim())) findings.push({ code: 'sentence_not_complete', at });
    if (wordsOf(sentence.text).length > MAX_WORDS_PER_SENTENCE) findings.push({ code: 'sentence_too_long', at });
    if (endsOnSun(sentence.text)) findings.push({ code: 'sentence_ends_on_sun', at });
    if (sentence.claimIds.length === 0) findings.push({ code: 'sentence_without_claim', at });
  });
  return findings;
}

/** The claim list is consistent with the narration the way Cutroom's own request check needs. */
function checkClaims(script: ReelScript): ReelFinding[] {
  const { narration, claims } = script.brief;
  const findings: ReelFinding[] = [];
  const listed = new Set<string>();
  for (const claim of claims) {
    if (listed.has(claim.id)) findings.push({ code: 'claim_listed_twice', at: claim.id });
    listed.add(claim.id);
  }
  const referenced = new Set<string>();
  narration.forEach((sentence, index) => {
    for (const id of sentence.claimIds) {
      referenced.add(id);
      if (!listed.has(id)) findings.push({ code: 'claim_unlisted', at: `narration[${index}]` });
    }
  });
  for (const id of listed) if (!referenced.has(id)) findings.push({ code: 'claim_unreferenced', at: id });
  if (!claims.some((claim) => claim.role === 'main')) findings.push({ code: 'main_claim_missing' });
  return findings;
}

/** Every claim rests on the twin Scroll, at the revision the script names. */
function checkSources(script: ReelScript): ReelFinding[] {
  const recipe = (RECIPES as Readonly<Record<string, { readonly assetId: string }>>)[script.recipe];
  const { claims, claimSources } = script.brief;
  const findings: ReelFinding[] = [];
  const listed = new Set(claims.map((claim) => claim.id));
  const sourced = new Set<string>();
  for (const source of claimSources) {
    if (!listed.has(source.claimId)) findings.push({ code: 'source_claim_unknown', at: source.claimId });
    if (sourced.has(source.claimId)) findings.push({ code: 'claim_source_twice', at: source.claimId });
    sourced.add(source.claimId);
    if (recipe !== undefined && source.assetId !== recipe.assetId)
      findings.push({ code: 'source_not_recipe_scroll', at: source.claimId });
  }
  for (const claim of claims) if (!sourced.has(claim.id)) findings.push({ code: 'claim_without_source', at: claim.id });
  return findings;
}

const standingRules = [/public figure/i, /written words/i];

function checkCriteria(script: ReelScript): ReelFinding[] {
  const { claims, criteria } = script.brief;
  const findings: ReelFinding[] = [];
  const listed = new Set(claims.map((claim) => claim.id));
  const ids = new Set<string>();
  for (const criterion of [...criteria.mustShow, ...criteria.mustNotShow]) {
    if (ids.has(criterion.id)) findings.push({ code: 'criterion_id_twice', at: criterion.id });
    ids.add(criterion.id);
    if (criterion.claimId !== undefined && !listed.has(criterion.claimId))
      findings.push({ code: 'criterion_claim_unlisted', at: criterion.id });
  }
  for (const criterion of criteria.mustNotShow)
    if (criterion.type !== 'presence') findings.push({ code: 'must_not_show_not_presence', at: criterion.id });
  const scenes = new Set(criteria.mustShow.map((criterion) => criterion.claimId));
  for (const claim of claims) if (!scenes.has(claim.id)) findings.push({ code: 'claim_without_scene', at: claim.id });
  if (!standingRules.every((rule) => criteria.mustNotShow.some((criterion) => rule.test(criterion.text))))
    findings.push({ code: 'must_not_show_standing_rules_missing' });
  return findings;
}

/**
 * The product's own checks of a Reel script, free and offline. They encode what real orders taught
 * (CF-63): six to eight whole sentences of at most 22 words, none ending on "Sun", every claim
 * bound to a sentence, a scene and a source in the twin Scroll, and the two standing prohibitions.
 * An empty result means the script may be rehearsed; it is not a judgement of truth or taste.
 */
export function checkReelScript(script: ReelScript): readonly ReelFinding[] {
  if (!Object.hasOwn(RECIPES, script.recipe)) return [{ code: 'recipe_unknown', at: script.recipe }];
  return [...checkNarration(script), ...checkClaims(script), ...checkSources(script), ...checkCriteria(script)];
}
