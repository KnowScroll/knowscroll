import type { ContentThreadRef, ThreadCall } from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import { talkFailure } from './talk-failure';

const VERSION = 'content-thread.v1' as const;

/**
 * "Call it together" in one thread, as this person may see it (D-155). Each call is in one of four stages and
 * carries only what that stage may show: counts before the reveal, the person's own pick once they locked, and
 * everyone's picks only after the reveal.
 * - `unavailable`: the thread ended for this person; the screen says so elsewhere, here there is nothing to show.
 * - `failed`: the calls could not be read. They are an extra, so the thread goes on without them.
 */
export interface ThreadCallsState {
  readonly phase: 'loading' | 'ready' | 'unavailable' | 'failed';
  /** One for each part whose Scroll has an authored question, in part order. */
  readonly calls: readonly ThreadCall[];
  /** The part whose lock is on its way. */
  readonly locking: number | undefined;
  /**
   * Why the last lock was not kept, for that part's card to say: recording is paused (a pick is a play result and is
   * stored only while recording is on, D-083), or the request did not get an answer and the person may press again.
   */
  readonly notice: { readonly part: number; readonly reason: 'paused' | 'failed' } | undefined;
}

export interface ThreadCallsController {
  readonly getState: () => ThreadCallsState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Reads the calls afresh; called on open, on a hint, on focus and by the slow poll. Never throws. */
  readonly load: () => Promise<void>;
  /**
   * Locks this person's pick on the call of one part. The first lock stands, so pressing again after a lost answer is
   * safe. While recording is paused nothing is sent and the card says so. Never throws; the calls are read again
   * after every answer, so the card shows what the server holds.
   */
  readonly lock: (part: number, option: number) => Promise<void>;
}

const emptyState: ThreadCallsState = { phase: 'loading', calls: [], locking: undefined, notice: undefined };

/**
 * One thread's calls. The server owns them: this holds the last read and sends only this person's own pick. A pick
 * has no command ID because it is idempotent by its key (D-156). When the account scope ends (a switch, a sign-out,
 * Clear or a privacy reset) what was read, including other members' revealed picks, is dropped and nothing more is shown.
 */
export function createThreadCalls(options: {
  readonly scope: AccountScope;
  readonly thread: ContentThreadRef;
  readonly newId: () => string;
}): ThreadCallsController {
  const { scope, thread, newId } = options;
  let state: ThreadCallsState = emptyState;
  const listeners = new Set<() => void>();

  function publish(patch: Partial<ThreadCallsState>): void {
    if (!scope.active) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  }

  scope.onEnd?.(() => {
    state = emptyState;
    listeners.clear();
  });

  async function read(): Promise<void> {
    try {
      const answer = await scope.api.threads.calls({ version: VERSION, readId: newId(), thread });
      if (answer.status === 'unavailable') publish({ phase: 'unavailable', calls: [] });
      else publish({ phase: 'ready', calls: answer.calls });
    } catch (error) {
      if (talkFailure(error) === 'ended') return;
      // Keep what was shown: a failed read of an extra is not worth an error on the thread.
      if (state.phase === 'loading') publish({ phase: 'failed' });
    }
  }

  /** Asks the server to keep the pick; true once the server answered that the policy allowed it to be asked. */
  async function send(part: number, option: number): Promise<'kept' | 'paused' | 'stale' | 'failed'> {
    const recordingGeneration = await scope.recording?.generation();
    if (recordingGeneration === undefined) return 'failed';
    const answer = await scope.api.threads.lockCall({ version: VERSION, thread, part, option, recordingGeneration });
    if (answer.recorded) return 'kept';
    return answer.reason === 'recording_paused' ? 'paused' : 'stale';
  }

  async function lock(part: number, option: number): Promise<void> {
    if (state.locking !== undefined) return;
    // A pick is stored only while recording is on, and unknown counts as not on: nothing is sent.
    if (scope.recording?.getState().policy?.on === false) {
      publish({ notice: { part, reason: 'paused' } });
      return;
    }
    publish({ locking: part, notice: undefined });
    let outcome: Awaited<ReturnType<typeof send>> = 'failed';
    try {
      outcome = await send(part, option);
      if (outcome === 'stale') {
        // The policy moved on since this device read it: read it again and send the same pick once more.
        await scope.recording?.refresh();
        outcome = await send(part, option);
      }
    } catch (error) {
      if (talkFailure(error) === 'ended') return;
    }
    publish({
      locking: undefined,
      notice: outcome === 'kept' ? undefined : { part, reason: outcome === 'paused' ? 'paused' : 'failed' },
    });
    await read();
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    load: read,
    lock,
  };
}
