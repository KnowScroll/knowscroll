import { talliesAfterEach, NO_TALLY } from '@knowscroll/scroll-model';
import type { CallLockResponse, ScrollResults } from '@knowscroll/contracts';
import { ScopeEndedError, type AccountScope } from './account-scope';
import { apiProblem } from './api-client';
import type { OutboxTimers } from './recorder/outbox';

/**
 * Play on one Scroll revision, on the device and, unless the person paused recording, on the server
 * (D-063, D-083, D-180). A Call it that is locked shows at once, judged here from the document; the
 * same lock is sent to be kept, and what the server answers (the first lock that stands, the
 * sparks) wins over the device's own tally.
 *
 * Nothing here is evidence: the option picked and whether it was right stay in this session and in
 * `play.*`. The reader reports only the value-free "revealed" to the recorder, as before.
 */

/** A Call it as the device needs it to judge a lock: the stop and which option is right. */
export interface PlayCall {
  readonly stopId: string;
  readonly answer: number;
}

/** Whether a lock is kept, in the words the screen needs. */
export type PlayKeeping =
  /** Stored on the server. */
  | 'saved'
  /** Recording is paused: nothing is stored, by choice (D-083). */
  | 'recording_paused'
  /** Not reached yet; it is sent again while this is open. */
  | 'waiting'
  /** The server will not take it (the revision, the call or the exposure is not one it knows). */
  | 'refused';

export interface PlayLock {
  readonly stopId: string;
  /** Zero-based index of the option locked. */
  readonly option: number;
  readonly correct: boolean;
  /** The run of right calls this lock ended at; zero for a wrong call. */
  readonly combo: number;
  readonly keeping: PlayKeeping;
}

export interface PlaySnapshot {
  /** In the order they were locked, those kept earlier first. */
  readonly locks: readonly PlayLock[];
  readonly sparks: number;
  readonly combo: number;
}

export interface PlaySession {
  readonly getSnapshot: () => PlaySnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  /** Reads what the server kept for this revision. Safe to call again; a failed read leaves the device's own play. */
  readonly load: () => Promise<void>;
  /** Locks in an option of a Call it. A call already locked, or an option it does not have, changes nothing. */
  readonly lock: (stopId: string, option: number) => void;
  /** Sends again what could not be reached. */
  readonly retry: () => Promise<void>;
}

export interface PlaySessionOptions {
  readonly scope: AccountScope;
  readonly assetId: string;
  readonly revision: number;
  /** The Call its of this revision. The Final call is not played here yet. */
  readonly calls: readonly PlayCall[];
  readonly newId: () => string;
  readonly timers?: OutboxTimers;
}

/** The waits before an unreached lock is sent again while the screen is open. */
export const PLAY_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 30_000];

/** Problems no retry can fix: the server does not know this revision, call or exposure, or the request itself is wrong. */
const REFUSED_PROBLEMS: ReadonlySet<string> = new Set([
  'NOT_FOUND',
  'INVALID_REQUEST',
  'UNPROCESSABLE_REQUEST',
  'COMMAND_KEY_REUSED',
]);

const defaultTimers: OutboxTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Entry {
  readonly stopId: string;
  readonly option: number;
  readonly correct: boolean;
  readonly commandId: string;
  readonly keeping: PlayKeeping;
}

function snapshotOf(entries: readonly Entry[]): PlaySnapshot {
  const tallies = talliesAfterEach(entries);
  return {
    locks: entries.map((entry, index) => ({
      stopId: entry.stopId,
      option: entry.option,
      correct: entry.correct,
      combo: tallies[index]!.combo,
      keeping: entry.keeping,
    })),
    ...(tallies.at(-1) ?? NO_TALLY),
  };
}

/** What the server kept, then what this device locked that the server does not know. */
function adopt(entries: readonly Entry[], results: ScrollResults): Entry[] {
  const kept = new Set(results.calls.map((call) => call.stopId));
  return [
    ...results.calls.map((call): Entry => ({ ...call, commandId: '', keeping: 'saved' })),
    ...entries.filter((entry) => !kept.has(entry.stopId)),
  ];
}

/**
 * Creates the session of one Scroll revision for one account scope. The scope ending (sign-out, an
 * account switch, a privacy reset or Clear) empties it and stops its retries, so nothing of one
 * person's play survives into another's.
 */
