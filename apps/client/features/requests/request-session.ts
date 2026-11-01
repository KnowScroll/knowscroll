import { apiProblem, recordingCommandFields, type AccountScope } from '@knowscroll/client-core';
import type {
  CancelContentRequest,
  ContentRequestReceipt,
  ContentRequestStatus,
  CreateContentRequest,
  RetryContentRequest,
} from '@knowscroll/contracts';
import { ENCOUNTER_CAPABILITIES } from '../encounter/capabilities';

type Source = Extract<CreateContentRequest['intent'], { kind: 'variant' }>['source'];
type Format = 'reel' | 'scroll' | 'either';
/** `ask`: a question about the Scroll being read, from one of its stops (D1). The others are the E04 and E06 sheets. */
export type RequestMode = 'topic' | 'reel' | 'scroll' | 'ask';
/** Where in the Scroll an ask was made: the stop on screen when the sheet opened. */
export interface AskAnchor {
  readonly stopId: string;
}
export const suggestions = [
  { id: 'earth.seasons', label: 'Seasons' },
  { id: 'earth.tides', label: 'Tides' },
  { id: 'earth.greenhouse-effect', label: 'The greenhouse effect' },
] as const;
export interface RequestState {
  readonly phase:
    | 'draft'
    | 'sending'
    | 'send_unknown'
    | 'accepted'
    | 'cancelling'
    | 'cancel_unknown'
    | 'retrying'
    | 'retry_unknown'
    | 'refused'
    | 'ended';
  readonly mode: RequestMode;
  readonly text: string;
  readonly format: Format;
  readonly about: boolean;
  readonly topicId?: string;
  /** For an ask: the stop it is made from. */
  readonly anchor?: AskAnchor;
  readonly source?: Source;
  readonly receipt?: ContentRequestReceipt;
  readonly status?: ContentRequestStatus;
  /**
   * `too_many_open`: the person already has the most open asks they may have. `not_retryable`: Try
   * again was answered that this request cannot be tried again; the closed request is unchanged.
   * `paused`: an ask from here is off while recording is paused (D-083).
   */
  readonly error?: 'source' | 'read' | 'refused' | 'too_many_open' | 'not_retryable' | 'paused';
  readonly reading?: boolean;
  /** The notice the person put away (Later, Dismiss): kept with the request, so a remount does not bring it back. */
  readonly dismissedRequestId?: string;
}
const initial = (): RequestState => ({ phase: 'draft', mode: 'topic', text: '', format: 'either', about: false });
/** A question about the Scroll in front of the person: this scope is the default, and "Something new" the way out. */
const initialAsk = (anchor: AskAnchor | undefined): RequestState => ({
  ...initial(),
  mode: 'ask',
  about: true,
  anchor,
});
const sameSource = (a: Source | undefined, b: Source | undefined) => JSON.stringify(a) === JSON.stringify(b);

/** A request still being made is read quickly at first (twelve reads, about a minute) ... */
const QUICK_READS = 12;
const QUICK_READ_EVERY_MS = 5000;
/** ... then slowly: fifty more, ten minutes, well past an order's own bound (D-250). A request that settles ends the reads. */
const SLOW_READS = 50;
export const SLOW_READ_EVERY_MS = 12_000;

