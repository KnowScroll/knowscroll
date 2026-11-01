import { ConfigurationError, readRoomFaceOperatorConfig } from '@knowscroll/backend/infrastructure/config';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { createDatabase, makeWithProductionScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  configuredModelPort,
  makeProductionReasoningHarness,
  postgresProductionHarnessPorts,
  roomHarnessSettings,
} from '@knowscroll/backend/reasoning/nest-providers';
import { makeReadLibraryFinds } from '@knowscroll/backend/modules/content/nest-providers';
import { composeFeedHeartbeat, composeScoutHeartbeat } from '@knowscroll/backend/modules/rooms/nest-providers';

type Print = (result: Record<string, unknown>) => void;

export const FEED_COMMANDS = ['feed', 'scout'] as const;
export type FeedCommand = (typeof FEED_COMMANDS)[number];

export const FEED_USAGE =
  'rooms feed --room <slug> [--dry-run] | rooms scout --room <slug> --owner <handle> [--dry-run]';

/**
 * `rooms feed --room <slug>`: one look at one room by its residents, exactly as the heartbeat makes it (v3 R-8, D-248): the room's
 * memory is written again when due, and a find about a library asset the room has not seen is posted when a resident's rest is
 * over and the caps allow it. It makes a call only when there is something to say (it needs `KS_REASONING_ROOM_ENABLED` and a
 * configured provider), and a second run in the same 8-hour slot finds the first one's turn and changes nothing. The result is one
 * JSON line with what each step came to; it names no person and no words. `--dry-run` reads the library and the room and prints
 * the asset code would choose, without writing anything or calling a model. Exit 0 done, 2 refused or unknown room, 1 failure.
 */
export async function roomsFeedCommand(
  command: FeedCommand,
  options: { readonly room: string | undefined; readonly owner?: string | undefined; readonly dryRun: boolean },
  print: Print,
  logEvent: LogEvent,
): Promise<number> {
  if (options.room === undefined || (command === 'scout' && options.owner === undefined)) {
    print({ result: 'usage', usage: FEED_USAGE });
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
      const readFinds = makeReadLibraryFinds(database.db);
      const withRoomScope = makeWithProductionScope(database.db, {
        enabled: config.reasoning.roomEnabled,
        lockTimeoutMs: config.scopeLockTimeoutMs,
        scopeId: 'rooms',
      });
      const model = configuredModelPort(config.reasoning);
      const heartbeatDeps = {
        db: database.db,
        harness: makeProductionReasoningHarness(
          postgresProductionHarnessPorts({
            db: database.db,
            withProductionScope: withRoomScope,
            enabled: config.reasoning.roomEnabled,
            scopeId: 'rooms',
            model,
            logEvent,
            settings: roomHarnessSettings(config.reasoning, `cli:${command}`),
          }),
        ),
        withRoomScope,
        readFinds,
        model: model?.model ?? 'none',
        generation: config.reasoning.roomGeneration,
      };
      if (command === 'scout')
        return await scoutLook(composeScoutHeartbeat(heartbeatDeps), options, readFinds, abort.signal, print, label);
      const heartbeat = composeFeedHeartbeat(heartbeatDeps);
      const room = await heartbeat.roomBySlug(options.room);
      if (room === undefined) {
        print({ command: label, result: 'unknown_room' });
        return 2;
      }
      if (options.dryRun) {
        const candidates = await readFinds(room.topic, 5);
        print({
          command: label,
          dryRun: true,
          room: room.slug,
          // The newest assets of the room's topic, as code reads them: what a look would choose from. No person, no words of a member.
          candidates: candidates.map((candidate) => ({
            asset: candidate.assetId,
            kind: candidate.kind,
            title: candidate.title,
          })),
        });
        return 0;
      }
      const look = await heartbeat.lookAt(room, abort.signal);
      print({ command: label, dryRun: false, ...look });
      return look.find.kind === 'not_made' || look.memory.kind === 'not_written' ? 2 : 0;
    } finally {
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
      await database.close();
    }
  } catch (error) {
    if (error instanceof ConfigurationError) logEvent('config.invalid', { problems: error.problems });
    else logEvent('process.crashed', { reasonCode: 'rooms_feed_command_failed', error });
    return 1;
  }
}

/**
 * `rooms scout --room <slug> --owner <handle>`: one look for the scout a member sent into a room, exactly as the scouts' heartbeat
 * makes it (v3 R-9, D-259). The result names the room and what the look came to, never the owner's topics or any words; `--dry-run`
 * prints the assets code would choose from in the topics the owner chose, and writes nothing. Exit 0 done, 2 refused or unknown, 1 failure.
 */
async function scoutLook(
  heartbeat: ReturnType<typeof composeScoutHeartbeat>,
  options: { readonly room: string | undefined; readonly owner?: string | undefined; readonly dryRun: boolean },
  readFinds: ReturnType<typeof makeReadLibraryFinds>,
  signal: AbortSignal,
  print: Print,
  label: string,
): Promise<number> {
  const scout = await heartbeat.scoutIn(options.room ?? '', options.owner ?? '');
  if (scout === undefined) {
    print({ command: label, result: 'unknown_scout' });
    return 2;
  }
  if (options.dryRun) {
    const candidates = await readFinds(scout.room.topic, 5, undefined, scout.interests);
    print({
      command: label,
      dryRun: true,
      room: scout.room.slug,
      candidates: candidates.map((candidate) => ({
        asset: candidate.assetId,
        kind: candidate.kind,
        title: candidate.title,
      })),
    });
    return 0;
  }
  const look = await heartbeat.lookAt(scout, signal);
  print({ command: label, dryRun: false, ...look });
  return look.find.kind === 'not_made' ? 2 : 0;
}
