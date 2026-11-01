import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  askCheckCommand,
  isCheckerInstructionsMisplaced,
  isForbiddenLocation,
  readCandidateFile,
  type AskCheckOptions,
} from './ask-check-operator.js';

/** A file as a candidate would be: labelled CI text that names the three verdicts the checker replies with. */
const INSTRUCTIONS =
  'CI candidate instructions: judge each sentence by the passages it cites. Reply "supported", "unsupported" or "no_claim".\n';

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
    // The real path of the folder, so that a test of a link is not confused by a short name or a link in the temporary folder.
    directory = await realpath(await mkdtemp(join(tmpdir(), 'ks-ask-check-')));
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
    const text = INSTRUCTIONS;
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
    const largest = await fileWith('largest.txt', INSTRUCTIONS + 'a'.repeat(16 * 1024 - INSTRUCTIONS.length));
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

  /**
   * The text of this file is sent to the provider and kept in the request store, so the wrong file must never be taken:
   * a settings file, a link to one, or a place that holds the machine's settings. Labelled fakes throughout.
   */
  it('refuses a file shaped like a settings file, and one that is not instructions for this checker, without quoting it', async () => {
    const env = await fileWith('fake.env', `${INSTRUCTIONS}CI_FAKE_SETTING=ci-value-not-a-secret\nCI_OTHER=1\n`);
    const refused = await readCandidateFile(env);
    expect(refused).toEqual({ kind: 'refused', code: 'not_instructions' });
    expect(JSON.stringify(refused)).not.toContain('ci-value-not-a-secret');
    const settingsOnly = await fileWith('only.env', 'export CI_FAKE_SETTING="ci-value"\n');
    expect(await readCandidateFile(settingsOnly)).toEqual({ kind: 'refused', code: 'not_instructions' });
    const prose = await fileWith('prose.txt', 'Judge each sentence by the passages it cites.\n');
    expect(await readCandidateFile(prose)).toEqual({ kind: 'refused', code: 'not_instructions' });
  });

  /** Making a link may need a privilege on Windows; a folder link (a junction) does not, and Linux needs none. */
  async function link(target: string, name: string, kind: 'file' | 'dir'): Promise<string | undefined> {
    const path = join(directory, name);
    try {
      await symlink(target, path, kind === 'dir' ? 'junction' : 'file');
      return path;
    } catch {
      return undefined;
    }
  }

  it('refuses a link to a file that would be accepted, and a path with a link in any part of it', async (context) => {
    const real = await fileWith('linked-target.txt', INSTRUCTIONS);
    expect((await readCandidateFile(real)).kind).toBe('accepted');
    const fileLink = await link(real, 'file-link.txt', 'file');
    const folder = join(directory, 'real-folder');
    await mkdir(folder);
    await writeFile(join(folder, 'inside.txt'), INSTRUCTIONS);
    const folderLink = await link(folder, 'folder-link', 'dir');
    if (fileLink === undefined && folderLink === undefined) return context.skip();
    if (fileLink !== undefined) expect(await readCandidateFile(fileLink)).toEqual({ kind: 'refused', code: 'symlink' });
    if (folderLink !== undefined) {
      // The file inside is a plain file, but the folder it is reached through is a link.
      expect((await readCandidateFile(join(folder, 'inside.txt'))).kind).toBe('accepted');
      expect(await readCandidateFile(join(folderLink, 'inside.txt'))).toEqual({ kind: 'refused', code: 'symlink' });
    }
  });

  it('refuses a path under /etc, /proc or /root/.ssh before it touches the file system, however it is written', async () => {
    for (const path of [
      '/etc/knowscroll/dev.v2.env',
      '/etc/passwd',
      '/etc',
      '/proc/self/environ',
      '/root/.ssh/id_ed25519',
      '/tmp/../etc/knowscroll/dev.v2.env',
      '/etc//knowscroll/./dev.v2.env',
      '/etc\\knowscroll\\dev.v2.env',
    ])
      expect(await readCandidateFile(path), path).toEqual({ kind: 'refused', code: 'forbidden_location' });
  });

  it('knows a forbidden place from a name that only starts the same way', () => {
    expect(isForbiddenLocation('/etc/x')).toBe(true);
    expect(isForbiddenLocation('/root/.ssh/authorized_keys')).toBe(true);
    for (const path of [
      '/etcetera/x',
      '/processes/x',
      '/root/.sshd/x',
      '/root/notes.txt',
      '/var/tmp/ks-v3-spike/c.txt',
    ])
      expect(isForbiddenLocation(path), path).toBe(false);
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