/** Private memory belongs to this AccountScope. No draft, command, receipt or request list is persisted. */
export function createRequestSession(
  scope: AccountScope,
  newId: () => string,
  sourceNow: () => Source | undefined,
  openContent: (target: { kind: 'return'; assetId: string; assetRevision: number }) => boolean,
) {
  let state = initial();
  let live = true;
  let visible = false;
  let generation = 0;
  let readSerial = 0;
  let polls = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let command: CreateContentRequest | undefined;
  let cancelCommand: CancelContentRequest | undefined;
  let retryCommand: RetryContentRequest | undefined;
  const listeners = new Set<() => void>();
  const valid = () => live && scope.active;
  const publish = (patch: Partial<RequestState>) => {
    if (!valid()) return;
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    stop();
    if (
      valid() &&
      visible &&
      state.phase === 'accepted' &&
      !state.error &&
      state.status?.status === 'preparing' &&
      polls < QUICK_READS + SLOW_READS
    ) {
      timer = setTimeout(
        () => {
          polls += 1;
          void read();
        },
        polls < QUICK_READS ? QUICK_READ_EVERY_MS : SLOW_READ_EVERY_MS,
      );
    }
  };
  async function read(): Promise<ContentRequestStatus | undefined> {
    const receipt = state.receipt;
    if (!valid() || !visible || !receipt) return;
    const current = generation;
    const serial = ++readSerial;
    publish({ reading: true });
    try {
      const snapshot = await scope.queryClient.fetchQuery({
        queryKey: scope.queryKey('requests', receipt.requestId),
        staleTime: 0,
        retry: false,
        queryFn: async () => {
          const incoming = await scope.api.supply.read({ requestId: receipt.requestId });
          if (!valid() || current !== generation) throw new Error('request_ended');
          if (incoming.requestId !== receipt.requestId || incoming.privacyEpoch !== scope.account.privacyEpoch)
            throw new Error('request_lineage');
          const previous = scope.queryClient.getQueryData<ContentRequestStatus>(
            scope.queryKey('requests', receipt.requestId),
          );
          return previous && previous.requestRevision > incoming.requestRevision ? previous : incoming;
        },
      });
      if (!valid() || current !== generation || state.receipt?.requestId !== receipt.requestId) return;
      if (!state.status || snapshot.requestRevision >= state.status.requestRevision)
        publish({ status: snapshot, error: undefined });
      return state.status;
    } catch {
      if (valid() && current === generation && serial === readSerial) publish({ error: 'read' });
      return;
    } finally {
      if (valid() && current === generation && serial === readSerial) {
        publish({ reading: false });
        schedule();
      }
    }
  }
  async function send() {
    if (!valid() || !visible || !command || !['draft', 'send_unknown'].includes(state.phase)) return;
    const input = command;
    const current = generation;
    publish({ phase: 'sending', error: undefined });
    try {
      const receipt = await scope.api.supply.create(input);
      if (!valid() || current !== generation) return;
      if (receipt.commandId !== input.commandId || receipt.privacyEpoch !== scope.account.privacyEpoch)
        throw new Error('receipt_lineage');
      publish({ phase: 'accepted', receipt });
      // Acceptance and replay contain no current availability. Read even for immediate reuse.
      if (visible) void read();
    } catch (error) {
      if (!valid() || current !== generation) return;
      const problem = apiProblem(error);
      const refused = problem && problem.status >= 400 && problem.status < 500;
      publish({
        phase: refused ? 'refused' : 'send_unknown',
        error: refused
          ? problem.code === 'TOO_MANY_REQUESTS'
            ? 'too_many_open'
            : problem.code === 'RECORDING_PAUSED'
              ? 'paused'
              : 'refused'
          : undefined,
      });
    }
  }
  async function runCancel() {
    if (!valid() || !visible || !cancelCommand || !['accepted', 'cancel_unknown'].includes(state.phase)) return;
    const input = cancelCommand;
    const current = generation;
    stop();
    publish({ phase: 'cancelling' });
    try {
      const receipt = await scope.api.supply.cancel(input);
      if (!valid() || current !== generation) return;
      if (
        receipt.commandId !== input.commandId ||
        receipt.requestId !== input.requestId ||
        receipt.privacyEpoch !== scope.account.privacyEpoch
      )
        throw new Error('cancel_lineage');
      cancelCommand = undefined;
      publish({ phase: 'accepted' });
      if (visible) void read();
    } catch (error) {
      if (!valid() || current !== generation) return;
      const problem = apiProblem(error);
      publish({
        phase: problem && problem.status >= 400 && problem.status < 500 ? 'refused' : 'cancel_unknown',
        error: problem ? 'refused' : undefined,
      });
    }
  }
  /**
   * Try again: `request.retry{requestId}` re-drives this same request, so there is one request, not a
   * second one beside the closed one. An unconfirmed retry goes again with its exact command; the
   * answer "not retryable" leaves the closed request as it was and says so.
   */
  async function runRetry() {
    if (!valid() || !visible || !retryCommand || !['accepted', 'retry_unknown'].includes(state.phase)) return;
    const input = retryCommand;
    const current = generation;
    stop();
    publish({ phase: 'retrying', error: undefined });
    try {
      const receipt = await scope.api.supply.retry(input);
      if (!valid() || current !== generation) return;
      if (
        receipt.commandId !== input.commandId ||
        receipt.requestId !== input.requestId ||
        receipt.privacyEpoch !== scope.account.privacyEpoch
      )
        throw new Error('retry_lineage');
      retryCommand = undefined;
      polls = 0;
      if (receipt.outcome === 'not_retryable') {
        // Nothing changed: the closed request stays on screen, with the reason it cannot go again.
        publish({ phase: 'accepted', error: 'not_retryable' });
        return;
      }
      // A reopened request reads afresh.
      publish({ phase: 'accepted', error: undefined, status: undefined });
      if (visible) void read();
    } catch (error) {
      if (!valid() || current !== generation) return;
      const problem = apiProblem(error);
      const refused = problem !== undefined && problem.status >= 400 && problem.status < 500;
      if (refused) retryCommand = undefined;
      publish({
        phase: refused ? 'accepted' : 'retry_unknown',
        error: refused ? (problem.code === 'TOO_MANY_REQUESTS' ? 'too_many_open' : 'not_retryable') : undefined,
      });
    }
  }
  function reset(mode: RequestMode, anchor?: AskAnchor) {
    generation += 1;
    stop();
    command = undefined;
    cancelCommand = undefined;
    retryCommand = undefined;
    polls = 0;
    state = { ...(mode === 'ask' ? initialAsk(anchor) : { ...initial(), mode }), source: sourceNow() };
    publish({});
  }
  scope.onEnd?.(() => {
    live = false;
    generation += 1;
    stop();
    command = undefined;
    cancelCommand = undefined;
    retryCommand = undefined;
    state = { ...initial(), phase: 'ended' };
    listeners.forEach((listener) => listener());
    listeners.clear();
  });
  let building = false;
  /**
   * An ask from here (D1): the person's words and the stop they asked from. It is tied to what they have read, so it is
   * refused while recording is paused, on the device first and then by the server (D-083). "Something new" sends the
   * words as a free-text ask instead, with no source. The recording generation is read once, before the first send,
   * and the same command goes again only after an unknown outcome.
   */
  async function submitAsk() {
    const question = state.text.trim();
    if (!valid() || !visible || state.phase !== 'draft' || command || building || question.length < 3) return;
    if (!state.about) {
      command = {
        version: 'content-request.v1',
        commandId: newId(),
        intent: { kind: 'topic', subject: { kind: 'text', text: question }, format: 'scroll' },
        language: 'en',
        capabilities: ENCOUNTER_CAPABILITIES,
      };
      void send();
      return;
    }
    if (!state.source || !state.anchor || !sameSource(state.source, sourceNow())) {
      publish({ error: 'source' });
      return;
    }
    if (scope.recording?.getState().policy?.on === false) {
      publish({ error: 'paused' });
      return;
    }
    building = true;
    const current = generation;
    try {
      const { recordingGeneration } = await recordingCommandFields(scope);
      if (!valid() || current !== generation || state.phase !== 'draft' || !state.source || !state.anchor) return;
      command = {
        version: 'content-request.v1',
        commandId: newId(),
        intent: {
          kind: 'ask',
          source: state.source,
          anchor: { kind: 'stop', stopId: state.anchor.stopId },
          question,
          recordingGeneration,
        },
        language: 'en',
        capabilities: ENCOUNTER_CAPABILITIES,
      };
    } catch {
      if (valid() && current === generation) publish({ error: 'read' });
      return;
    } finally {
      building = false;
    }
    void send();
  }
  /** Sends the draft as one deliberate request, once; the same command goes again only after an unknown outcome. */
  function submit() {
    if (state.mode === 'ask') {
      void submitAsk();
      return;
    }
    if (!valid() || !visible || state.phase !== 'draft' || command) return;
    if ((state.about || state.mode !== 'topic') && (!state.source || !sameSource(state.source, sourceNow()))) {
      publish({ error: 'source' });
      return;
    }
    if (state.mode === 'topic' && !state.topicId && !state.text.trim()) return;
    const intent: CreateContentRequest['intent'] =
      state.mode === 'topic'
        ? {
            kind: 'topic',
            subject: state.topicId
              ? { kind: 'catalogue', catalogueVersion: 'content-concepts.v1', topicId: state.topicId }
              : { kind: 'text', text: state.text.trim() },
            format: state.format,
            ...(state.about ? { context: state.source! } : {}),
          }
        : { kind: 'variant', source: state.source!, to: state.mode };
    command = {
      version: 'content-request.v1',
      commandId: newId(),
      intent,
      language: 'en',
      capabilities: ENCOUNTER_CAPABILITIES,
    };
    void send();
  }
  /**
   * "Ask differently" after a closed request: back to the draft with the same words, format and
   * source, so the person edits instead of retyping. The closed request stays closed.
   */
  function editAgain() {
    if (!valid() || state.phase !== 'accepted' || !state.receipt || state.status?.status === 'preparing') return;
    generation += 1;
    stop();
    command = undefined;
    cancelCommand = undefined;
    retryCommand = undefined;
    polls = 0;
    publish({ phase: 'draft', receipt: undefined, status: undefined, error: undefined, reading: false });
  }
  return {
    getState: () => state,
    subscribe(this: void, listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    show(mode: RequestMode, anchor?: AskAnchor) {
      if (!valid()) return;
      const now = sourceNow();
      // Reopen only the retained exact-entry request; a different entry requires an explicit fresh draft.
      if (state.phase === 'draft' && (!state.source || state.error === 'source')) reset(mode, anchor);
      else if (state.source?.exposureId !== now?.exposureId || mode !== state.mode) {
        if (
          state.phase === 'sending' ||
          state.phase === 'send_unknown' ||
          state.phase === 'cancelling' ||
          state.phase === 'cancel_unknown'
        )
          return false;
        reset(mode, anchor);
      } else if (mode === 'ask' && state.phase === 'draft' && anchor?.stopId !== state.anchor?.stopId)
        // The same unsent question, asked from the stop the person is on now.
        publish({ anchor });
      return true;
    },
    visible(value: boolean) {
      visible = value && valid();
      stop();
      if (visible && state.receipt && state.phase === 'accepted') {
        polls = 0;
        void read();
      }
    },
    edit(patch: Partial<Pick<RequestState, 'text' | 'format' | 'about' | 'topicId'>>) {
      if (!valid() || state.phase !== 'draft' || command || building) return;
      publish({
        ...patch,
        ...(patch.text !== undefined ? { text: patch.text.slice(0, 500), topicId: undefined } : {}),
      });
    },
    submit,
    retrySend() {
      if (state.phase === 'send_unknown') void send();
    },
    /** Puts the ready or unavailable notice for this request away. The request itself is untouched. */
    dismissNotice() {
      if (valid() && state.receipt) publish({ dismissedRequestId: state.receipt.requestId });
    },
    refresh: read,
    cancel() {
      if (!valid() || state.phase !== 'accepted' || !state.receipt || state.status?.status !== 'preparing') return;
      cancelCommand = { version: 'content-request-cancel.v1', commandId: newId(), requestId: state.receipt.requestId };
      void runCancel();
    },
    retryCancel() {
      if (state.phase === 'cancel_unknown') void runCancel();
    },
    /**
     * "Ask differently" after a closed request: back to the draft with the same words, format and
     * source, so the person edits instead of retyping. The closed request stays closed.
     */
    editAgain,
    /**
     * "Try again" after "Couldn't prepare": asks the server to re-drive this same request
     * (`request.retry`). One request stays one request; the closed one is never copied.
     */
    tryAgain() {
      if (!valid() || !visible || state.phase !== 'accepted' || !state.receipt) return;
      const status = state.status;
      if (status?.status !== 'unavailable' || status.reason !== 'could_not_prepare') return;
      retryCommand = { version: 'content-request-retry.v1', commandId: newId(), requestId: state.receipt.requestId };
      void runRetry();
    },
    /** Sends the same Try again once more after an unconfirmed outcome, with its exact command. */
    retryTryAgain() {
      if (state.phase === 'retry_unknown') void runRetry();
    },
    startAgain() {
      if (valid() && !['sending', 'send_unknown', 'cancelling', 'cancel_unknown'].includes(state.phase)) {
        // Asking again from where the person is keeps the question's kind: a question about this Scroll stays one.
        if (state.mode === 'ask') reset('ask', state.anchor);
        else reset('topic');
      }
    },
    async openReady() {
      if (!valid() || !visible || state.phase !== 'accepted' || state.status?.status !== 'ready') return false;
      const current = generation;
      const latest = await read();
      if (!valid() || !visible || current !== generation || latest?.status !== 'ready') return false;
      return openContent({
        kind: 'return',
        assetId: latest.content.assetId,
        assetRevision: latest.content.assetRevision,
      });
    },
  };
}
export type RequestSession = ReturnType<typeof createRequestSession>;
