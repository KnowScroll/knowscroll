import type { ActivityView, NewActivity, RoomActivitySummary } from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import { talkFailure } from './talk-failure';

const VERSION = 'rooms.v1' as const;

type Ready = Extract<ActivityView, { status: 'ready' }>;

export interface RoomActivitiesState {
  /** `unavailable`: not a member, or no such room; the screen says so without saying why. */
  readonly phase: 'loading' | 'ready' | 'unavailable' | 'failed';
  readonly activities: readonly RoomActivitySummary[];
  /** The person may start one: a moderator of a room that is open. */
  readonly canCreate: boolean;
  readonly offline: boolean;
  readonly working: boolean;
  /** The last command was refused, so the screen can say so plainly; cleared by the next one. */
  readonly refused: boolean;
}

export interface RoomActivitiesController {
  readonly getState: () => RoomActivitiesState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly load: () => Promise<void>;
  /** Starts a poll or quiz; returns its ID, or `undefined` when it was refused or did not arrive. */
  readonly create: (activity: NewActivity) => Promise<string | undefined>;
}

export interface RoomActivitiesOptions {
  readonly scope: AccountScope;
  readonly roomId: string;
  readonly newId: () => string;
}

const initialList: RoomActivitiesState = {
  phase: 'loading',
  activities: [],
  canCreate: false,
  offline: false,
  working: false,
  refused: false,
};

/** Runs one command under the intent's command ID: a definitive answer retires it, an unknown one keeps it, so a retry is the same command. */
function intentRunner(newId: () => string) {
  const intents = new Map<string, string>();
  return async function run<T>(
    intent: string,
    send: (commandId: string) => Promise<T>,
  ): Promise<
    | { readonly kind: 'ok'; readonly value: T }
    | { readonly kind: 'refused' }
    | { readonly kind: 'offline' }
    | { readonly kind: 'ended' }
  > {
    const commandId = intents.get(intent) ?? newId();
    intents.set(intent, commandId);
    try {
      const value = await send(commandId);
      intents.delete(intent);
      return { kind: 'ok', value };
    } catch (error) {
      const failure = talkFailure(error);
      if (failure === 'ended') return { kind: 'ended' };
      if (failure === 'offline') return { kind: 'offline' };
      intents.delete(intent);
      return { kind: 'refused' };
    }
  };
}

/**
 * One room's activities (R03): the list a member reads, and a moderator's start of a poll or quiz. The
 * server owns who may do what; this keeps the last answer and the command in flight. Nothing here is
 * observed or recorded: opening a list is not an event.
 */
