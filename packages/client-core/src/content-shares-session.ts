import type { AccountScope } from './account-scope';
import { createContentSharesHttp } from './content-shares-http';
import { sameContent, socialFailure } from './conversations-http';
import { freezeSocial, sameConversation, sameSocialId, socialData, socialOwnerFor, type ContentSharesSession, type ContentSharesState, type ShareInput, type ShareOutput } from './conversations-types';
type Pending = { operation: 'create'; input: ShareInput<'create'>; ambiguous: boolean } | { operation: 'revoke'; input: ShareInput<'revoke'>; ambiguous: boolean };
type Read = { operation: 'own'; input?: ShareInput<'own'>; done: () => void } | { operation: 'resolve'; input?: ShareInput<'resolve'>; done: () => void };
const empty = (): ContentSharesState => ({ status: 'active', own: { status: 'idle' }, resolved: { status: 'idle' }, command: { status: 'idle' }, tokenAvailable: false, mutationBlocked: false });
/** Private scoped JSON reads and once-only delivery. No link builder, persistence or public fallback. */
export function createContentSharesSession(options: { scope: AccountScope; newCommandId: () => string }): ContentSharesSession {
  const { scope } = options, owner = socialOwnerFor(scope), http = createContentSharesHttp(scope), slot = {}, budget = {}, pendingBudget = {};
  let state = freezeSocial(empty()), ended = false, serial = 0, commandSerial = 0, publication = 0, reading = false;
  let pending: Pending | undefined, token: string | undefined, currentRead: Read | undefined, queued: Read | undefined;
  let controller: AbortController | undefined, commandController: AbortController | undefined;
  const listeners = new Set<() => void>();
  const live = () => !ended && owner.live();
  function publish(patch: Partial<ContentSharesState> = {}) {
    state = freezeSocial({ ...state, ...patch, tokenAvailable: !!token, mutationBlocked: owner.busy() });
    const mine = ++publication;
    for (const listener of [...listeners]) { if (mine !== publication) break; try { if (listeners.has(listener)) listener(); } catch { /* Consumer cannot block purge. */ } }
  }
  function cancelReads() { serial++; controller?.abort(); controller = undefined; if (currentRead) currentRead.input = undefined; if (queued) { queued.input = undefined; queued.done(); } queued = undefined; }
  function purge() { if (ended) return; ended = true; cancelReads(); commandSerial++; commandController?.abort(); commandController = undefined; pending = undefined; token = undefined; owner.drop(budget); owner.drop(pendingBudget); state = freezeSocial({ ...empty(), status: 'ended' }); }
  owner.onEnd(purge, () => { publish(); listeners.clear(); });
  owner.subscribe(() => { if (live()) publish(); });
  function fail(reason: ContentSharesState['failure']) { if (live()) publish({ failure: reason }); }
  async function dispatch(job: Read, mine: number) {
    if (reading) { if (queued) { queued.input = undefined; queued.done(); } queued = job; return; }
    reading = true; currentRead = job;
    const abort = new AbortController(); controller = abort;
    const current = () => live() && serial === mine && !abort.signal.aborted;
    try {
      if (!current() || !job.input) return;
      const b = await http.call(job.operation, job.input, abort.signal);
      if (!current() || !job.input) return;
      if (job.operation === 'own') {
        const own = b as ShareOutput<'own'>;
        if (own.status === 'available' && pending?.operation === 'create' && job.input && 'selector' in job.input && job.input.selector.kind === 'command' && sameSocialId(job.input.selector.commandId, pending.input.commandId)) {
          const p = pending;
          if (!sameContent(p.input.target, own.target) || p.input.audience.kind !== own.audience.kind || (p.input.audience.kind === 'conversation' && (own.audience.kind !== 'conversation' || !sameConversation(p.input.audience.conversation, own.audience.conversation)))) throw new Error();
          pending = undefined; owner.drop(pendingBudget); state = { ...state, command: { status: 'accepted', operation: 'create', commandId: p.input.commandId } }; owner.release(slot); if (!current()) return;
        }
        if (!owner.retain(budget, { own, resolved: state.resolved })) { fail('capacity'); return; }
        publish({ own: { status: 'ready', data: own }, failure: undefined });
      } else {
        const resolved = b as ShareOutput<'resolve'>;
        if (!owner.retain(budget, { own: state.own, resolved })) { fail('capacity'); return; }
        if (resolved.status === 'conversation') owner.remember(resolved.conversation);
        publish({ resolved: { status: 'ready', data: resolved }, failure: undefined });
      }
    } catch (e) {
      if (current()) {
        const reason = socialFailure(e).reason;
        if (reason === 'authority') { token = undefined; owner.drop(budget); publish({ own: { status: 'unavailable', reason }, resolved: { status: 'unavailable', reason }, failure: reason }); }
        else publish({ [job.operation === 'own' ? 'own' : 'resolved']: { status: 'unavailable', reason }, failure: reason });
      }
    } finally { job.input = undefined; currentRead = undefined; reading = false; job.done(); const next = queued; queued = undefined; if (next && live()) void dispatch(next, serial); }
  }
  function read<K extends 'own' | 'resolve'>(operation: K, input: ShareInput<K>): Promise<void> {
    if (!live()) return Promise.resolve();
    let prepared: ShareInput<K>; try { prepared = http.prepare(operation, input); } catch { fail('invalid'); return Promise.resolve(); }
    const mine = ++serial; controller?.abort(); if (!live() || mine !== serial) return Promise.resolve();
    publish({ [operation === 'own' ? 'own' : 'resolved']: { status: 'loading' } });
    if (!live() || mine !== serial) return Promise.resolve();
    return new Promise((done) => { void dispatch({ operation, input: prepared, done } as Read, mine); });
  }
  async function send(retry: boolean) {
    const p = pending; if (!live() || !p || state.command.status === 'pending') return;
    if (retry && p.operation === 'revoke' && (state.own.status !== 'ready' || state.own.data.status !== 'available' || !sameSocialId(state.own.data.shareId, p.input.shareId))) { fail('refresh_required'); return; }
    if (retry && p.operation === 'create' && p.input.audience.kind === 'conversation' && !owner.knows(p.input.audience.conversation)) { fail('refresh_required'); return; }
    const mine = ++commandSerial, abort = new AbortController(); commandController = abort;
    publish({ command: { status: 'pending', operation: p.operation, commandId: p.input.commandId } });
    if (!live() || mine !== commandSerial) return;
    try {
      const b = await http.call(p.operation, p.input, abort.signal);
      if (!live() || mine !== commandSerial || abort.signal.aborted || pending !== p) return;
      if (p.operation === 'create') { const result = b as ShareOutput<'create'>; token = result.delivery.status === 'available' ? result.delivery.token : undefined; }
      else token = undefined;
      pending = undefined; owner.drop(pendingBudget); owner.drop(budget);
      state = { ...state, own: { status: 'idle' }, resolved: { status: 'idle' }, command: { status: 'accepted', operation: p.operation, commandId: p.input.commandId } }; owner.release(slot); if (live() && mine === commandSerial) publish();
    } catch (e) {
      if (!live() || mine !== commandSerial || pending !== p) return;
      const error = socialFailure(e); p.ambiguous ||= error.ambiguous;
      if (error.reason === 'authority') { token = undefined; owner.drop(budget); state = { ...state, own: { status: 'unavailable', reason: 'authority' }, resolved: { status: 'unavailable', reason: 'authority' } }; }
      if (p.ambiguous) publish({ command: { status: 'unknown', operation: p.operation, commandId: p.input.commandId }, failure: error.reason });
      else { pending = undefined; owner.drop(pendingBudget); state = { ...state, command: { status: 'rejected', reason: error.reason } }; owner.release(slot); if (live()) publish(); }
    }
  }
  async function command(p: Pending) {
    if (!live() || owner.busy()) { fail('busy'); return; }
    if (!owner.retain(pendingBudget, p.input)) { fail('capacity'); return; }
    if (!owner.claim(slot)) { owner.drop(pendingBudget); return; }
    pending = p; cancelReads(); state = { ...state, command: { status: 'idle' } }; await send(false);
  }
  return {
    getState: () => owner.live() ? state : freezeSocial({ ...empty(), status: 'ended' }),
    subscribe(listener) { if (!live()) return () => undefined; listeners.add(listener); return () => listeners.delete(listener); },
    async create(draft) {
      if (!live() || owner.busy()) { fail('busy'); return; }
      try {
        if (!socialData(draft)) { fail('invalid'); return; }
        const input = http.prepare('create', { version: 'content-share.v1', commandId: options.newCommandId(), ...draft });
        if (input.audience.kind === 'conversation' && !owner.knows(input.audience.conversation)) { fail('refresh_required'); return; }
        // Never evict an unconsumed first token to create another share.
        if (token) { fail('busy'); return; }
        await command({ operation: 'create', input, ambiguous: false });
      } catch { fail('invalid'); }
    },
    async readOwn(selector) { try { await read('own', { version: 'content-share.v1', readId: options.newCommandId(), selector }); } catch { fail('invalid'); } },
    async resolve(value) { try { await read('resolve', { version: 'content-share.v1', readId: options.newCommandId(), token: value }); } catch { fail('invalid'); } },
    async revoke(shareId) {
      if (!live() || owner.busy()) { fail('busy'); return; }
      const own = state.own.status === 'ready' ? state.own.data : undefined;
      if (own?.status !== 'available' || !sameSocialId(own.shareId, shareId) || own.state !== 'active') { fail('refresh_required'); return; }
      try { await command({ operation: 'revoke', input: http.prepare('revoke', { version: 'content-share.v1', commandId: options.newCommandId(), shareId }), ambiguous: false }); } catch { fail('invalid'); }
    },
    async retryCommand() { if (pending && state.command.status === 'unknown') await send(true); },
    takeToken() { if (!live()) return undefined; const result = token; token = undefined; publish(); return live() ? result : undefined; },
    dispose: () => owner.end(),
  };
}
