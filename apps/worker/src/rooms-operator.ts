import { parseArgs } from 'node:util';
import { ConfigurationError, readContentOperatorConfig } from '@knowscroll/backend/infrastructure/config';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { createDatabase, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { libraryRoomSeeds } from '@knowscroll/backend/modules/rooms';
import { seedRooms, setRoomModerator } from '@knowscroll/backend/modules/rooms/nest-providers';
import { FACE_COMMANDS, FACE_USAGE, roomsFaceCommand } from './rooms-face-operator.js';

type Print = (result: Record<string, unknown>) => void;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `rooms <command>`: the operator's controls over idea rooms (D-051). `seed` and `moderator` write room rows only; neither
 * calls a provider, touches a personal root or writes a message. The face commands (kits, painted backdrops and their spend,
 * D-166, D-170) are in `rooms-face-operator.ts`.
 *
 *   rooms seed [--dry-run]                                  one room for each library system; rooms that exist stay as they are
 *   rooms moderator --room <slug> --account <uuid> [--remove]   names an account a moderator of a room, or takes the role back
 *
 * A seeded room has no members, no messages and no moderator. People join it; the operator names a moderator.
 */
export async function roomsCommand(args: readonly string[], print: Print, logEvent: LogEvent): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options: {
        'dry-run': { type: 'boolean', default: false },
        room: { type: 'string' },
        account: { type: 'string' },
        remove: { type: 'boolean', default: false },
        revision: { type: 'string' },
        backdrop: { type: 'string' },
        attempt: { type: 'string' },
        reason: { type: 'string' },
        charged: { type: 'string' },
        approve: { type: 'boolean', default: false },
        reject: { type: 'boolean', default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch {
    print({
      result: 'usage',
      usage: `rooms seed [--dry-run] | rooms moderator --room <slug> --account <uuid> [--remove] | ${FACE_USAGE}`,
    });
    return 2;
  }
  const [command] = parsed.positionals;
  const { values } = parsed;
  const faceCommand = FACE_COMMANDS.find((candidate) => candidate === command);
  if (faceCommand !== undefined && parsed.positionals.length === 1)
    return roomsFaceCommand(
      faceCommand,
      {
        room: values.room,
        revision: values.revision,
        backdrop: values.backdrop,
        attempt: values.attempt,
        reason: values.reason,
        charged: values.charged,
        approve: values.approve,
        reject: values.reject,
        dryRun: values['dry-run'],
      },
      print,
      logEvent,
    );
  const isSeed = command === 'seed' && parsed.positionals.length === 1;
  const isModerator =
    command === 'moderator' &&
    parsed.positionals.length === 1 &&
    values.room !== undefined &&
    values.account !== undefined &&
    uuidPattern.test(values.account);
  if (!isSeed && !isModerator) {
    print({
      result: 'usage',
      usage: `rooms seed [--dry-run] | rooms moderator --room <slug> --account <uuid> [--remove] | ${FACE_USAGE}`,
    });
    return 2;
  }
  try {
    const config = readContentOperatorConfig(process.env);
    const database = createDatabase<Database>(config.database, {
      onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
    });
    try {
      if (isSeed) {
        const seeds = libraryRoomSeeds();
        if (values['dry-run']) {
          print({ command: 'rooms seed', dryRun: true, wouldCreate: seeds.map((seed) => seed.slug) });
          return 0;
        }
        const result = await seedRooms(database.db, seeds, new Date());
        print({ command: 'rooms seed', ...result });
        return 0;
      }
      const outcome = await setRoomModerator(database.db, {
        slug: values.room!,
        accountId: values.account!.toLowerCase(),
        moderator: !values.remove,
        now: new Date(),
      });
      print({ command: 'rooms moderator', result: outcome });
      return outcome === 'set' || outcome === 'removed' ? 0 : 2;
    } finally {
      await database.close();
    }
  } catch (error) {
    if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
    else logEvent('process.crashed', { reasonCode: 'rooms_command_failed', error });
    return 1;
  }
}
