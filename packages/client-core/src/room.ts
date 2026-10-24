import type { RoomListItem, RoomView } from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import { talkFailure } from './talk-failure';

const VERSION = 'rooms.v1' as const;

/** The rooms the person belongs to or is invited to (for Talk). A failed request throws; `talkFailure` classifies it. */
export async function readRoomList(scope: AccountScope, newId: () => string): Promise<readonly RoomListItem[]> {
  const list = await scope.api.rooms.list({ version: VERSION, readId: newId() });
  return list.items;
}

export type StartDiscussion =
  | { readonly kind: 'topic'; readonly title: string }
  | { readonly kind: 'content'; readonly root: { readonly assetId: string; readonly assetRevision: number } }
  | { readonly kind: 'message'; readonly discussionId: string; readonly messageId: string };

export type ModerateAction = { readonly kind: 'pause' } | { readonly kind: 'resume' };

export interface RoomState {
  /**
   * `preview`: the person is not a member (the view says what holds them back, if anything).
   * `unavailable`: no such room as far as this person can tell; the screen says so without saying why.
   */
  readonly phase: 'loading' | 'preview' | 'member' | 'unavailable' | 'failed';
  /** The last answer the server gave, preview or member. */
  readonly view: Exclude<RoomView, { status: 'unavailable' }> | undefined;
  /** The last read did not arrive; what is shown may be out of date. */
  readonly offline: boolean;
  /** A command (join, leave, start, moderate) is in flight. */
  readonly working: boolean;
  /** The last command the server refused, so the screen can say it plainly; cleared by the next one. */
  readonly refused: boolean;
}

export interface RoomController {
  readonly getState: () => RoomState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Reads the room afresh: a preview for an outsider, the discussions for a member. */
  readonly load: () => Promise<void>;
  /** Joins the room. Returns whether the server accepted it; the room is read again either way. */
  readonly join: () => Promise<boolean>;
  readonly leave: () => Promise<boolean>;
  /** A moderator pauses or resumes the room. */
  readonly moderate: (action: ModerateAction) => Promise<boolean>;
  /** Starts a discussion and returns its ID; `undefined` when the server refused or could not be reached. */
  readonly startDiscussion: (start: StartDiscussion) => Promise<string | undefined>;
  /** A member invites a friend by their public person ID. */
  readonly invite: (friendPersonId: string) => Promise<boolean>;
}

export interface RoomOptions {
  readonly scope: AccountScope;
  readonly roomId: string;
  readonly newId: () => string;
}

const initial: RoomState = { phase: 'loading', view: undefined, offline: false, working: false, refused: false };

/**
 * One room's client state. The server owns membership, the discussions and what the person may do;
 * this keeps the last answer and the commands in flight. Each intent keeps its command ID until the
 * server answers, so a retry after an unknown outcome is the same command and never joins, starts or
 * invites twice.
 */
export function createRoom(options: RoomOptions): RoomController {
  const { scope, roomId, newId } = options;
  const listeners = new Set<() => void>();
  const intents = new Map<string, string>();
  let state = initial;

  const publish = (patch: Partial<RoomState>): void => {
    if (!scope.active) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };

  const failed = (error: unknown): void => {
    const kind = talkFailure(error);
    if (kind === 'ended') return;
    if (kind === 'unavailable') publish({ phase: 'unavailable' });
    else if (state.phase === 'loading') publish({ phase: 'failed', offline: kind === 'offline' });
    else publish({ offline: true });
  };

  async function load(): Promise<void> {
    try {
      const view = await scope.api.rooms.read({ version: VERSION, readId: newId(), roomId });
      if (view.status === 'unavailable') publish({ phase: 'unavailable', view: undefined, offline: false });
      else publish({ phase: view.status, view, offline: false });
    } catch (error) {
      failed(error);
    }
  }

  /** Runs one command under the intent's command ID; a definitive answer retires the ID, an unknown one keeps it. */
  async function command<T>(intent: string, run: (commandId: string) => Promise<T>): Promise<T | undefined> {
    if (state.working) return undefined;
    publish({ working: true, refused: false });
    const commandId = intents.get(intent) ?? newId();
    intents.set(intent, commandId);
    try {
      const accepted = await run(commandId);
      intents.delete(intent);
      publish({ working: false });
      return accepted;
    } catch (error) {
      const kind = talkFailure(error);
      publish({ working: false });
      if (kind === 'ended') return undefined;
      if (kind !== 'offline') intents.delete(intent);
      if (kind === 'offline') publish({ offline: true });
      else publish({ refused: true });
      // A refusal means the room changed meanwhile; reading says how.
      if (kind !== 'offline') await load();
      return undefined;
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    load,
    async join() {
      const accepted = await command('join', (commandId) =>
        scope.api.rooms.join({ version: VERSION, commandId, roomId }),
      );
      if (accepted !== undefined) await load();
      return accepted !== undefined;
    },
    async leave() {
      const accepted = await command('leave', (commandId) =>
        scope.api.rooms.leave({ version: VERSION, commandId, roomId }),
      );
      if (accepted !== undefined) await load();
      return accepted !== undefined;
    },
    async moderate(action) {
      const accepted = await command(`moderate:${action.kind}`, (commandId) =>
        scope.api.rooms.moderate({ version: VERSION, commandId, roomId, action }),
      );
      if (accepted !== undefined) await load();
      return accepted !== undefined;
    },
    async startDiscussion(start) {
      const created = await command(`start:${JSON.stringify(start)}`, (commandId) =>
        scope.api.rooms.createDiscussion({ version: VERSION, commandId, roomId, start }),
      );
      if (created !== undefined) await load();
      return created?.discussionId;
    },
    async invite(friendPersonId) {
      const accepted = await command(`invite:${friendPersonId}`, (commandId) =>
        scope.api.rooms.invite({ version: VERSION, commandId, roomId, friendPersonId }),
      );
      return accepted !== undefined;
    },
  };
}
