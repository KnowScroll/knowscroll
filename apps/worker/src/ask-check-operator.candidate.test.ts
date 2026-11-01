import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { askCheckCommand } from './ask-check-operator.js';

/**
 * What `content ask-check` hands the replay, and what it prints, with a candidate file and without. The configuration, the
 * database, the harness and the replay are labelled CI doubles: this proves the command's own wiring (the candidate reaches
 * the replay, the start and end lines carry its label, a plain run carries none), not what a model says. The replay's own
 * labels and the requests it sends are proved against real PostgreSQL in `tests/integration/modules/ask-support-replay.test.ts`.
 */
/** What the command hands the replay: the part of its dependencies this test reads. */
interface ReplayDepsSeen {
  readonly candidate?: { readonly text: string; readonly sha256: string };
}
const replayDeps: ReplayDepsSeen[] = [];

vi.mock('@knowscroll/backend/infrastructure/config', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readScrollProductionOperatorConfig: () => ({
    database: {},
    reasoning: { productionEnabled: true },
    scopeLockTimeoutMs: 5000,
    productionGeneration: 1,
  }),
}));
vi.mock('@knowscroll/backend/infrastructure/postgres', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createDatabase: () => ({ db: {}, close: () => Promise.resolve() }),
  makeWithProductionScope: () => () => Promise.reject(new Error('CI: the scope is not used by this double')),
}));
vi.mock('@knowscroll/backend/reasoning/nest-providers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  configuredModelPort: () => ({ model: 'MiniMax-M3.1-Flash' }),
  makeProductionReasoningHarness: () => ({}),
  postgresProductionHarnessPorts: () => ({}),
  productionHarnessSettings: () => ({}),
}));
vi.mock('@knowscroll/backend/modules/content/nest-providers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  makeAskSupportReplay: (deps: ReplayDepsSeen) => {
    replayDeps.push(deps);
    return (
      _target: unknown,
      _signal: AbortSignal,
      emit: (result: { line: Record<string, unknown> }) => Promise<void> | void,
    ) =>
      Promise.resolve(emit({ line: { assetId: 'ci-asset', outcome: 'checked' } })).then(() => ({
        answers: 1,
        stopped: false,
      }));
  },
}));

describe('content ask-check with and without candidate instructions (D-280)', () => {
  const ASSET = '5d7a1a3e-52e5-4a4a-9a45-0b6bf6b3a222';
  const CANDIDATE_TEXT = 'CI candidate instructions: judge each sentence by the passages it cites.\n';
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ks-ask-check-glue-'));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  beforeEach(() => {
    replayDeps.length = 0;
  });

  async function run(checkerInstructions: string | undefined, out = join(directory, 'detail.jsonl')) {
    const printed: Record<string, unknown>[] = [];
    const code = await askCheckCommand(
      {
        asset: ASSET,
        recent: undefined,
        out,
        checkerInstructions,
        dispatchedBy: 'cli:ci',
      },
      (line) => void printed.push(line),
      () => undefined,
    );
    return { code, printed };
  }

  it('hands the replay the candidate and labels the start, every answer and the end with its hash', async () => {
    const path = join(directory, 'candidate.txt');
    await writeFile(path, CANDIDATE_TEXT);
    const { code, printed } = await run(path);

    expect(code).toBe(0);
    expect(replayDeps).toHaveLength(1);
    const candidate = replayDeps[0]!.candidate;
    expect(candidate?.text).toBe(CANDIDATE_TEXT);
    expect(candidate?.sha256).toMatch(/^[0-9a-f]{64}$/u);
    const label = { candidate: true, candidateSha256: candidate!.sha256 };
    expect(printed.map((line) => line['result'])).toEqual(['starting', 'answer', 'done']);
    // The answer line is the replay's own; the start and end lines are the command's, and carry the label too.
    expect(printed[0]).toMatchObject({ model: 'MiniMax-M3.1-Flash', ...label });
    expect(printed[2]).toMatchObject({ answers: 1, ...label });
  });

  it('hands the replay no candidate, and marks nothing as one, when no file is named', async () => {
    const { code, printed } = await run(undefined);
    expect(code).toBe(0);
    expect(replayDeps[0]!.candidate).toBeUndefined();
    for (const line of printed) {
      expect(line).not.toHaveProperty('candidate');
      expect(line).not.toHaveProperty('candidateSha256');
    }
  });

  it('refuses a candidate file that is not plain text before it opens the database or reads the model’s configuration', async () => {
    const path = join(directory, 'with-control.txt');
    await writeFile(path, 'Judge\u0007 each sentence.');
    const out = join(directory, 'never-created.jsonl');
    const { code, printed } = await run(path, out);
    expect(code).toBe(2);
    expect(printed).toEqual([
      { command: 'content ask-check', result: 'checker_instructions_refused', code: 'not_plain_text' },
    ]);
    expect(replayDeps).toHaveLength(0);
    // The detail file is created only once a run starts.
    await expect(stat(out)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
