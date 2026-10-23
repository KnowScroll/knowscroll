import { ORPCError } from '@orpc/client';
import { QueryObserver } from '@tanstack/react-query';
import {
  KeepAssetRefSchema,
  KeepEntrySnapshotSchema,
  KeepPlaceAcceptanceSchema,
  KeepPositionSchema,
  SetKeepPlaceSchema,
  type KeepAssetRef,
  type KeepEntryRef,
  type KeepEntrySnapshot,
  type KeepPosition,
  type SetKeepPlace,
} from '@knowscroll/contracts';
import { apiKeepPlaceProblem } from './api-client';
import { ScopeEndedError, type AccountScope } from './account-scope';

export const KEEP_PLACE_LIMITS = { entries: 100, concurrentReads: 4 } as const;
export interface KeepPlaceState {
  readonly status: 'loading' | 'ready' | 'unavailable' | 'ended';
  /** The last authoritative read, never synthesized from a write acceptance. */
  readonly snapshot?: KeepEntrySnapshot;
  readonly write: 'idle' | 'sending' | 'unknown' | 'refreshing' | 'conflict';
  readonly reason?: 'network' | 'invalid' | 'entry_unavailable' | 'authority';
  readonly currentPlaceRevision?: number;
}
export interface KeepPlaceHandle {
  getState(): KeepPlaceState;
  subscribe(listener: () => void): () => void;
  refresh(): void;
  setPosition(position: KeepPosition): boolean;
  /** Retries an indeterminate acknowledgement with the identical command ID and body. */
  retry(): boolean;
  /** Conflict resolution is explicit. A candidate is never rebased automatically. */
  resolveConflict(choice: 'server' | 'candidate'): boolean;
  release(): void;
}
export interface KeepPlaceSession {
  /** Retain only visible/selected details. Refuses a new entry when the finite budget is full. */
  retain(target: KeepAssetRef): KeepPlaceHandle | undefined;
}
type Available = Extract<KeepEntrySnapshot, { status: 'available' }>;
type Candidate = { position: KeepPosition; entry: KeepEntryRef; base: number };
type Flight = { body: SetKeepPlace; controller: AbortController; dispatch: number; state: 'sending' | 'unknown' };
type Entry = {
  target: KeepAssetRef;
  refs: number;
  generation: number;
  listeners: Set<() => void>;
  state: KeepPlaceState;
  queued: boolean;
  reading: boolean;
  again: boolean;
  readToken: number;
  controller?: AbortController;
  candidate?: Candidate;
  flight?: Flight;
  accepted?: number;
  conflict?: number;
};
const sessions = new WeakMap<AccountScope, KeepPlaceSession>();
let sequence = 0;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sameEntry = (a: KeepEntryRef, b: KeepEntryRef) =>
  a.assetId === b.assetId && a.assetRevision === b.assetRevision && a.savedEntryId === b.savedEntryId;
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const endedState: KeepPlaceState = Object.freeze({ status: 'ended', write: 'idle' });

