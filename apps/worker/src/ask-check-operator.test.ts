import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  askCheckCommand,
  isCheckerInstructionsMisplaced,
  readCandidateFile,
  type AskCheckOptions,
} from './ask-check-operator.js';

/**
 * The options of `content ask-check` are checked before anything else is touched: no configuration is read, no database
 * is opened and no model is called for a command that names no answers, names them twice or names them badly.
 */
describe('content ask-check refuses what it cannot run, before touching anything', () => {
  const ASSET = '5d7a1a3e-52e5-4a4a-9a45-0b6bf6b3a222';
  const options = (over: Partial<AskCheckOptions>): AskCheckOptions => ({
    asset: undefined,
    recent: undefined,
    out: '/var/tmp/ks-ask-check.jsonl',
    dispatchedBy: 'cli:ci',
    ...over,
  });
  async function run(over: Partial<AskCheckOptions>) {
    const printed: Record<string, unknown>[] = [];
    const code = await askCheckCommand(
      options(over),
      (line) => void printed.push(line),
      () => {
        throw new Error('CI: a refused command must not log or touch anything');
      },
    );
    return { code, printed };
  }

  it.each([
    ['names no answers', {}],
    ['names answers twice', { asset: ASSET, recent: '3' }],
    ['names an asset that is not an ID', { asset: 'not-an-id' }],
    ['names one good ID and one bad', { asset: `${ASSET},12345` }],
    ['names more than twenty answers', { asset: Array.from({ length: 21 }, () => ASSET).join(',') }],
    ['asks for none of the newest', { recent: '0' }],
    ['asks for more than twenty of the newest', { recent: '21' }],
    ['asks for a fraction of the newest', { recent: '2.5' }],
    ['has no file for the detail', { asset: ASSET, out: undefined }],
  ])('refuses a command that %s with the usage line and exit status 2', async (_name, over) => {
    const { code, printed } = await run(over);
    expect(code).toBe(2);
    expect(printed).toHaveLength(1);
    expect(printed[0]).toMatchObject({ result: 'usage' });
    expect(String(printed[0]?.['usage'])).toContain('content ask-check');
  });

  it('names the candidate option in its usage line', async () => {
    const { printed } = await run({});
    expect(String(printed[0]?.['usage'])).toContain('--checker-instructions <absolute path>');
  });
});

/**
 * Candidate checker instructions are for the replay alone (D-280). The command that carries the option is `content
 * ask-check`; any other command refuses it instead of ignoring it, so an operator never believes a production command ran
 * with instructions it did not use.
 */
describe('--checker-instructions belongs to content ask-check alone (D-280)', () => {
  it.each([
    [['content', 'ask-check'], '/var/tmp/candidate.txt', false],
    [['content', 'ask-check'], undefined, false],
    [['content', 'produce-scroll'], '/var/tmp/candidate.txt', true],
    [['content', 'regenerate'], '/var/tmp/candidate.txt', true],
    [['content', 'produce-library'], '/var/tmp/candidate.txt', true],
    [['content', 'release'], '/var/tmp/candidate.txt', true],
    [['reasoning', 'unknown'], '/var/tmp/candidate.txt', true],
    [['supply', 'recover-open-demand'], '/var/tmp/candidate.txt', true],
    [['content', 'production-status'], undefined, false],
    [[], '/var/tmp/candidate.txt', true],
  ])('for %j with %j, misplaced is %s', (positionals, option, misplaced) => {
    expect(isCheckerInstructionsMisplaced(positionals, option)).toBe(misplaced);
  });
});

describe('reading a candidate file from the server (D-280)', () => {
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ks-ask-check-'));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const fileWith = async (name: string, content: string | Uint8Array) => {
    const path = join(directory, name);
    await writeFile(path, content);
    return path;
  };

  it('reads a plain text file and labels it with the hash of its bytes', async () => {
    const text = 'CI candidate instructions: judge each sentence by the passages it cites.\n';
    const reading = await readCandidateFile(await fileWith('good.txt', text));
    if (reading.kind !== 'accepted') throw new Error(`CI: expected the file to be accepted, got ${reading.code}`);
    expect(reading.candidate.text).toBe(text);
    expect(reading.candidate.sha256).toBe(createHash('sha256').update(text).digest('hex'));
  });

  it('refuses a path that is not absolute, before opening anything', async () => {
    expect(await readCandidateFile('candidate.txt')).toEqual({ kind: 'refused', code: 'path_not_absolute' });
    expect(await readCandidateFile('./tmp/candidate.txt')).toEqual({ kind: 'refused', code: 'path_not_absolute' });
    expect(await readCandidateFile('')).toEqual({ kind: 'refused', code: 'path_not_absolute' });
  });

  it('refuses a file that is not there and a path that is not a file', async () => {
    expect(await readCandidateFile(join(directory, 'missing.txt'))).toEqual({ kind: 'refused', code: 'unreadable' });
    const folder = join(directory, 'a-folder');
    await mkdir(folder);
    expect(await readCandidateFile(folder)).toEqual({ kind: 'refused', code: 'unreadable' });
  });

  it('refuses a file over the size limit without reading it into memory, and accepts one of exactly the limit', async () => {
    const big = await fileWith('big.txt', 'a'.repeat(16 * 1024 + 1));
    expect(await readCandidateFile(big)).toEqual({ kind: 'refused', code: 'too_large' });
    const largest = await fileWith('largest.txt', 'a'.repeat(16 * 1024));
    expect((await readCandidateFile(largest)).kind).toBe('accepted');
  });

  it('refuses text the operator could not see in an editor, and bytes that are not UTF-8', async () => {
    expect(await readCandidateFile(await fileWith('empty.txt', ''))).toEqual({ kind: 'refused', code: 'empty' });
    expect(await readCandidateFile(await fileWith('control.txt', 'Judge\u0000 each sentence.'))).toEqual({
      kind: 'refused',
      code: 'not_plain_text',
    });
    expect(await readCandidateFile(await fileWith('binary.bin', Uint8Array.from([0xff, 0xfe, 0x00, 0x41])))).toEqual({
      kind: 'refused',
      code: 'not_utf8',
    });
  });
});

describe('a refused candidate file stops the command before it touches anything (D-280)', () => {
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ks-ask-check-'));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it.each([
    ['a relative path', 'candidate.txt', 'path_not_absolute'],
    ['a file that is not there', join(tmpdir(), 'ks-ask-check-no-such-file.txt'), 'unreadable'],
  ])(
    'prints the reason for %s and exits with status 2, with no log, no detail file and no model',
    async (_name, path, reason) => {
      const out = join(directory, `detail-${reason}.jsonl`);
      const printed: Record<string, unknown>[] = [];
      const code = await askCheckCommand(
        {
          asset: '5d7a1a3e-52e5-4a4a-9a45-0b6bf6b3a222',
          recent: undefined,
          out,
          checkerInstructions: path,
          dispatchedBy: 'cli:ci',
        },
        (line) => void printed.push(line),
        () => {
          throw new Error('CI: a refused command must not log or touch anything');
        },
      );
      expect(code).toBe(2);
      expect(printed).toEqual([{ command: 'content ask-check', result: 'checker_instructions_refused', code: reason }]);
      // The file for the detail is not even created.
      await expect(stat(out)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );
});
