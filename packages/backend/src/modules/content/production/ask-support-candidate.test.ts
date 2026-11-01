import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SentenceUnderCheck } from '../domain/ask-support.js';
import {
  CANDIDATE_INSTRUCTIONS_MAX_BYTES,
  candidateCheckerRole,
  readCandidateInstructions,
  type CandidateCheckerInstructions,
} from './ask-support-candidate.js';
import {
  ASK_SUPPORT_CHECK_VERSION,
  ASK_SUPPORT_INSTRUCTIONS,
  ASK_SUPPORT_ROLE_ID,
  askSupportRole,
} from './ask-support.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A file as a candidate would be: labelled CI text that names the three verdicts the checker replies with. */
const INSTRUCTIONS =
  'CI candidate instructions: judge each sentence against the passages it cites.\nReply "supported", "unsupported" or "no_claim" for each.\n';

function accepted(bytes: Uint8Array): CandidateCheckerInstructions {
  const reading = readCandidateInstructions(bytes);
  if (reading.kind !== 'accepted') throw new Error(`CI: expected the file to be accepted, got ${reading.code}`);
  return reading.candidate;
}

describe('reading candidate checker instructions (D-280)', () => {
  const TEXT = INSTRUCTIONS;

  it('accepts UTF-8 plain text and labels it by the SHA-256 of the file’s bytes', () => {
    const candidate = accepted(encode(TEXT));
    expect(candidate.text).toBe(TEXT);
    expect(candidate.sha256).toBe(createHash('sha256').update(TEXT).digest('hex'));
    // The version names the candidate in the ledger, and is a version the harness accepts.
    expect(candidate.version).toBe(`ask-support-check.cand-${candidate.sha256.slice(0, 8)}`);
    expect(candidate.version).toMatch(/^[A-Za-z0-9._-]{1,32}$/u);
    expect(candidate.version).not.toBe(ASK_SUPPORT_CHECK_VERSION);
  });

  it('accepts the production instructions themselves, so the text of a version can be replayed as a candidate before it is released', () => {
    const candidate = accepted(encode(ASK_SUPPORT_INSTRUCTIONS));
    expect(candidate.text).toBe(ASK_SUPPORT_INSTRUCTIONS);
  });

  it('gives different text a different hash and version', () => {
    const first = accepted(encode(TEXT));
    const second = accepted(encode(`${TEXT}One more rule.\n`));
    expect(second.sha256).not.toBe(first.sha256);
    expect(second.version).not.toBe(first.version);
  });

  it('accepts tabs, Windows line breaks and letters of any script', () => {
    expect(
      readCandidateInstructions(
        encode(`Rule:\tjudge “each” sentence.\r\nÉcrivez en français — 判断。\r\n${INSTRUCTIONS}`),
      ).kind,
    ).toBe('accepted');
  });

  it('accepts exactly the largest size and refuses one byte more', () => {
    const atLimit = INSTRUCTIONS + 'a'.repeat(CANDIDATE_INSTRUCTIONS_MAX_BYTES - INSTRUCTIONS.length);
    expect(readCandidateInstructions(encode(atLimit)).kind).toBe('accepted');
    expect(readCandidateInstructions(encode(`${atLimit}a`))).toEqual({ kind: 'refused', code: 'too_large' });
  });

  it('counts bytes, not characters, against the limit', () => {
    // Two bytes each: half the limit in characters is the whole limit in bytes.
    const twoByte = INSTRUCTIONS + 'é'.repeat(Math.floor((CANDIDATE_INSTRUCTIONS_MAX_BYTES - INSTRUCTIONS.length) / 2));
    expect(readCandidateInstructions(encode(twoByte)).kind).toBe('accepted');
    expect(readCandidateInstructions(encode(`${twoByte}é`))).toEqual({ kind: 'refused', code: 'too_large' });
  });

  it.each([
    ['nothing', ''],
    ['only spaces and line breaks', '  \n\t \r\n'],
  ])('refuses a file with %s as empty', (_name, text) => {
    expect(readCandidateInstructions(encode(text))).toEqual({ kind: 'refused', code: 'empty' });
  });

  it('refuses bytes that are not UTF-8', () => {
    expect(readCandidateInstructions(Uint8Array.from([0x52, 0x75, 0x6c, 0x65, 0xff, 0xfe]))).toEqual({
      kind: 'refused',
      code: 'not_utf8',
    });
    // A UTF-8 encoded surrogate half is not UTF-8 either.
    expect(readCandidateInstructions(Uint8Array.from([0xed, 0xa0, 0x80]))).toEqual({
      kind: 'refused',
      code: 'not_utf8',
    });
  });

  it.each([
    ['a NUL byte', 'Judge\u0000 each sentence.'],
    ['a bell character', 'Judge\u0007 each sentence.'],
    ['an escape sequence', 'Judge \u001b[31meach\u001b[0m sentence.'],
    ['a byte-order mark', '\uFEFFJudge each sentence.'],
    ['a zero-width space', 'Judge each\u200B sentence.'],
    ['a bidirectional override', 'Judge each sentence.\u202E'],
  ])('refuses text with %s, so what an editor shows is what the model is sent', (_name, text) => {
    expect(readCandidateInstructions(encode(`${INSTRUCTIONS}${text}`))).toEqual({
      kind: 'refused',
      code: 'not_plain_text',
    });
  });

  /**
   * A candidate's text is sent to the provider as the checker's system prompt and kept in the request store, so a file
   * named by mistake (a settings file, a key) must be refused before a word of it goes anywhere. These are labelled fakes.
   */
  it.each([
    ['a line that sets a variable', `${INSTRUCTIONS}CI_FAKE_SETTING=ci-value-not-a-secret\n`],
    ['an exported variable', `${INSTRUCTIONS}export CI_FAKE_SETTING="ci-value"\n`],
    ['an indented assignment with spaces', `${INSTRUCTIONS}  ci_fake_setting = ci-value\n`],
    ['an assignment on the first line', `CI_FAKE_SETTING=1\n${INSTRUCTIONS}`],
    ['an assignment among Windows line breaks', INSTRUCTIONS.replaceAll('\n', '\r\n') + 'CI_FAKE_SETTING=1\r\n'],
  ])('refuses a file with %s, even when it names all three verdicts', (_name, text) => {
    expect(readCandidateInstructions(encode(text))).toEqual({ kind: 'refused', code: 'not_instructions' });
  });

  it.each([
    ['"supported"', 'Judge each sentence. Reply "unsupported" or "no_claim" for each.'],
    ['"unsupported"', 'Judge each sentence. Reply "supported" or "no_claim" for each.'],
    ['"no_claim"', 'Judge each sentence. Reply "supported" or "unsupported" for each.'],
  ])('refuses a file that does not name the verdict %s', (_name, text) => {
    expect(readCandidateInstructions(encode(text))).toEqual({ kind: 'refused', code: 'not_instructions' });
  });

  it('refuses text that is not instructions at all, and never puts the text in the refusal', () => {
    const reading = readCandidateInstructions(
      encode('-----BEGIN CI FAKE KEY-----\nZmFrZQ==\n-----END CI FAKE KEY-----\n'),
    );
    expect(reading).toEqual({ kind: 'refused', code: 'not_instructions' });
    expect(JSON.stringify(reading)).not.toContain('FAKE');
  });

  it('does not take a sentence that mentions an equals sign, or a JSON example, for an assignment', () => {
    const text = `${INSTRUCTIONS}Reply {"sentences": [{"n": 1, "verdict": "supported"}]}. A sum such as 1 + 1 = 2 is a figure.\n- n = the number of the sentence, in the list.\n`;
    // Only a line that begins with a name and an equals sign is an assignment: a dash, a brace or a word first is not.
    expect(readCandidateInstructions(encode(text)).kind).toBe('accepted');
  });
});