/** One ephemeral controller per actual AccountScope object; identical textual scope IDs do not share state. */
export function createKeepPlaceSession(options: { scope: AccountScope; newCommandId: () => string }): KeepPlaceSession {
  const { scope, newCommandId } = options;
  if (!scope.active || typeof scope.onEnd !== 'function') throw new ScopeEndedError();
  const existing = sessions.get(scope);
  if (existing) return existing;
  const epoch = scope.account.privacyEpoch;
  const accountId = scope.account.accountId;
  const entries = new Map<string, Entry>();
  const queue: Entry[] = [];
  const prefix = scope.queryKey('keep-place', ++sequence);
  let ended = false;
  let reads = 0;
  let observer: QueryObserver<number> | undefined;
  let unsubscribeObserver: (() => void) | undefined;
  const live = () =>
    !ended && scope.active && scope.account.privacyEpoch === epoch && scope.account.accountId === accountId;
  const emit = (entry: Entry) => {
    for (const listener of [...entry.listeners]) {
      try {
        listener();
      } catch {
        /* One consumer cannot interrupt scope purging. */
      }
    }
  };
  const available = (entry: Entry): Available | undefined =>
    entry.state.snapshot?.status === 'available' ? entry.state.snapshot : undefined;
  const publish = (entry: Entry, state: KeepPlaceState) => {
    entry.state = freeze(state);
    emit(entry);
  };
  function end(): void {
    if (ended) return;
    ended = true;
    unsubscribeObserver?.();
    observer?.destroy();
    observer = undefined;
    unsubscribeObserver = undefined;
    for (const entry of entries.values()) {
      entry.generation++;
      entry.readToken++;
      entry.controller?.abort();
      entry.flight?.controller.abort();
      entry.candidate = undefined;
      entry.flight = undefined;
      entry.accepted = undefined;
      entry.conflict = undefined;
      entry.state = endedState;
      emit(entry);
      entry.listeners.clear();
    }
    entries.clear();
    queue.length = 0;
    scope.queryClient.removeQueries({ queryKey: prefix });
  }
  scope.onEnd(end);
  function checkScope(value: { accountId: string; privacyEpoch: number }): boolean {
    if (value.accountId !== accountId || value.privacyEpoch !== epoch) {
      end();
      return false;
    }
    return true;
  }
  function enqueue(entry: Entry): void {
    if (!live() || entry.refs === 0) return;
    if (entry.reading) {
      entry.again = true;
      return;
    }
    if (!entry.queued) {
      entry.queued = true;
      queue.push(entry);
    }
    pump();
  }
  function pump(): void {
    while (live() && reads < KEEP_PLACE_LIMITS.concurrentReads && queue.length) {
      const entry = queue.shift();
      if (!entry) break;
      entry.queued = false;
      if (!entry.refs || entry.reading) continue;
      reads++;
      entry.reading = true;
      entry.again = false;
      const token = ++entry.readToken;
      const generation = entry.generation;
      const controller = new AbortController();
      entry.controller = controller;
      void read(entry, generation, token, controller).finally(() => {
        reads--;
        entry.reading = false;
        if (entry.controller === controller) entry.controller = undefined;
        if (entry.again && live() && entry.refs) enqueue(entry);
        pump();
      });
    }
  }
  function forgetMembership(entry: Entry): void {
    entry.flight?.controller.abort();
    entry.flight = undefined;
    entry.candidate = undefined;
    entry.accepted = undefined;
    entry.conflict = undefined;
    entry.generation++;
  }
  async function read(entry: Entry, generation: number, token: number, controller: AbortController): Promise<void> {
    try {
      const value = await scope.api.keep.read(
        { version: 'keep-place.v1', target: entry.target },
        { signal: controller.signal },
      );
      if (!live() || !entry.refs || entry.generation !== generation || entry.readToken !== token) return;
      const parsed = KeepEntrySnapshotSchema.safeParse(value);
      if (!parsed.success) {
        publish(entry, { ...entry.state, status: 'unavailable', reason: 'invalid' });
        return;
      }
      const snapshot = freeze(parsed.data);
      if (!checkScope(snapshot.scope)) return;
      if (!same(snapshot.target, entry.target)) {
        publish(entry, { ...entry.state, status: 'unavailable', reason: 'invalid' });
        return;
      }
      const prior = available(entry);
      const membership = snapshot.status === 'available' ? snapshot : undefined;
      // Membership identity precedes every revision comparison, including ABA resaves.
      const priorEntry = prior?.entry ?? entry.flight?.body.entry ?? entry.candidate?.entry;
      if (priorEntry && (!membership || !sameEntry(priorEntry, membership.entry))) forgetMembership(entry);
      if (prior && membership && sameEntry(prior.entry, membership.entry)) {
        if (
          membership.place.placeRevision < prior.place.placeRevision ||
          (membership.place.placeRevision === prior.place.placeRevision && !same(membership.place, prior.place))
        ) {
          publish(entry, { ...entry.state, status: 'unavailable', reason: 'invalid' });
          return;
        }
      }
      if (entry.accepted !== undefined && membership) {
        if (membership.place.placeRevision < entry.accepted) {
          publish(entry, { ...entry.state, status: 'unavailable', reason: 'invalid' });
          return;
        }
        if (entry.candidate && membership.place.placeRevision > entry.accepted)
          entry.conflict = membership.place.placeRevision;
        else if (entry.candidate) entry.candidate.base = membership.place.placeRevision;
        entry.accepted = undefined;
      } else if (
        entry.candidate &&
        membership &&
        membership.place.placeRevision !== entry.candidate.base &&
        !entry.flight
      ) {
        entry.conflict = membership.place.placeRevision;
      }
      publish(entry, {
        status: 'ready',
        snapshot,
        write: entry.conflict !== undefined ? 'conflict' : (entry.flight?.state ?? 'idle'),
        ...(entry.conflict !== undefined ? { currentPlaceRevision: entry.conflict } : {}),
      });
      drain(entry);
    } catch (error) {
      if (!live() || !entry.refs || entry.generation !== generation || entry.readToken !== token) return;
      const problem = apiKeepPlaceProblem(error);
      if (error instanceof ORPCError && (error.status === 401 || error.status === 403)) {
        end();
        return;
      }
      if (
        problem &&
        ['UNAUTHENTICATED', 'FORBIDDEN', 'PRIVACY_EPOCH_CHANGED', 'SCOPE_MISMATCH', 'UNIVERSE_UNAVAILABLE'].includes(
          problem.code,
        )
      ) {
        end();
        return;
      }
      if (problem?.code === 'KEEP_ENTRY_UNAVAILABLE') {
        forgetMembership(entry);
        publish(entry, { status: 'unavailable', write: 'idle', reason: 'entry_unavailable' });
        return;
      }
      publish(entry, { ...entry.state, status: 'unavailable', reason: problem ? 'invalid' : 'network' });
    }
  }
  function drain(entry: Entry): void {
    const snapshot = available(entry);
    if (
      !live() ||
      !entry.refs ||
      !snapshot ||
      entry.state.status !== 'ready' ||
      entry.flight ||
      !entry.candidate ||
      entry.conflict !== undefined ||
      entry.accepted !== undefined
    )
      return;
    const candidate = entry.candidate;
    if (!sameEntry(candidate.entry, snapshot.entry)) {
      entry.candidate = undefined;
      return;
    }
    if (candidate.base !== snapshot.place.placeRevision) {
      entry.conflict = snapshot.place.placeRevision;
      publish(entry, { ...entry.state, write: 'conflict', currentPlaceRevision: entry.conflict });
      return;
    }
    let body: SetKeepPlace;
    try {
      body = freeze(
        SetKeepPlaceSchema.parse({
          version: 'keep-place.v1',
          commandId: newCommandId(),
          entry: snapshot.entry,
          expectedPlaceRevision: snapshot.place.placeRevision,
          position: candidate.position,
        }),
      );
    } catch {
      publish(entry, { ...entry.state, reason: 'invalid' });
      return;
    }
    entry.candidate = undefined;
    const flight: Flight = { body, controller: new AbortController(), dispatch: 0, state: 'sending' };
    entry.flight = flight;
    void send(entry, flight);
  }
  async function send(entry: Entry, flight: Flight): Promise<void> {
    const generation = entry.generation;
    const dispatch = ++flight.dispatch;
    flight.state = 'sending';
    publish(entry, { ...entry.state, write: 'sending' });
    try {
      const value = await scope.api.keep.setPlace(flight.body, { signal: flight.controller.signal });
      if (
        !live() ||
        !entry.refs ||
        entry.flight !== flight ||
        entry.generation !== generation ||
        flight.dispatch !== dispatch
      )
        return;
      const result = KeepPlaceAcceptanceSchema.safeParse(value);
      if (!result.success) throw new Error('invalid_acceptance');
      const acceptance = result.data;
      if (!checkScope(acceptance.scope)) return;
      if (
        !sameEntry(acceptance.entry, flight.body.entry) ||
        acceptance.commandId !== flight.body.commandId ||
        acceptance.basePlaceRevision !== flight.body.expectedPlaceRevision
      )
        throw new Error('invalid_acceptance');
      entry.flight = undefined;
      entry.accepted = acceptance.acceptedPlaceRevision;
      // Invalidate an older read even if its transport ignores abort. ACK carries no current position.
      entry.readToken++;
      entry.controller?.abort();
      publish(entry, { ...entry.state, write: 'refreshing' });
      enqueue(entry);
    } catch (error) {
      if (
        !live() ||
        !entry.refs ||
        entry.flight !== flight ||
        entry.generation !== generation ||
        flight.dispatch !== dispatch
      )
        return;
      const problem = apiKeepPlaceProblem(error);
      if (error instanceof ORPCError && (error.status === 401 || error.status === 403)) {
        end();
        return;
      }
      if (
        problem &&
        ['UNAUTHENTICATED', 'FORBIDDEN', 'PRIVACY_EPOCH_CHANGED', 'SCOPE_MISMATCH', 'UNIVERSE_UNAVAILABLE'].includes(
          problem.code,
        )
      ) {
        end();
        return;
      }
      if (problem?.code === 'KEEP_PLACE_REVISION_STALE') {
        entry.flight = undefined;
        entry.candidate ??= {
          position: flight.body.position,
          entry: flight.body.entry,
          base: flight.body.expectedPlaceRevision,
        };
        entry.conflict = problem.currentPlaceRevision;
        publish(entry, { ...entry.state, write: 'conflict', currentPlaceRevision: entry.conflict });
        enqueue(entry);
        return;
      }
      if (problem && problem.status < 500) {
        forgetMembership(entry);
        publish(entry, { status: 'unavailable', write: 'idle', reason: 'entry_unavailable' });
        enqueue(entry);
        return;
      }
      // Lost/malformed ACK and server/transport failures cannot prove that the command did not commit.
      flight.state = 'unknown';
      publish(entry, { ...entry.state, write: 'unknown', reason: problem ? 'invalid' : 'network' });
    }
  }
  function observe(): void {
    if (observer || !live()) return;
    let initialized = false;
    observer = new QueryObserver<number>(scope.queryClient, {
      queryKey: prefix,
      queryFn: () => {
        if (initialized) for (const entry of entries.values()) if (entry.refs) enqueue(entry);
        initialized = true;
        return 1;
      },
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      staleTime: 0,
      gcTime: 0,
    });
    unsubscribeObserver = observer.subscribe(() => {});
  }
  const session: KeepPlaceSession = {
    retain(target) {
      if (!live()) return undefined;
      const parsed = KeepAssetRefSchema.safeParse(target);
      if (!parsed.success) return undefined;
      const key = `${parsed.data.assetId.toLowerCase()}:${parsed.data.assetRevision}`;
      let entry = entries.get(key);
      if (!entry) {
        if (entries.size >= KEEP_PLACE_LIMITS.entries) return undefined;
        entry = {
          target: freeze(parsed.data),
          refs: 0,
          generation: 0,
          listeners: new Set(),
          state: { status: 'loading', write: 'idle' },
          queued: false,
          reading: false,
          again: false,
          readToken: 0,
        };
        entries.set(key, entry);
      }
      const current = entry;
      current.refs++;
      let released = false;
      const listeners = new Set<() => void>();
      const usable = () => !released && live() && current.refs > 0;
      observe();
      enqueue(current);
      return {
        getState: () => (released || !live() ? endedState : current.state),
        subscribe(listener) {
          if (!usable()) return () => {};
          // Each subscription owns its token, including identical callbacks on other handles.
          const subscription = () => listener();
          listeners.add(subscription);
          current.listeners.add(subscription);
          return () => {
            listeners.delete(subscription);
            current.listeners.delete(subscription);
          };
        },
        refresh: () => {
          if (usable()) enqueue(current);
        },
        setPosition(position) {
          const parsedPosition = KeepPositionSchema.safeParse(position);
          const snapshot = available(current);
          if (!usable() || !snapshot || !parsedPosition.success || current.state.status !== 'ready') return false;
          current.candidate = {
            position: freeze(parsedPosition.data),
            entry: snapshot.entry,
            base: snapshot.place.placeRevision,
          };
          drain(current);
          return true;
        },
        retry() {
          const flight = current.flight;
          const snapshot = available(current);
          if (
            !usable() ||
            !flight ||
            flight.state !== 'unknown' ||
            !snapshot ||
            current.state.status !== 'ready' ||
            !sameEntry(snapshot.entry, flight.body.entry)
          )
            return false;
          flight.controller = new AbortController();

          void send(current, flight);
          return true;
        },
        resolveConflict(choice) {
          if (!usable() || current.conflict === undefined || current.flight || current.state.status !== 'ready')
            return false;
          const snapshot = available(current);
          if (!snapshot || snapshot.place.placeRevision !== current.conflict) return false;
          if (choice === 'candidate' && current.candidate && sameEntry(current.candidate.entry, snapshot.entry)) {
            current.candidate.base = snapshot.place.placeRevision;
          } else if (choice === 'server') current.candidate = undefined;
          else return false;
          current.conflict = undefined;
          publish(current, { status: 'ready', snapshot, write: 'idle' });
          drain(current);
          return true;
        },
        release() {
          if (released) return;
          released = true;
          for (const listener of listeners) current.listeners.delete(listener);
          listeners.clear();
          if (--current.refs > 0) return;
          current.generation++;
          current.readToken++;
          current.controller?.abort();
          current.candidate = undefined;
          const queuedAt = queue.indexOf(current);
          if (queuedAt >= 0) queue.splice(queuedAt, 1);
          current.queued = false;
          current.accepted = undefined;
          current.conflict = undefined;
          current.state = { status: 'loading', write: 'idle' };
          if (current.flight) {
            current.flight.controller.abort();
            current.flight.dispatch++;
            current.flight.state = 'unknown';
          } else entries.delete(key);
          if (![...entries.values()].some((v) => v.refs)) {
            unsubscribeObserver?.();
            observer?.destroy();
            observer = undefined;
            unsubscribeObserver = undefined;
            scope.queryClient.removeQueries({ queryKey: prefix });
          }
        },
      };
    },
  };
  sessions.set(scope, session);
  return session;
}
