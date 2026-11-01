import type {
  AskQuickAnswer,
  QUICK_ANSWER_LABEL,
  QuickAnswerRefusalReason,
  QuickAnswerStatus,
} from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import { apiProblem } from './api-client';
import { recordingCommandFields } from './recording-policy';

/**
 * Quick answers on one Scroll revision (V3 D2, D-086, D-253): the cards under the words a person selected and asked about.
 * A card is the account scope's, never stored on the device: it is the server's short-lived, unchecked answer, and the
 * scope ending (sign-out, an account switch, a privacy reset, Clear) drops it. Nothing here is evidence, and asking never
 * moves where the person is in the Scroll.
 *
 * Asking sends one command and learns the answer later: the server accepts and stores it, a worker writes it, and the
 * client reads the status when a hint says the scope changed and, as the fallback, on a short timer. One card per stop:
 * asking again at a stop replaces what it showed.
 */

/** Why a card has no answer, in the words the screen needs. `paused` is the device's own check (D-254). */
export type QuickAnswerUnavailable = QuickAnswerRefusalReason | 'paused' | 'could_not_answer' | 'offline';

export type QuickAnswerCard =
  | { readonly phase: 'sending'; readonly passage: string }
  | { readonly phase: 'waiting'; readonly id: string; readonly passage: string }
  | {
      readonly phase: 'answered';
      readonly id: string;
      readonly passage: string;
      readonly label: typeof QUICK_ANSWER_LABEL;
      readonly question: string;
      readonly answer: string;
      /** False when what the person has read so far does not say enough to answer. */
      readonly covered: boolean;
    }
  | {
      readonly phase: 'unavailable';
      readonly passage: string;
      readonly reason: QuickAnswerUnavailable;
      /** Present when the server had stored an answer for it. */
      readonly id?: string;
    };

export interface QuickAnswerSnapshot {
  /** The card at each stop, by stop ID. */
  readonly cards: Readonly<Record<string, QuickAnswerCard>>;
}

export interface QuickAnswerSession {
  readonly getSnapshot: () => QuickAnswerSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  /** Asks about the selected words of a stop; `question` is the person's own follow-up. Never throws. */
  readonly ask: (input: {
    readonly stopId: string;
    readonly passage: string;
    readonly question?: string;
  }) => Promise<void>;
  /** Closes the card and, when the server holds an answer, asks it to erase the words now. */
  readonly dismiss: (stopId: string) => void;
}

export interface QuickAnswerSessionOptions {
  readonly scope: AccountScope;
  readonly assetId: string;
  readonly revision: number;
  readonly newId: () => string;
  /** The fallback poll; a hint reads at once. */
  readonly pollMs?: number;
  /** How many fallback polls before the card gives up. */
  readonly maxPolls?: number;
}

/** A poll every three seconds, the first after a second and a half: a little past the server's own three-minute wait limit. */
export const QUICK_ANSWER_POLL_MS = 3_000;
const FIRST_POLL_MS = 1_500;
const MAX_POLLS = 65;
const EMPTY: QuickAnswerSnapshot = { cards: {} };

/** Problems no retry can fix: the server does not know this Scroll, stop or words. */
const refusedBy = (error: unknown): 'paused' | 'refused' | undefined => {
  const problem = apiProblem(error);
  if (problem === undefined) return undefined;
  return problem.code === 'RECORDING_PAUSED' || problem.code === 'RECORDING_POLICY_STALE' ? 'paused' : 'refused';
};