export function createRoomActivities(options: RoomActivitiesOptions): RoomActivitiesController {
  const { scope, roomId, newId } = options;
  const listeners = new Set<() => void>();
  const run = intentRunner(newId);
  let state = initialList;
  const publish = (patch: Partial<RoomActivitiesState>): void => {
    if (!scope.active) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };

  async function load(): Promise<void> {
    try {
      const answer = await scope.api.rooms.activities({ version: VERSION, readId: newId(), roomId });
      if (answer.status === 'unavailable')
        publish({ phase: 'unavailable', activities: [], canCreate: false, offline: false });
      else publish({ phase: 'ready', activities: answer.activities, canCreate: answer.canCreate, offline: false });
    } catch (error) {
      const failure = talkFailure(error);
      if (failure === 'ended') return;
      if (failure === 'unavailable') publish({ phase: 'unavailable', activities: [], canCreate: false });
      else if (state.phase === 'loading') publish({ phase: 'failed', offline: failure === 'offline' });
      else publish({ offline: true });
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    load,
    async create(activity) {
      if (state.working) return undefined;
      publish({ working: true, refused: false });
      const outcome = await run(`create:${JSON.stringify(activity)}`, (commandId) =>
        scope.api.rooms.createActivity({ version: VERSION, commandId, roomId, activity }),
      );
      publish({ working: false });
      if (outcome.kind === 'ended') return undefined;
      if (outcome.kind === 'offline') {
        publish({ offline: true });
        return undefined;
      }
      if (outcome.kind === 'refused') {
        publish({ refused: true });
        await load();
        return undefined;
      }
      await load();
      return outcome.value.activityId;
    },
  };
}

export interface RoomActivityState {
  readonly phase: 'loading' | 'ready' | 'unavailable' | 'failed';
  readonly view: Ready | undefined;
  readonly offline: boolean;
  readonly working: boolean;
  /** A vote that did not reach the server: the option, so the screen can say "Not sent yet" and offer it again. */
  readonly notSent: string | undefined;
  readonly refused: boolean;
}

export interface RoomActivityController {
  readonly getState: () => RoomActivityState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly load: () => Promise<void>;
  /** Votes, or changes the vote, in a poll. Retrying an unsent vote sends the identical command. */
  readonly vote: (optionId: string) => Promise<boolean>;
  /** A moderator closes the poll or removes the activity. */
  readonly moderate: (action: 'close' | 'remove') => Promise<boolean>;
}

export interface RoomActivityOptions extends RoomActivitiesOptions {
  readonly activityId: string;
}

const initialActivity: RoomActivityState = {
  phase: 'loading',
  view: undefined,
  offline: false,
  working: false,
  notSent: undefined,
  refused: false,
};

/**
 * One poll or quiz. A poll is read afresh on focus and every so often by the screen; a vote that gets
 * no answer stays "not sent yet" and can be sent again as the very same command. A quiz is served whole
 * and answered on the device: no controller here sends an answer, because the server keeps none.
 */
export function createRoomActivity(options: RoomActivityOptions): RoomActivityController {
  const { scope, roomId, activityId, newId } = options;
  const listeners = new Set<() => void>();
  const run = intentRunner(newId);
  let state = initialActivity;
  const publish = (patch: Partial<RoomActivityState>): void => {
    if (!scope.active) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };

  async function load(): Promise<void> {
    try {
      const answer = await scope.api.rooms.readActivity({ version: VERSION, readId: newId(), roomId, activityId });
      if (answer.status === 'unavailable') publish({ phase: 'unavailable', view: undefined, offline: false });
      else publish({ phase: 'ready', view: answer, offline: false });
    } catch (error) {
      const failure = talkFailure(error);
      if (failure === 'ended') return;
      if (failure === 'unavailable') publish({ phase: 'unavailable', view: undefined });
      else if (state.phase === 'loading') publish({ phase: 'failed', offline: failure === 'offline' });
      else publish({ offline: true });
    }
  }

  async function command<T>(
    intent: string,
    send: (commandId: string) => Promise<T>,
  ): Promise<'ok' | 'refused' | 'offline' | 'ended' | 'busy'> {
    if (state.working) return 'busy';
    publish({ working: true, refused: false });
    const outcome = await run(intent, send);
    publish({ working: false });
    if (outcome.kind === 'ended') return 'ended';
    if (outcome.kind === 'offline') {
      publish({ offline: true });
      return 'offline';
    }
    if (outcome.kind === 'refused') {
      publish({ refused: true });
      await load();
      return 'refused';
    }
    await load();
    return 'ok';
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    load,
    async vote(optionId) {
      publish({ notSent: undefined });
      const outcome = await command(`vote:${optionId}`, (commandId) =>
        scope.api.rooms.votePoll({ version: VERSION, commandId, roomId, activityId, optionId }),
      );
      if (outcome === 'offline') publish({ notSent: optionId });
      return outcome === 'ok';
    },
    async moderate(action) {
      const outcome = await command(`moderate:${action}`, (commandId) =>
        scope.api.rooms.moderateActivity({ version: VERSION, commandId, roomId, activityId, action }),
      );
      return outcome === 'ok';
    },
  };
}