describe('the role built from candidate instructions (D-280)', () => {
  const sentences: readonly SentenceUnderCheck[] = [
    { number: 1, text: 'The lamp turns once a minute.', cites: ['e1'] },
  ];
  const passages = [{ handle: 'e1', text: 'The lamp turns once a minute, driven by a small motor.' }];
  const candidate = accepted(encode(INSTRUCTIONS));

  it('changes the instructions and the version and nothing else: same role id, budget, ceilings and repair hints', () => {
    const production = askSupportRole(sentences, passages);
    const role = candidateCheckerRole(candidate, sentences, passages);
    expect(role.instructions).toBe(candidate.text);
    expect(role.instructions).not.toBe(ASK_SUPPORT_INSTRUCTIONS);
    expect(role.version).toBe(candidate.version);
    expect(role.id).toBe(ASK_SUPPORT_ROLE_ID);
    expect({ ...role, instructions: '', version: '', outputSchema: undefined }).toEqual({
      ...production,
      instructions: '',
      version: '',
      outputSchema: undefined,
    });
  });

  it('still reads its reply through the production rules: a quote that is not in a cited passage makes the sentence unsupported', () => {
    const role = candidateCheckerRole(candidate, sentences, passages);
    const reply = { sentences: [{ n: 1, verdict: 'supported', quote: 'words that no passage ever contained' }] };
    expect(role.outputSchema.parse(reply).sentences[0]).toMatchObject({
      verdict: 'unsupported',
      code: 'quote_not_in_cited_passages',
    });
  });
});

