import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { appendFile, lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, normalize, posix } from 'node:path';
import { ConfigurationError, readScrollProductionOperatorConfig } from '@knowscroll/backend/infrastructure/config';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { createDatabase, makeWithProductionScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  configuredModelPort,
  makeProductionReasoningHarness,
  postgresProductionHarnessPorts,
  productionHarnessSettings,
} from '@knowscroll/backend/reasoning/nest-providers';
import {
  ASK_SUPPORT_REPLAY_MAX,
  CANDIDATE_INSTRUCTIONS_MAX_BYTES,
  isAssetId,
  makeAskSupportReplay,
  readCandidateInstructions,
  type CandidateCheckerInstructions,
  type CandidateReading,
  type ReplayTarget,
} from '@knowscroll/backend/modules/content/nest-providers';

type Print = (result: Record<string, unknown>) => void;

export interface AskCheckOptions {
  /** `--asset <uuid,…>`: the asset ids of stored ask answers. */
  readonly asset: string | undefined;
  /** `--recent <n>`: the newest published ask answers. */
  readonly recent: string | undefined;
  /** `--out <file>`: where the detail of each checked answer is appended. Required. */
  readonly out: string | undefined;
  /**
   * `--checker-instructions <absolute path>`: candidate instructions for the checker, read from a file, for this replay
   * alone (D-280). Without it the replay asks the checker with the production instructions.
   */
  readonly checkerInstructions?: string | undefined;
  readonly dispatchedBy: string;
}

const USAGE = `content ask-check (--asset <uuid>[,<uuid>…] | --recent <1-${String(ASK_SUPPORT_REPLAY_MAX)}>) --out <file> [--checker-instructions <absolute path>]`;

/**
 * Whether `--checker-instructions` was given to a command other than `content ask-check`. Candidate instructions belong to
 * the replay alone (D-280): any other command refuses the option instead of ignoring it.
 */
export const isCheckerInstructionsMisplaced = (positionals: readonly string[], option: string | undefined): boolean =>
  option !== undefined && !(positionals[0] === 'content' && positionals[1] === 'ask-check');

/**
 * Why a candidate file is not read: what its text can be refused for (`readCandidateInstructions`), and the ways its place
 * can be refused. `symlink` is a link, or a path with a link in it. `forbidden_location` is a place that holds the machine's
 * settings or keys.
 */
type CandidateFileRefusal =
  | Extract<CandidateReading, { kind: 'refused' }>['code']
  | 'path_not_absolute'
  | 'forbidden_location'
  | 'symlink'
  | 'unreadable';

/** Places a candidate file may not be named from: the machine's settings (`/etc`), a login's keys and the process table. */
const FORBIDDEN_LOCATIONS = /^\/(?:etc|proc)(?:\/|$)|^\/root\/\.ssh(?:\/|$)/u;

/** Whether a path, once `..` and doubled slashes are taken out, is under a place no candidate file may come from. */
export const isForbiddenLocation = (path: string): boolean =>
  FORBIDDEN_LOCATIONS.test(posix.normalize(path.replaceAll('\\', '/')));

/** Whether two paths name the same place as written (Windows paths are not case sensitive). */
const samePath = (first: string, second: string): boolean =>
  process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;

/**
 * Reads candidate checker instructions from a file on the server. The text becomes the checker's system prompt, which is
 * sent to the provider and kept in the request store, so the file is held to a narrow rule:
 * - the path is absolute, not under `/etc`, `/proc` or `/root/.ssh`, and names a regular file, never a link and never a path with a
 *   link in any part of it (`realpath` must equal the path given);
 * - it is looked at before it is opened, so a pipe, a device or a huge file (over {@link CANDIDATE_INSTRUCTIONS_MAX_BYTES} bytes)
 *   is never opened or slurped, and it is opened without following a link;
 * - the text is UTF-8 plain text that looks like instructions for this checker (`readCandidateInstructions`): a settings file
 *   is refused.
 * The refusal says why with a code and never quotes the file.
 */
export async function readCandidateFile(
  path: string,
): Promise<
  | { readonly kind: 'accepted'; readonly candidate: CandidateCheckerInstructions }
  | { readonly kind: 'refused'; readonly code: CandidateFileRefusal }
> {
  if (!isAbsolute(path)) return { kind: 'refused', code: 'path_not_absolute' };
  if (isForbiddenLocation(path)) return { kind: 'refused', code: 'forbidden_location' };
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) return { kind: 'refused', code: 'symlink' };
    if (!entry.isFile()) return { kind: 'refused', code: 'unreadable' };
    if (!samePath(await realpath(path), normalize(path))) return { kind: 'refused', code: 'symlink' };
    if (entry.size > CANDIDATE_INSTRUCTIONS_MAX_BYTES) return { kind: 'refused', code: 'too_large' };
  } catch {
    return { kind: 'refused', code: 'unreadable' };
  }
  let handle;
  try {
    // Not following a link where the system can say so (not on Windows), in case the path changed since it was looked at.
    handle = await open(path, constants.O_RDONLY | ((constants.O_NOFOLLOW as number | undefined) ?? 0));
    // One byte more than the limit, so a file that grew since it was looked at is refused as too large.
    const buffer = Buffer.alloc(CANDIDATE_INSTRUCTIONS_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return readCandidateInstructions(buffer.subarray(0, bytesRead));
  } catch {
    return { kind: 'refused', code: 'unreadable' };
  } finally {
    await handle?.close();
  }
}