export function createPlaySession(options: PlaySessionOptions): PlaySession {
  const { scope, assetId, revision, newId } = options;
  const timers = options.timers ?? defaultTimers;
  const answers = new Map(options.calls.map((call) => [call.stopId, call.answer]));
  const listeners = new Set<() => void>();
  let entries: Entry[] = [];
  let snapshot = snapshotOf(entries);
  let flushing = false;
  let flushAgain = false;
  let retryTimer: unknown;
  let retries = 0;

  function set(next: Entry[]): void {
    if (!scope.active) return;
    entries = next;
    snapshot = snapshotOf(entries);
    for (const listener of [...listeners]) listener();
  }

  function settle(stopId: string, keeping: PlayKeeping): void {
    set(entries.map((entry) => (entry.stopId === stopId ? { ...entry, keeping } : entry)));
  }

  /** Sends one lock. True once it is settled for good (kept, refused or not to be kept); false to try again later. */
  async function send(entry: Entry): Promise<boolean> {
    const policy = scope.recording?.getState().policy;
    if (policy !== undefined && !policy.on) {
      settle(entry.stopId, 'recording_paused');
      return true;
    }
    let answer: CallLockResponse;
    try {
      const recordingGeneration = await scope.recording?.generation();
      if (recordingGeneration === undefined) throw new Error('recording_policy_unavailable');
      answer = await scope.api.play.lockCall({
        commandId: entry.commandId,
        assetId,
        revision,
        stopId: entry.stopId,
        option: entry.option,
        recordingGeneration,
      });
    } catch (error) {
      if (error instanceof ScopeEndedError || !scope.active) return true;
      if (REFUSED_PROBLEMS.has(apiProblem(error)?.code ?? '')) {
        settle(entry.stopId, 'refused');
        return true;
      }
      settle(entry.stopId, 'waiting');
      return false;
    }
    if (!scope.active) return true;
    if (!answer.recorded) {
      if (answer.reason === 'recording_paused') {
        settle(entry.stopId, 'recording_paused');
        return true;
      }
      // The policy moved on since this device read it: read it again and send the same lock.
      await scope.recording?.refresh();
      settle(entry.stopId, 'waiting');
      return false;
    }
    // An answer for another command or revision is not this lock's: never adopt it.
    if (answer.commandId !== entry.commandId || answer.assetId !== assetId || answer.revision !== revision) {
      settle(entry.stopId, 'refused');
      return true;
    }
    set(adopt(entries, answer.results));
    return true;
  }

  async function flush(): Promise<void> {
    if (flushing) {
      flushAgain = true;
      return;
    }
    flushing = true;
    try {
      do {
        flushAgain = false;
        for (const entry of entries.filter((candidate) => candidate.keeping === 'waiting')) {
          if (!(await send(entry))) {
            scheduleRetry();
            break;
          }
        }
      } while (flushAgain && scope.active);
    } finally {
      flushing = false;
    }
  }

  function scheduleRetry(): void {
    const delay = PLAY_RETRY_DELAYS_MS[retries];
    if (delay === undefined || !scope.active) return;
    retries += 1;
    timers.clearTimeout(retryTimer);
    retryTimer = timers.setTimeout(() => void flush(), delay);
  }

  scope.onEnd?.(() => {
    timers.clearTimeout(retryTimer);
    listeners.clear();
    entries = [];
    snapshot = snapshotOf(entries);
  });

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async load() {
      try {
        const results = await scope.api.play.readResults({ assetId, revision });
        if (!scope.active || results.assetId !== assetId || results.revision !== revision) return;
        set(adopt(entries, results));
      } catch {
        // Not reached: the device keeps its own play, and the next lock sends what is waiting.
      }
    },
    lock(stopId, option) {
      const answer = answers.get(stopId);
      if (!scope.active || answer === undefined || !Number.isInteger(option) || option < 0) return;
      if (entries.some((entry) => entry.stopId === stopId)) return;
      set([...entries, { stopId, option, correct: option === answer, commandId: newId(), keeping: 'waiting' }]);
      retries = 0;
      void flush();
    },
    async retry() {
      retries = 0;
      await flush();
    },
  };
}

const sessions = new WeakMap<AccountScope, Map<string, PlaySession>>();
/** More than this many Scrolls in one sitting, and the earliest is let go. */
const SESSIONS_PER_SCOPE = 24;

/**
 * The scope's session for one Scroll revision, created on first use and kept while the scope lives:
 * a lock that could not be sent goes on being tried after the screen is left, and coming back to a
 * Scroll shows what was locked, saved or not.
 */
export function playSessionFor(options: PlaySessionOptions): PlaySession {
  let own = sessions.get(options.scope);
  if (own === undefined) {
    own = new Map();
    sessions.set(options.scope, own);
  }
  const key = `${options.assetId}@${String(options.revision)}`;
  const existing = own.get(key);
  if (existing !== undefined) return existing;
  const created = createPlaySession(options);
  if (own.size >= SESSIONS_PER_SCOPE) {
    const oldest = own.keys().next();
    if (!oldest.done) own.delete(oldest.value);
  }
  own.set(key, created);
  return created;
}