/**
 * Candidate instructions are for the operator's replay alone (D-280). Nothing that serves a person reads a file of
 * instructions: this is an allow-list over the source text, as the Quick answer's wall is. The only files that may name the
 * candidate reader, the role it builds or the option that supplies it are the candidate module, the replay, the content
 * module's export list for the operator, and the operator's own command. A file that makes or runs production (the writer
 * stage, the job, the Quick answer, any worker consumer, any HTTP handler) naming one fails here, on purpose.
 */
const repository = fileURLToPath(new URL('../../../../../../', import.meta.url));
const SKIPPED_FOLDERS = new Set(['node_modules', 'dist', '.git', 'coverage']);
const SOURCE = /\.(?:ts|tsx|mjs|cjs|js)$/;
const CANDIDATE =
  /ask-support-candidate|candidateCheckerRole|readCandidateInstructions|readCandidateFile|CandidateChecker|CANDIDATE_INSTRUCTIONS|checker-instructions|checkerInstructions/u;

const ALLOWED = [
  /^packages\/backend\/src\/modules\/content\/production\/ask-support-candidate(?:\.test)?\.ts$/,
  /^packages\/backend\/src\/modules\/content\/production\/ask-support-replay\.ts$/,
  /^packages\/backend\/src\/modules\/content\/adapters\/nest-providers\.ts$/,
  /^apps\/worker\/src\/ask-check-operator(?:\.candidate)?(?:\.test)?\.ts$/,
  /^apps\/worker\/src\/operator\.ts$/,
];

function sourcesUnder(folder: string): string[] {
  return readdirSync(join(repository, folder), { withFileTypes: true }).flatMap((entry) => {
    const path = `${folder}/${entry.name}`;
    if (entry.isDirectory()) return SKIPPED_FOLDERS.has(entry.name) ? [] : sourcesUnder(path);
    return SOURCE.test(entry.name) ? [path] : [];
  });
}

/** The files, by repository-relative path, whose text names the candidate. */
const mentioning = (paths: readonly string[], read: (path: string) => string): string[] =>
  paths.filter((path) => CANDIDATE.test(read(path)));

describe('who can name candidate checker instructions', () => {
  const read = (path: string) => readFileSync(join(repository, path), 'utf8');
  const everything = ['packages/backend/src', 'apps/worker/src', 'apps/api/src'].flatMap(sourcesUnder);

  it('is the replay and the operator command alone: no production file, worker consumer, HTTP handler or Quick answer', () => {
    expect(everything.length).toBeGreaterThan(500);
    const outside = everything.filter((path) => !ALLOWED.some((allowed) => allowed.test(path)));
    expect(mentioning(outside, read)).toEqual([]);
  });

  it('can fail: the scan finds the allowed files, and any other file that names the candidate', () => {
    expect(mentioning(everything, read).sort()).toEqual(
      [
        'apps/worker/src/ask-check-operator.candidate.test.ts',
        'apps/worker/src/ask-check-operator.test.ts',
        'apps/worker/src/ask-check-operator.ts',
        'apps/worker/src/operator.ts',
        'packages/backend/src/modules/content/adapters/nest-providers.ts',
        'packages/backend/src/modules/content/production/ask-support-candidate.test.ts',
        'packages/backend/src/modules/content/production/ask-support-candidate.ts',
        'packages/backend/src/modules/content/production/ask-support-replay.ts',
      ].sort(),
    );
    const synthetic = (source: string) => mentioning(['production/writer-stage.ts'], () => source);
    expect(synthetic("import { candidateCheckerRole } from './ask-support-candidate.js';")).toEqual([
      'production/writer-stage.ts',
    ]);
    expect(synthetic('const role = readCandidateInstructions(bytes);')).toEqual(['production/writer-stage.ts']);
    expect(synthetic('const path = args.values["checker-instructions"];')).toEqual(['production/writer-stage.ts']);
    expect(synthetic('const role = askSupportRole(sentences, passages);')).toEqual([]);
  });
});