export function createQuickAnswerSession(options: QuickAnswerSessionOptions): QuickAnswerSession {
  const { scope, assetId, revision } = options;
  const pollMs = options.pollMs ?? QUICK_ANSWER_POLL_MS;
  const maxPolls = options.maxPolls ?? MAX_POLLS;
  let snapshot: QuickAnswerSnapshot = EMPTY;
  const listeners = new Set<() => void>();
  /** The ask each stop is on now: an answer for an earlier ask at the stop is dropped. */
  const serials = new Map<string, number>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const unwatch: (() => void)[] = [];
  let serial = 0;

  const live = () => scope.active;
  const publish = (stopId: string, card: QuickAnswerCard | undefined) => {
    if (!live()) return;
    const cards = { ...snapshot.cards };
    if (card === undefined) delete cards[stopId];
    else cards[stopId] = card;
    snapshot = { cards };
    listeners.forEach((listener) => listener());
  };
  const current = (stopId: string, mine: number) => live() && serials.get(stopId) === mine;
  const stopTimer = (stopId: string) => {
    const timer = timers.get(stopId);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(stopId);
  };

  /** Reads one answer's status through the scope's query cache, so a hint that marks the scope stale reads it again. */
  async function readOnce(stopId: string, mine: number, id: string, passage: string): Promise<boolean> {
    try {
      const status: QuickAnswerStatus = await scope.queryClient.fetchQuery({
        queryKey: scope.queryKey('quick-answers', id),
        staleTime: 0,
        retry: false,
        queryFn: () => scope.api.quickAnswers.read({ quickAnswerId: id }),
      });
      if (!current(stopId, mine) || status.quickAnswerId !== id || status.privacyEpoch !== scope.account.privacyEpoch)
        return true;
      if (status.status === 'answered')
        publish(stopId, {
          phase: 'answered',
          id,
          passage,
          label: status.label,
          question: status.question,
          answer: status.answer,
          covered: status.covered,
        });
      else if (status.status === 'unavailable')
        publish(stopId, { phase: 'unavailable', id, passage, reason: status.reason });
      return status.status !== 'waiting';
    } catch (error) {
      // Gone (dismissed, past its day, erased) or not the person's: the card has nothing to wait for.
      if (current(stopId, mine) && apiProblem(error)?.code === 'NOT_FOUND')
        publish(stopId, { phase: 'unavailable', id, passage, reason: 'could_not_answer' });
      return apiProblem(error)?.code === 'NOT_FOUND';
    }
  }

  function watch(stopId: string, mine: number, id: string, passage: string) {
    let polls = 0;
    const tick = () => {
      stopTimer(stopId);
      if (!current(stopId, mine)) return;
      if (polls >= maxPolls) return publish(stopId, { phase: 'unavailable', id, passage, reason: 'could_not_answer' });
      polls += 1;
      void readOnce(stopId, mine, id, passage).then((done) => {
        if (!done && current(stopId, mine)) timers.set(stopId, setTimeout(tick, pollMs));
      });
    };
    // A hint says the scope changed: the cache entry of this answer is marked stale, and the card reads it at once.
    const stopWatching = scope.queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'invalidate') return;
      const key = event.query.queryKey as readonly unknown[];
      if (key[key.length - 1] === id && current(stopId, mine) && snapshot.cards[stopId]?.phase === 'waiting') tick();
    });
    unwatch.push(stopWatching);
    timers.set(stopId, setTimeout(tick, Math.min(FIRST_POLL_MS, pollMs)));
  }

  async function ask(input: { readonly stopId: string; readonly passage: string; readonly question?: string }) {
    if (!live()) return;
    const { stopId, passage } = input;
    const mine = ++serial;
    serials.set(stopId, mine);
    stopTimer(stopId);
    // Recording paused: the server keeps no record of reading, so nothing is sent (D-254). The card says so.
    if (scope.recording?.getState().policy?.on === false)
      return publish(stopId, { phase: 'unavailable', passage, reason: 'paused' });
    publish(stopId, { phase: 'sending', passage });
    try {
      const { recordingGeneration } = await recordingCommandFields(scope);
      const command: AskQuickAnswer = {
        version: 'quick-answer-ask.v1',
        commandId: options.newId(),
        source: { assetId, assetRevision: revision },
        stopId,
        passage,
        ...(input.question === undefined ? {} : { question: input.question }),
        recordingGeneration,
      };
      const result = await scope.api.quickAnswers.ask(command);
      if (!current(stopId, mine)) return;
      if (result.outcome === 'unavailable')
        return publish(stopId, { phase: 'unavailable', passage, reason: result.reason });
      if (result.commandId !== command.commandId || result.privacyEpoch !== scope.account.privacyEpoch)
        return publish(stopId, { phase: 'unavailable', passage, reason: 'could_not_answer' });
      publish(stopId, { phase: 'waiting', id: result.quickAnswerId, passage });
      watch(stopId, mine, result.quickAnswerId, passage);
    } catch (error) {
      if (!current(stopId, mine)) return;
      const refused = refusedBy(error);
      if (refused === 'paused') void scope.recording?.refresh();
      publish(stopId, {
        phase: 'unavailable',
        passage,
        reason: refused === 'paused' ? 'paused' : refused === 'refused' ? 'could_not_answer' : 'offline',
      });
    }
  }

  const end = () => {
    for (const stopId of [...timers.keys()]) stopTimer(stopId);
    unwatch.splice(0).forEach((stop) => stop());
    listeners.clear();
  };
  scope.onEnd?.(end);

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ask,
    dismiss(stopId) {
      const card = snapshot.cards[stopId];
      serials.set(stopId, ++serial);
      stopTimer(stopId);
      publish(stopId, undefined);
      const id = card !== undefined && 'id' in card ? card.id : undefined;
      // A dismissal that cannot reach the server leaves the words to expire with the day; the card is gone either way.
      if (id !== undefined && live()) void scope.api.quickAnswers.dismiss({ quickAnswerId: id }).catch(() => undefined);
    },
  };
}

const sessions = new WeakMap<AccountScope, Map<string, QuickAnswerSession>>();
/** A scope keeps this many Scrolls' cards; the oldest is dropped past it. */
const SESSIONS_PER_SCOPE = 8;

/** The scope's session for one Scroll revision, made once, so every screen that shows the Scroll shares its cards. */
export function quickAnswerSessionFor(options: QuickAnswerSessionOptions): QuickAnswerSession {
  let own = sessions.get(options.scope);
  if (own === undefined) {
    own = new Map();
    sessions.set(options.scope, own);
  }
  const key = `${options.assetId}@${String(options.revision)}`;
  const existing = own.get(key);
  if (existing !== undefined) return existing;
  const created = createQuickAnswerSession(options);
  if (own.size >= SESSIONS_PER_SCOPE) {
    const oldest = own.keys().next();
    if (!oldest.done) own.delete(oldest.value);
  }
  own.set(key, created);
  return created;
}

/** What a screen shows before the scope has a session: no cards. */
export const NO_QUICK_ANSWERS: QuickAnswerSnapshot = EMPTY;
