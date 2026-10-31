import { userInfo } from 'node:os';
import { ConfigurationError, readRoomFaceOperatorConfig } from '@knowscroll/backend/infrastructure/config';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { createDatabase, makeWithProductionScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  configuredModelPort,
  makeProductionReasoningHarness,
  postgresProductionHarnessPorts,
  roomHarnessSettings,
} from '@knowscroll/backend/reasoning/nest-providers';
import {
  makeReadLibraryPassages,
  makeReadLibraryPassageText,
} from '@knowscroll/backend/modules/content/nest-providers';
import { composeRitualOperator } from '@knowscroll/backend/modules/rooms/nest-providers';

type Print = (result: Record<string, unknown>) => void;

/** The options the ritual commands read; the rest of the `rooms` command's options are not theirs. */
export interface RitualOptions {
  readonly room: string | undefined;
  readonly day: string | undefined;
  readonly ritual: string | undefined;
  readonly state: string | undefined;
  readonly approve: boolean;
  readonly reject: boolean;
  readonly dryRun: boolean;
}

export const RITUAL_COMMANDS = ['rituals', 'ritual-list', 'ritual-review'] as const;
export type RitualCommand = (typeof RITUAL_COMMANDS)[number];

export const RITUAL_USAGE = [
  'rooms rituals --room <slug> [--day YYYY-MM-DD] [--dry-run]',
  'rooms ritual-list [--state draft|approved|rejected]',
  'rooms ritual-review --ritual <uuid> --approve|--reject',
].join(' | ');

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const operatorName = /^[a-z_][a-z0-9_.-]{0,31}$/;
const states = ['draft', 'approved', 'rejected'] as const;

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

const isDay = (day: string): boolean => dayPattern.test(day) && !Number.isNaN(new Date(`${day}T00:00:00Z`).getTime());

/** The command's arguments, checked before anything is composed. */
function validArguments(command: RitualCommand, options: RitualOptions): boolean {
  switch (command) {
    case 'rituals':
      return options.room !== undefined && (options.day === undefined || isDay(options.day));
    case 'ritual-list':
      return options.state === undefined || states.some((state) => state === options.state);
    case 'ritual-review':
      return options.ritual !== undefined && uuidPattern.test(options.ritual) && options.approve !== options.reject;
  }
}

/**
 * `rooms rituals|ritual-list|ritual-review`: the operator's controls over a room's daily items (D-176). `rituals` drafts the
 * question and Spot the flaw of one room for a UTC day (today by default): the question is a template and costs nothing, the
 * flaw is one call of the `rooms.ambient-ritual` role on the rooms scope (it needs `KS_REASONING_ROOM_ENABLED` and a
 * configured provider), and re-running a day calls nothing more. `--dry-run` shows the passage and the sentence code chose and
 * calls nothing. `ritual-list` shows the items with their cited Scroll; `ritual-review` approves or rejects one, and an
 * approval re-reads the cited passage and refuses with `citation_changed` unless the Scroll still says it. Results are one
 * JSON line. Exit 0 done, 2 refused or not applicable, 1 failure.
 */
export async function roomsRitualCommand(
  command: RitualCommand,
  options: RitualOptions,
  print: Print,
  logEvent: LogEvent,
): Promise<number> {
  if (!validArguments(command, options)) {
    print({ result: 'usage', usage: RITUAL_USAGE });
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
      const rituals = composeRitualOperator({
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
        readPassages: makeReadLibraryPassages(database.db),
        readPassageText: makeReadLibraryPassageText(database.db),
        model: model?.model ?? 'none',
        generation: config.reasoning.roomGeneration,
      });
      switch (command) {
        case 'rituals': {
          const room = await rituals.roomBySlug(options.room ?? '');
          if (room === undefined) {
            print({ command: label, result: 'unknown_room' });
            return 2;
          }
          const day = options.day ?? new Date().toISOString().slice(0, 10);
          const draft = await rituals.draftRoom({ room, day, dryRun: options.dryRun, signal: abort.signal });
          print({ command: label, dryRun: options.dryRun, ...draft });
          return draft.flaw.kind === 'not_made' ? 2 : 0;
        }
        case 'ritual-list': {
          const state = states.find((candidate) => candidate === options.state);
          const items = await rituals.list({ state }, 50);
          print({
            command: label,
            rituals: items.map((item) => ({
              ritual: item.ritualId,
              room: item.room.slug,
              day: item.day,
              kind: item.kind,
              state: item.state,
              madeBy: item.madeBy,
              createdAt: item.createdAt.toISOString(),
              decidedBy: item.decidedBy,
              // The words and the cited Scroll, as stored: never a person.
              payload: item.payload,
            })),
          });
          return 0;
        }
        case 'ritual-review': {
          const result = await rituals.review({
            ritualId: options.ritual ?? '',
            decision: options.approve ? 'approved' : 'rejected',
            by,
          });
          print({ command: label, decision: options.approve ? 'approved' : 'rejected', result: result.kind });
          return result.kind === 'decided' ? 0 : 2;
        }
      }
    } finally {
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
      await database.close();
    }
  } catch (error) {
    if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
    else logEvent('process.crashed', { reasonCode: 'rooms_ritual_command_failed', error });
    return 1;
  }
}