/** The target the options name, or `undefined` when they name none or more than one. */
function targetOf(options: AskCheckOptions): ReplayTarget | undefined {
  if ((options.asset === undefined) === (options.recent === undefined)) return undefined;
  if (options.asset !== undefined) {
    const assetIds = options.asset.split(',').map((id) => id.trim());
    return assetIds.length >= 1 && assetIds.length <= ASK_SUPPORT_REPLAY_MAX && assetIds.every(isAssetId)
      ? { kind: 'assets', assetIds }
      : undefined;
  }
  const count = Number(options.recent);
  return Number.isInteger(count) && count >= 1 && count <= ASK_SUPPORT_REPLAY_MAX
    ? { kind: 'recent', count }
    : undefined;
}

/**
 * `content ask-check (--asset <uuid,…> | --recent <n>) --out <file>`: runs the support checker (D-250) again over answers
 * that were already made for people, through the production reasoning harness (every request is an attempt in the ledger),
 * and writes what it said about each sentence. It publishes, stores and changes nothing, and it never reads the question
 * a person asked: the check does not use it.
 *
 * Output: one JSON line on stdout for each answer with counts and codes only (no sentence, title or question), and one for
 * the end. With `--out` (required), each checked answer's sentences and the checker's verdicts are appended to that file as
 * one JSON line; it holds the answer's own words, so read it from the server shell and never paste it into an issue.
 *
 * With `--checker-instructions <absolute path>` the replay asks the checker with the instructions in that file instead of the
 * production ones, to measure a change before it is built into a version (D-280). Every line it prints, and every line it
 * appends to the file, then says `candidate: true` and carries the SHA-256 of the file. Production never reads such a file.
 *
 * Exit status: 0 when the command ran to the end (an answer it could not replay is named in its line), 2 when it was
 * refused or stopped early (spent budget, unknown attempt, wrong model, a candidate file that is refused), 1 on a failure.
 */
export async function askCheckCommand(options: AskCheckOptions, print: Print, logEvent: LogEvent): Promise<number> {
  const target = targetOf(options);
  if (target === undefined || options.out === undefined) {
    print({ result: 'usage', usage: USAGE });
    return 2;
  }
  const out = options.out;
  let candidate: CandidateCheckerInstructions | undefined;
  if (options.checkerInstructions !== undefined) {
    const reading = await readCandidateFile(options.checkerInstructions);
    if (reading.kind === 'refused') {
      print({ command: 'content ask-check', result: 'checker_instructions_refused', code: reading.code });
      return 2;
    }
    candidate = reading.candidate;
  }
  const candidateLabel = candidate === undefined ? {} : { candidate: true as const, candidateSha256: candidate.sha256 };
  try {
    const config = readScrollProductionOperatorConfig(process.env);
    const model = configuredModelPort(config.reasoning);
    if (model === undefined) {
      print({ command: 'content ask-check', result: 'model_unavailable', ...candidateLabel });
      return 2;
    }
    try {
      // The file holds the answers' words: only its owner reads it.
      await appendFile(out, '', { mode: 0o600 });
    } catch {
      print({ command: 'content ask-check', result: 'out_unwritable', ...candidateLabel });
      return 2;
    }
    const database = createDatabase<Database>(config.database, {
      onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
    });
    const abort = new AbortController();
    const stop = () => abort.abort();
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    try {
      const withScope = makeWithProductionScope(database.db, {
        enabled: config.reasoning.productionEnabled,
        lockTimeoutMs: config.scopeLockTimeoutMs,
      });
      const harness = makeProductionReasoningHarness(
        postgresProductionHarnessPorts({
          db: database.db,
          withProductionScope: withScope,
          enabled: config.reasoning.productionEnabled,
          model,
          logEvent,
          settings: productionHarnessSettings(config.reasoning, options.dispatchedBy),
        }),
      );
      const replay = makeAskSupportReplay({
        db: database.db,
        harness,
        withScope,
        authority: { scopeId: 'scroll-supply', generation: config.productionGeneration },
        model: model.model,
        newRunKey: randomUUID,
        ...(candidate === undefined ? {} : { candidate }),
      });
      print({ command: 'content ask-check', result: 'starting', model: model.model, out, ...candidateLabel });
      const summary = await replay(target, abort.signal, async (result) => {
        print({ command: 'content ask-check', result: 'answer', ...result.line });
        if (result.detail !== undefined) await appendFile(out, `${JSON.stringify(result.detail)}\n`);
      });
      print({
        command: 'content ask-check',
        result: summary.stopped ? 'stopped' : 'done',
        answers: summary.answers,
        ...candidateLabel,
      });
      return summary.stopped ? 2 : 0;
    } finally {
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
      await database.close();
    }
  } catch (error) {
    if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
    else logEvent('process.crashed', { reasonCode: 'ask_check_failed', error });
    return 1;
  }
}
