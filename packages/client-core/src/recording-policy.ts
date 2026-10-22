import {
  RecordingPolicyAcceptanceSchema,
  RecordingPolicyReadSchema,
  SetRecordingPolicySchema,
  type RecordingPolicy,
  type RecordingPolicyReceipt,
  type SetRecordingPolicy,
  type ReadRecordingPolicy,
  type SessionAccount,
} from '@knowscroll/contracts';
import { apiProblem, type ApiClient } from './api-client';

interface RecordingPolicyOwner {
  readonly account: SessionAccount;
  readonly api: Pick<ApiClient, 'recording'>;
  readonly active: boolean;
  onEnd?(listener: () => void): () => void;
  readonly storage?: {
    get(key: string): string | undefined;
    set(key: string, value: string): void;
    remove(key: string): void;
  };
}

export interface RecordingPolicyState {
  readonly status: 'checking' | 'current' | 'sending' | 'unknown' | 'ended';
  readonly policy?: RecordingPolicy;
  readonly receipt?: RecordingPolicyReceipt;
  readonly retryOriginal: boolean;
  /** Only an independently correlated CURRENT read can enable collection. */
  readonly collecting: boolean;
}
export interface RecordingPolicySession {
  getState(this: void): RecordingPolicyState;
  /** App supplies its platform UUID source before mounting recording consumers (Expo on native). */
  useIdSource(this: void, newId: () => string): void;
  subscribe(this: void, listener: () => void): () => void;
  refresh(this: void): Promise<boolean>;
  invalidate(this: void): void;
  /** The mounted owner latches background/blur; only foreground followed by a fresh read releases it. */
  setForeground(this: void, foreground: boolean): Promise<boolean>;
  checkOriginal(this: void): Promise<boolean>;
  set(this: void, on: boolean): Promise<boolean>;
  retryOriginal(this: void): Promise<boolean>;
  /** Necessary explicit commands capture even/off generations, once before their first send. */
  generation(this: void): Promise<number>;
  end(this: void): void;
}
const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** In-memory policy authority belongs to the actual scope object, never a persisted ACK. */
export function createRecordingPolicySession(
  scope: RecordingPolicyOwner,
  initialIdSource: () => string = () => globalThis.crypto.randomUUID(),
): RecordingPolicySession {
  let newId = initialIdSource;
  let state: RecordingPolicyState = { status: 'checking', retryOriginal: false, collecting: false };
  let live = true;
  let foreground = true;
  let serial = 0;
  let revision = -1;
  let pending: SetRecordingPolicy | undefined;
  let sending = false;
  let ambiguous = false;
  let generationRead: Promise<boolean> | undefined;
  const pendingKey = 'recording.policy.pending.v1';
  let unresolvedStorage = false;
  // Persist only the minimal exact command, never a policy snapshot or authority-granting ACK.
  try {
    const raw = scope.storage?.get(pendingKey);
    if (raw !== undefined) {
      const restored = SetRecordingPolicySchema.parse(JSON.parse(raw));
      if (restored.expectedPrivacyEpoch === scope.account.privacyEpoch) {
        pending = Object.freeze(restored);
        ambiguous = true;
        state = { status: 'unknown', retryOriginal: true, collecting: false };
      } else scope.storage?.remove(pendingKey);
    }
  } catch {
    unresolvedStorage = true;
    state = { status: 'unknown', retryOriginal: false, collecting: false };
  }
  const savePending = (): boolean => {
    try {
      if (pending) scope.storage?.set(pendingKey, JSON.stringify(pending));
      else scope.storage?.remove(pendingKey);
      return true;
    } catch {
      return false;
    }
  };
  const listeners = new Set<() => void>();
  const active = () => live && scope.active;
  const publish = (patch: Partial<RecordingPolicyState>) => {
    state = { ...state, ...patch, retryOriginal: pending !== undefined };
    for (const listener of [...listeners]) listener();
  };
  const receiptMatches = (receipt: RecordingPolicyReceipt, command: SetRecordingPolicy) =>
    sameId(receipt.commandId, command.commandId) &&
    receipt.requestedPrivacyEpoch === command.expectedPrivacyEpoch &&
    receipt.fromGeneration === command.expectedRecordingGeneration &&
    receipt.on === command.on;

  async function read(target: ReadRecordingPolicy['target']): Promise<boolean> {
    if (!active()) return false;
    const token = ++serial;
    publish({ status: 'checking', collecting: false });
    try {
      const request: ReadRecordingPolicy = { version: 'recording-policy.v1', readId: newId(), target };
      const answer = RecordingPolicyReadSchema.parse(await scope.api.recording.read(request));
      if (!active() || token !== serial) return false;
      if (
        !sameId(answer.readId, request.readId) ||
        !sameId(answer.scope.accountId, scope.account.accountId) ||
        answer.scope.privacyEpoch !== scope.account.privacyEpoch ||
        answer.target.kind !== target.kind ||
        (target.kind === 'command' &&
          (answer.target.kind !== 'command' || !sameId(answer.target.commandId, target.commandId))) ||
        answer.revision < revision ||
        (state.policy !== undefined &&
          (answer.policy.generation < state.policy.generation ||
            (answer.revision === revision && answer.policy.generation !== state.policy.generation)))
      )
        throw new Error('recording_read_lineage');
      revision = answer.revision;
      if (target.kind === 'command') {
        if ('receipt' in answer) {
          if (!pending || !receiptMatches(answer.receipt, pending)) throw new Error('recording_receipt_lineage');
          pending = undefined;
          savePending();
          publish({ receipt: answer.receipt, policy: answer.policy, collecting: false });
          // A recovered historical receipt cannot grant collection. Obtain a separate current read.
          return await read({ kind: 'current' });
        }
        publish({ status: 'unknown', policy: answer.policy, collecting: false });
        return false; // Absence does not cancel an earlier in-flight command.
      }
      publish({
        status: pending || unresolvedStorage ? 'unknown' : 'current',
        policy: answer.policy,
        collecting: foreground && !pending && !unresolvedStorage && answer.policy.on,
      });
      return !pending && !unresolvedStorage;
    } catch {
      if (active() && token === serial) publish({ status: 'unknown', collecting: false });
      return false;
    }
  }
  async function send(this: void): Promise<boolean> {
    const command = pending;
    if (!active() || !command || sending) return false;
    sending = true;
    ++serial; // Fence reads started before the local intent, before transport.
    publish({ status: 'sending', collecting: false });
    try {
      if (!savePending()) throw new Error('recording_choice_storage_unavailable');
      const ack = RecordingPolicyAcceptanceSchema.parse(await scope.api.recording.set(command));
      if (!active() || pending !== command) return false;
      if (!receiptMatches(ack.receipt, command)) throw new Error('recording_receipt_lineage');
      pending = undefined;
      savePending();
      publish({ receipt: ack.receipt, collecting: false });
      return await read({ kind: 'current' });
    } catch (error) {
      const problem = apiProblem(error);
      if (!ambiguous && problem && problem.status < 500 && problem.status !== 429) {
        pending = undefined;
        savePending();
        return await read({ kind: 'current' });
      }
      ambiguous = true;
      if (active()) publish({ status: 'unknown', collecting: false });
      return false;
    } finally {
      sending = false;
    }
  }
  const session: RecordingPolicySession = {
    getState: () => state,
    useIdSource(source) {
      newId = source;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh: () => read({ kind: 'current' }),
    invalidate() {
      if (active()) {
        ++serial;
        publish({ status: 'unknown', collecting: false });
      }
    },
    setForeground(value) {
      if (!active()) return Promise.resolve(false);
      foreground = value;
      ++serial;
      publish({ status: 'unknown', collecting: false });
      return value ? read({ kind: 'current' }) : Promise.resolve(false);
    },
    checkOriginal: () =>
      pending && !sending ? read({ kind: 'command', commandId: pending.commandId }) : Promise.resolve(false),
    async set(on) {
      if (!active() || unresolvedStorage || pending || sending || state.status !== 'current' || !state.policy)
        return false;
      ambiguous = false;
      pending = Object.freeze({
        version: 'recording-policy.v1',
        commandId: newId(),
        expectedPrivacyEpoch: scope.account.privacyEpoch,
        expectedRecordingGeneration: state.policy.generation,
        on,
      });
      return send();
    },
    retryOriginal: send,
    async generation() {
      if (!active() || unresolvedStorage || pending || sending) throw new Error('recording_policy_unavailable');
      if (state.status !== 'current') {
        generationRead ??= read({ kind: 'current' }).finally(() => {
          generationRead = undefined;
        });
        if (!(await generationRead)) throw new Error('recording_policy_unavailable');
      }
      if (!active() || pending || state.status !== 'current' || !state.policy)
        throw new Error('recording_policy_unavailable');
      return state.policy.generation;
    },
    end() {
      if (!live) return;
      pending = undefined;
      savePending();
      live = false;
      ++serial;
      state = { status: 'ended', retryOriginal: false, collecting: false };
      for (const listener of [...listeners]) listener();
      listeners.clear();
    },
  };
  scope.onEnd?.(session.end);
  return session;
}

/** New producers require current authority. Never repair an old body or default an unknown generation. */
export async function recordingCommandFields(scope: {
  readonly recording?: RecordingPolicySession;
}): Promise<{ recordingGeneration: number }> {
  if (!scope.recording) throw new Error('recording_policy_unavailable');
  return { recordingGeneration: await scope.recording.generation() };
}

/** Own a deep immutable copy before a logical command can be sent, including optional absence. */
export function freezeRecordingCommand<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  const copy = Array.isArray(value)
    ? value.map((child: unknown) => freezeRecordingCommand(child))
    : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freezeRecordingCommand(child)]));
  return Object.freeze(copy) as T;
}
