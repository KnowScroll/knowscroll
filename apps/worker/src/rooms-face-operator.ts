import { userInfo } from 'node:os';
import { ConfigurationError, readRoomFaceOperatorConfig } from '@knowscroll/backend/infrastructure/config';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { createDatabase, makeWithProductionScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  configuredImagePort,
  configuredModelPort,
  makeProductionReasoningHarness,
  postgresProductionHarnessPorts,
  roomHarnessSettings,
} from '@knowscroll/backend/reasoning/nest-providers';
import { composeFaceOperator } from '@knowscroll/backend/modules/rooms/nest-providers';

type Print = (result: Record<string, unknown>) => void;

/** The options the face commands read; the rest of the `rooms` command's options are not theirs. */
export interface FaceOptions {
  readonly room: string | undefined;
  readonly revision: string | undefined;
  readonly backdrop: string | undefined;
  readonly attempt: string | undefined;
  readonly reason: string | undefined;
  readonly charged: string | undefined;
  readonly approve: boolean;
  readonly reject: boolean;
  readonly dryRun: boolean;
}

export const FACE_COMMANDS = [
  'kit',
  'kit-list',
  'kit-review',
  'backdrop',
  'backdrop-list',
  'backdrop-review',
  'spend',
  'backdrop-reconcile',
  'backdrop-write-off',
] as const;
export type FaceCommand = (typeof FACE_COMMANDS)[number];

export const FACE_USAGE = [
  'rooms kit --room <slug> [--dry-run]',
  'rooms kit-list',
  'rooms kit-review --room <slug> --revision <n> --approve|--reject',
  'rooms backdrop --room <slug> [--dry-run]',
  'rooms backdrop-list',
  'rooms backdrop-review --backdrop <uuid> --approve|--reject',
  'rooms spend',
  'rooms backdrop-reconcile --attempt <uuid> --charged yes|no --reason <text>',
  'rooms backdrop-write-off --attempt <uuid> --reason <text>',
].join(' | ');

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const operatorName = /^[a-z_][a-z0-9_.-]{0,31}$/;

/** Who ran the command, as `cli:<name>`: the user behind `sudo`, else the login user, else `cli:unknown`. */
function operatorSource(env: NodeJS.ProcessEnv): string {
  const candidates = [env['SUDO_USER'], env['USER'], env['LOGNAME']];
  try {
    candidates.push(userInfo().username);
  } catch {
    // No passwd entry for this uid: the environment's names are all there is.
  }
  const name = candidates.find((candidate) => candidate !== undefined && operatorName.test(candidate));
  return `cli:${name ?? 'unknown'}`;
}

const decisionOf = (options: FaceOptions): 'approved' | 'rejected' | undefined =>
  options.approve === options.reject ? undefined : options.approve ? 'approved' : 'rejected';

const reasonOf = (options: FaceOptions): string | undefined => {
  const reason = options.reason?.trim();
  return reason !== undefined && reason.length >= 1 && reason.length <= 300 ? reason : undefined;
};

/** The command's arguments, checked before anything is composed. `undefined` means the usage line applies. */
function validArguments(command: FaceCommand, options: FaceOptions): boolean {
  switch (command) {
    case 'kit':
    case 'backdrop':
      return options.room !== undefined;
    case 'kit-list':
    case 'backdrop-list':
    case 'spend':
      return true;
    case 'kit-review':
      return (
        options.room !== undefined && Number.isInteger(Number(options.revision)) && decisionOf(options) !== undefined
      );
    case 'backdrop-review':
      return options.backdrop !== undefined && uuidPattern.test(options.backdrop) && decisionOf(options) !== undefined;
    case 'backdrop-reconcile':
      return (
        options.attempt !== undefined &&
        uuidPattern.test(options.attempt) &&
        (options.charged === 'yes' || options.charged === 'no') &&
        reasonOf(options) !== undefined
      );
    case 'backdrop-write-off':
      return options.attempt !== undefined && uuidPattern.test(options.attempt) && reasonOf(options) !== undefined;
  }
}

const dollars = (microUsd: number): string => (microUsd / 1_000_000).toFixed(6);

/** Spend figures the way an operator reads them: millionths for the ledger, dollars for the eye. */
function spendWords(figures: {
  recordedMicroUsd: number;
  capMicroUsd: number;
  estimateMicroUsd: number;
}): Record<string, unknown> {
  return {
    recordedUsd: dollars(figures.recordedMicroUsd),
    capUsd: dollars(figures.capMicroUsd),
    estimateUsd: dollars(figures.estimateMicroUsd),
  };
}

/**
 * `rooms kit|kit-list|kit-review|backdrop|backdrop-list|backdrop-review|spend|backdrop-reconcile|backdrop-write-off`: the
 * operator's controls over every room's face (D-166, D-170, D-171). A kit command calls the `rooms.station-kit` role on the
 * rooms scope (it needs `KS_REASONING_ROOM_ENABLED` and a configured provider); a backdrop command calls the image provider
 * and writes to the media root (`KS_MEDIA_ROOT`), and may spend money. Each real backdrop call is refused when the recorded
 * total plus its estimate would pass the $1 cap. `--dry-run` shows what would be asked and what it would cost, and calls nothing.
 * Results are one JSON line, never a key, a prompt's model reasoning or an address. Exit 0 done, 2 refused or not applicable,
 * 1 failure.
 */
