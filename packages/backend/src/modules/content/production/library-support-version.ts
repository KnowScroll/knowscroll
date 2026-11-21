import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * The version of the library support check is a hash of everything that decides what the check says (D-415): the instructions, the rules applied to
 * each verdict, the policy and the code that extracts the sentences, judges the verdicts and decides the revision's verdict. A stored result is keyed
 * by it, so a change to any of them, including the ask check's shared code that the library check reuses, is a new measurement and never mixes
 * with an old one. Nobody has to remember to bump a number.
 */

/** The modules whose code decides what the check says, relative to this folder, without an extension (the source in tests, the build in a release). */
export const CHECK_SOURCE_MODULES: readonly string[] = [
  '../domain/ask-support',
  '../domain/library-support',
  './ask-support',
  './library-support',
  './library-support-step',
];

/**
 * A module's text without comments and layout, so that rewording a comment or reformatting a line does not make a new version, and any change
 * to the code does. Block comments and whole-line comments go and runs of white space become one space.
 */
export function normalisedSource(text: string): string {
  return text
    .replaceAll(/\/\*[\s\S]*?\*\//gu, '')
    .replaceAll(/^\s*\/\/.*$/gmu, '')
    .replaceAll(/\s+/gu, ' ')
    .trim();
}

/** The normalised text of each module of `CHECK_SOURCE_MODULES`: from the `.js` a release holds, or the `.ts` a test runs. */
export function readCheckSources(modules: readonly string[] = CHECK_SOURCE_MODULES): readonly string[] {
  return modules.map((module) => {
    for (const extension of ['.js', '.ts']) {
      try {
        return normalisedSource(readFileSync(new URL(`${module}${extension}`, import.meta.url), 'utf8'));
      } catch {
        // The other extension is the one this process runs from.
      }
    }
    throw new Error(`LIBRARY_SUPPORT_SOURCE_MISSING:${module}`);
  });
}

/** What the version is made of. */
export interface CheckerIdentity {
  readonly instructions: string;
  readonly rules: unknown;
  readonly policy: unknown;
  /** The normalised text of the modules that decide what the check says. */
  readonly sources: readonly string[];
}

/** The characters of the hash a version keeps: the harness limits a version to 32 characters, and a prefix takes at most 24 of them. */
const VERSION_HASH_CHARS = 8;

/** The prefix of the version of the check of a stored document v2 Scroll (D-415). */
export const V2_VERSION_PREFIX = 'library-support-check.';

/** The most characters a version may have: the production harness refuses a longer role or policy version. */
export const MAX_VERSION_CHARS = 32;

/**
 * The prefix (`library-support-check.` unless another is given) and the first eight hex digits of the SHA-256 of the identity. The same identity gives the
 * same version in every process. A prefix longer than 24 characters is refused, because the version would pass the harness's limit.
 */
export function checkerVersionOf(identity: CheckerIdentity, prefix: string = V2_VERSION_PREFIX): string {
  if (prefix.length + VERSION_HASH_CHARS > MAX_VERSION_CHARS)
    throw new Error('LIBRARY_SUPPORT_VERSION_PREFIX_TOO_LONG');
  const hash = createHash('sha256')
    .update(JSON.stringify([identity.instructions, identity.rules, identity.policy, identity.sources]))
    .digest('hex');
  return `${prefix}${hash.slice(0, VERSION_HASH_CHARS)}`;
}
