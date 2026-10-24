import { apiProblem, type AccountScope } from '@knowscroll/client-core';
import type {
  CancelContentRequest,
  ContentRequestReceipt,
  ContentRequestStatus,
  CreateContentRequest,
} from '@knowscroll/contracts';
import { ENCOUNTER_CAPABILITIES } from '../encounter/capabilities';

type Source = Extract<CreateContentRequest['intent'], { kind: 'variant' }>['source'];
type Format = 'reel' | 'scroll' | 'either';
export type RequestMode = 'topic' | 'reel' | 'scroll';
export const suggestions = [
  { id: 'earth.seasons', label: 'Seasons' },
  { id: 'earth.tides', label: 'Tides' },
  { id: 'earth.greenhouse-effect', label: 'The greenhouse effect' },
] as const;
export interface RequestState {
  readonly phase:
    'draft' | 'sending' | 'send_unknown' | 'accepted' | 'cancelling' | 'cancel_unknown' | 'refused' | 'ended';
  readonly mode: RequestMode;
  readonly text: string;
  readonly format: Format;
  readonly about: boolean;
  readonly topicId?: string;
  readonly source?: Source;
  readonly receipt?: ContentRequestReceipt;
  readonly status?: ContentRequestStatus;
  /** `too_many_open`: the person already has the most open asks they may have. */
  readonly error?: 'source' | 'read' | 'refused' | 'too_many_open';
  readonly reading?: boolean;
}
const initial = (): RequestState => ({ phase: 'draft', mode: 'topic', text: '', format: 'either', about: false });
const sameSource = (a: Source | undefined, b: Source | undefined) => JSON.stringify(a) === JSON.stringify(b);

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
      polls < 12
    ) {
      timer = setTimeout(() => {
        polls += 1;
        void read();
      }, 5000);
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
        error: refused ? (problem.code === 'TOO_MANY_REQUESTS' ? 'too_many_open' : 'refused') : undefined,
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
  function reset(mode: RequestMode) {
    generation += 1;
    stop();
    command = undefined;
    cancelCommand = undefined;
    polls = 0;
    state = { ...initial(), mode, source: sourceNow() };
    publish({});
  }
  scope.onEnd?.(() => {
    live = false;
    generation += 1;
    stop();
    command = undefined;
    cancelCommand = undefined;
    state = { ...initial(), phase: 'ended' };
    listeners.forEach((listener) => listener());
    listeners.clear();
  });
  return {
    getState: () => state,
    subscribe(this: void, listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    show(mode: RequestMode) {
      if (!valid()) return;
      const now = sourceNow();
      // Reopen only the retained exact-entry request; a different entry requires an explicit fresh draft.
      if (state.phase === 'draft' && (!state.source || state.error === 'source')) reset(mode);
      else if (state.source?.exposureId !== now?.exposureId || mode !== state.mode) {
        if (
          state.phase === 'sending' ||
          state.phase === 'send_unknown' ||
          state.phase === 'cancelling' ||
          state.phase === 'cancel_unknown'
        )
          return false;
        reset(mode);
      }
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
      if (!valid() || state.phase !== 'draft' || command) return;
      publish({
        ...patch,
        ...(patch.text !== undefined ? { text: patch.text.slice(0, 500), topicId: undefined } : {}),
      });
    },
    submit() {
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
    },
    retrySend() {
      if (state.phase === 'send_unknown') void send();
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
    startAgain() {
      if (valid() && !['sending', 'send_unknown', 'cancelling', 'cancel_unknown'].includes(state.phase)) reset('topic');
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