export async function roomsFaceCommand(
  command: FaceCommand,
  options: FaceOptions,
  print: Print,
  logEvent: LogEvent,
): Promise<number> {
  if (!validArguments(command, options)) {
    print({ result: 'usage', usage: FACE_USAGE });
    return 2;
  }
  const label = `rooms ${command}`;
  try {
    const config = readRoomFaceOperatorConfig(process.env);
    const database = createDatabase<Database>(config.database, {
      onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
    });
    const abort = new AbortController();
    const stop = () => abort.abort();
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    try {
      const by = operatorSource(process.env);
      const withRoomScope = makeWithProductionScope(database.db, {
        enabled: config.reasoning.roomEnabled,
        lockTimeoutMs: config.scopeLockTimeoutMs,
        scopeId: 'rooms',
      });
      const model = configuredModelPort(config.reasoning);
      const face = composeFaceOperator({
        db: database.db,
        harness: makeProductionReasoningHarness(
          postgresProductionHarnessPorts({
            db: database.db,
            withProductionScope: withRoomScope,
            enabled: config.reasoning.roomEnabled,
            scopeId: 'rooms',
            model,
            logEvent,
            settings: roomHarnessSettings(config.reasoning, by),
          }),
        ),
        withRoomScope,
        image: configuredImagePort(config.reasoning),
        mediaRoot: config.mediaRoot,
        model: model?.model ?? 'none',
        generation: config.reasoning.roomGeneration,
      });
      const room = options.room ?? '';
      switch (command) {
        case 'kit': {
          const result = await face.kit.propose({ slug: room, dryRun: options.dryRun, signal: abort.signal });
          print({ command: label, ...result });
          return result.kind === 'proposed' || result.kind === 'dry_run' ? 0 : 2;
        }
        case 'kit-list': {
          const kits = await face.kit.list(50);
          print({
            command: label,
            kits: kits.map((kit) => ({
              room: kit.slug,
              revision: kit.revision,
              state: kit.reviewState,
              valid: kit.valid,
              proposedAt: kit.proposedAt.toISOString(),
              kit: kit.kit,
            })),
          });
          return 0;
        }
        case 'kit-review': {
          const decision = decisionOf(options);
          if (decision === undefined) return 2;
          const result = await face.kit.review({ slug: room, revision: Number(options.revision), decision, by });
          print({ command: label, room, decision, result: result.kind });
          return result.kind === 'decided' ? 0 : 2;
        }
        case 'backdrop': {
          const result = await face.backdrop.generate({ slug: room, dryRun: options.dryRun, signal: abort.signal, by });
          print({
            command: label,
            ...result,
            ...('figures' in result && result.figures !== undefined ? spendWords(result.figures) : {}),
          });
          return result.kind === 'made' || result.kind === 'dry_run' ? 0 : 2;
        }
        case 'backdrop-list': {
          const backdrops = await face.backdrop.list(50);
          print({
            command: label,
            backdrops: backdrops.map((backdrop) => ({
              backdrop: backdrop.backdropId,
              room: backdrop.slug,
              state: backdrop.reviewState,
              mime: backdrop.mime,
              sizeBytes: backdrop.sizeBytes,
              // A path under the world's media root, for an operator to open on the server.
              mediaKey: backdrop.mediaKey,
              createdAt: backdrop.createdAt.toISOString(),
            })),
          });
          return 0;
        }
        case 'backdrop-review': {
          const decision = decisionOf(options);
          if (decision === undefined) return 2;
          const result = await face.backdrop.review({ backdropId: options.backdrop ?? '', decision, by });
          print({ command: label, decision, result: result.kind });
          return result.kind === 'decided' ? 0 : 2;
        }
        case 'spend': {
          const report = await face.backdrop.spend();
          print({
            command: label,
            ...report,
            ...spendWords(report),
            remainingUsd: dollars(report.remainingMicroUsd),
            unresolved: report.unresolved.map((attempt) => ({
              attempt: attempt.attemptId,
              room: attempt.slug,
              state: attempt.state,
              chargeMicroUsd: attempt.chargeMicroUsd,
              code: attempt.outcomeCode,
              since: attempt.dispatchedAt.toISOString(),
            })),
          });
          return 0;
        }
        case 'backdrop-reconcile': {
          const result = await face.backdrop.reconcile({
            attemptId: options.attempt ?? '',
            charged: options.charged === 'yes',
            reason: reasonOf(options) ?? '',
            by,
          });
          print({ command: label, result: result.kind });
          return result.kind === 'resolved' ? 0 : 2;
        }
        case 'backdrop-write-off': {
          const result = await face.backdrop.writeOff({
            attemptId: options.attempt ?? '',
            reason: reasonOf(options) ?? '',
            by,
          });
          print({ command: label, result: result.kind });
          return result.kind === 'resolved' ? 0 : 2;
        }
      }
    } finally {
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
      await database.close();
    }
  } catch (error) {
    if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
    else logEvent('process.crashed', { reasonCode: 'rooms_face_command_failed', error });
    return 1;
  }
}
