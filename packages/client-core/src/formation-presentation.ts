import {
  FORMATION_PRESENTATION_POLICY as POLICY,
  FormationPresentationReadSchema,
  FormationPresentationClaimAcceptanceSchema,
  FormationPresentationAcknowledgementSchema,
  ReadFormationPresentationSchema,
  ClaimFormationPresentationSchema,
  AcknowledgeFormationPresentationSchema,
  type FormationPresentationFact,
  type SceneClientCapabilities,
  type ClaimFormationPresentation,
  type AcknowledgeFormationPresentation,
} from '@knowscroll/contracts';
import { apiProblem } from './api-client';
import type { AccountScope } from './account-scope';
import type { UniverseSceneState } from './universe-scene';

export interface FormationPresentationState {
  readonly status:
    | 'idle'
    | 'reading'
    | 'claiming'
    | 'claim_unknown'
    | 'waiting'
    | 'ready'
    | 'presenting'
    | 'acknowledging'
    | 'ack_unknown'
    | 'final'
    | 'unavailable'
    | 'ended';
  readonly fact?: FormationPresentationFact;
  readonly reducedMotion?: boolean;
  readonly completed?: boolean;
  readonly reason?: 'network' | 'authority' | 'invalid' | 'unavailable';
}
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function frozen<T>(v: T): T {
  if (v !== null && typeof v === 'object') {
    Object.values(v).forEach(frozen);
    Object.freeze(v);
  }
  return v;
}
/** One ephemeral current attempt per actual scope. The server owns durable cross-device uniqueness. */
export function createFormationPresentationSession(options: {
  scope: AccountScope;
  newId: () => string;
  projection: () => UniverseSceneState;
  capabilities: () => SceneClientCapabilities;
  now?: () => number;
  monotonic?: () => number;
}) {
  const { scope } = options;
  const now = options.now ?? Date.now;
  const mono = options.monotonic ?? (() => performance.now());
  let ended = !scope.active || !scope.onEnd,
    foreground = false;
  let generation = 0,
    reading = false,
    sending = false;
  let abort: AbortController | undefined, expiry: ReturnType<typeof setTimeout> | undefined;
  let state: FormationPresentationState = { status: ended ? 'ended' : 'idle' };
  let lastReadKey: string | undefined,
    watermark = 0;
  const listeners = new Set<() => void>();
  // This small duplicate fence supplements (and never replaces) the durable server claim.
  const started = new Set<string>();
  let attempt:
    | {
        fact: FormationPresentationFact;
        capabilities: SceneClientCapabilities;
        input: ClaimFormationPresentation;
        claim?: { claimId: string; claimedAt: string; expiresAt: string };
        ack?: AcknowledgeFormationPresentation;
        interrupted: boolean;
        startedAt?: number;
        deadline: number;
        readAt: number;
        completed: boolean;
        display: boolean;
        reduced: boolean;
        certificate: {
          geography: NonNullable<UniverseSceneState['geography']>;
          snapshot: NonNullable<UniverseSceneState['snapshot']>;
        };
      }
    | undefined;
  const live = () => !ended && scope.active;
  const publish = (s: FormationPresentationState) => {
    state = frozen(s);
    for (const fn of [...listeners]) fn();
  };
  const show = (status: FormationPresentationState['status'], reason?: FormationPresentationState['reason']) =>
    publish({
      status,
      ...(attempt?.display ? { fact: attempt.fact, reducedMotion: attempt.reduced, completed: attempt.completed } : {}),
      ...(reason ? { reason } : {}),
    });
  const clearExpiry = () => {
    clearTimeout(expiry);
    expiry = undefined;
  };
  const reason = (error: unknown): FormationPresentationState['reason'] => {
    const p = apiProblem(error);
    return p &&
      ['UNAUTHENTICATED', 'FORBIDDEN', 'SCOPE_MISMATCH', 'PRIVACY_EPOCH_CHANGED', 'UNIVERSE_UNAVAILABLE'].includes(
        p.code,
      )
      ? 'authority'
      : p
        ? 'unavailable'
        : error instanceof TypeError
          ? 'network'
          : 'invalid';
  };
  const currentProjection = (fact?: FormationPresentationFact) => {
    const p = options.projection(),
      c = options.capabilities();
    if (
      !live() ||
      !p.active ||
      p.status !== 'ready' ||
      !p.geography ||
      !p.snapshot ||
      p.snapshot.read.status !== 'ready'
    )
      return;
    if (
      p.geography.universeId !== scope.account.universeId ||
      p.geography.privacyEpoch !== scope.account.privacyEpoch ||
      p.snapshot.read.scope.universeId !== scope.account.universeId ||
      p.snapshot.read.scope.privacyEpoch !== scope.account.privacyEpoch ||
      !equal(p.snapshot.read.capabilities, c)
    )
      return;
    const m = p.snapshot.read.manifest.revisions,
      g = p.geography;
    if (
      m.geographyRevision !== g.geography.revision ||
      m.structureRevision !== g.geography.structureRevision ||
      m.activityRevision !== g.geography.activityRevision
    )
      return;
    if (
      fact &&
      fact.targets.some((t) => {
        const o = g.objects.find((o) => o.id === t.objectId),
          d = p.snapshot!.chunks.flatMap((c) => c.objects).find((d) => d.objectId === t.objectId);
        return (
          !o ||
          !d ||
          o.objectRevision !== t.objectRevision ||
          o.originTransitionId !== fact.transitionId ||
          o.kind !== t.kind ||
          o.parent.id !== t.parentId ||
          o.label !== t.label ||
          o.truthStatus !== t.truthStatus ||
          d.kind !== t.kind ||
          d.parentId !== t.parentId ||
          d.label !== t.label ||
          d.truthStatus !== t.truthStatus ||
          d.originTransitionId !== fact.transitionId
        );
      })
    )
      return;
    return { p, c, m, g };
  };
  const readyCertificate = (a: NonNullable<typeof attempt>) => {
    const current = currentProjection(a.fact);
    if (!current) return false;
    a.certificate = { geography: current.g, snapshot: current.p.snapshot! };
    return true;
  };
  const retainedLoadingCertificate = (a: NonNullable<typeof attempt>) => {
    const p = options.projection();
    // SceneCore publishes this same frozen pair while its disposable root hint is being
    // refreshed. It is not a newly admitted projection or a restart permission. New ready
    // data must pass all target checks; pending/failed/foreign reads never use this path.
    return (
      live() &&
      p.active &&
      p.status === 'loading' &&
      !p.pendingProjection &&
      p.geography === a.certificate.geography &&
      p.snapshot === a.certificate.snapshot &&
      equal(options.capabilities(), a.capabilities)
    );
  };
  const boundIdentity = (s: { universeId: string; privacyEpoch: number }) => {
    if (s.universeId !== scope.account.universeId || s.privacyEpoch !== scope.account.privacyEpoch)
      throw new Error('formation_scope');
  };
  const boundScope = (s: { universeId: string; privacyEpoch: number; personalWatermark: number }) => {
    boundIdentity(s);
    // A root hint can finish a newer scene read while a command is in flight. Its current
    // envelope must not regress behind either already-admitted scene read or this consumer.
    const p = options.projection(),
      g = p.geography,
      scene = p.snapshot?.read.scope;
    const known = Math.max(
      watermark,
      g?.universeId === scope.account.universeId && g.privacyEpoch === scope.account.privacyEpoch
        ? g.personalWatermark
        : 0,
      scene?.universeId === scope.account.universeId && scene.privacyEpoch === scope.account.privacyEpoch
        ? scene.personalWatermark
        : 0,
    );
    if (s.personalWatermark < known) throw new Error('formation_scope');
    watermark = s.personalWatermark;
  };
  const stopRead = () => {
    generation++;
    abort?.abort();
    abort = undefined;
  };
  const armExpiry = () => {
    clearExpiry();
    const a = attempt;
    if (!a?.claim || a.ack || !live()) return;
    expiry = setTimeout(
      () => {
        if (live() && attempt === a && !a.ack) interrupt();
      },
      Math.max(0, a.deadline - mono()),
    );
  };
  const acknowledge = async () => {
    const a = attempt;
    if (!live() || sending || !a?.ack) return;
    sending = true;
    show('acknowledging');
    try {
      const raw = await scope.api.formation.acknowledge(a.ack);
      if (!live() || attempt !== a) return;
      const r = FormationPresentationAcknowledgementSchema.parse(raw);
      // A terminal receipt is immutable: an explicit replay can predate a newer map read.
      // Bind its current account/epoch and exact command, without granting animation authority.
      boundIdentity(r.scope);
      if (
        r.commandId !== a.ack.commandId ||
        r.transitionId !== a.ack.transitionId ||
        r.claimId !== a.ack.claimId ||
        r.attemptNonce !== a.ack.attemptNonce ||
        r.requestedDisposition !== a.ack.disposition ||
        Date.parse(r.recordedAt) < Date.parse(a.claim!.claimedAt)
      )
        throw new Error('formation_ack');
      watermark = Math.max(watermark, r.scope.personalWatermark);
      show('final');
    } catch (error) {
      if (live() && attempt === a) show('ack_unknown', reason(error));
    } finally {
      sending = false;
    }
  };
  const finish = (disposition: 'shown' | 'skipped', expected?: FormationPresentationFact) => {
    const a = attempt;
    if (!live() || !a?.claim || a.ack || (expected && a.fact !== expected)) return false;
    if (
      disposition === 'shown' &&
      (!foreground ||
        a.interrupted ||
        a.startedAt === undefined ||
        !equal(options.capabilities(), a.capabilities) ||
        !(readyCertificate(a) || retainedLoadingCertificate(a)) ||
        mono() >= a.deadline ||
        now() >= Date.parse(a.claim.expiresAt) ||
        (!a.reduced && mono() - a.startedAt < POLICY.fullDurationMs))
    )
      return false;
    a.completed = disposition === 'shown';
    if (disposition === 'skipped') a.display = false;
    clearExpiry();
    a.ack = frozen(
      AcknowledgeFormationPresentationSchema.parse({
        version: POLICY.version,
        commandId: options.newId(),
        transitionId: a.fact.transitionId,
        claimId: a.claim.claimId,
        attemptNonce: a.input.attemptNonce,
        disposition,
      }),
    );
    void acknowledge();
    return true;
  };
  function interrupt(expected?: FormationPresentationFact) {
    if (expected && attempt?.fact !== expected) return;
    stopRead();
    if (reading) lastReadKey = undefined;
    if (attempt) {
      attempt.interrupted = true;
      attempt.display = false;
      if (attempt.claim && !attempt.ack) finish('skipped');
      else show(state.status);
    } else if (state.status === 'reading') show('idle');
  }
  const claim = async () => {
    const a = attempt;
    if (!live() || sending || !a || a.claim || a.ack) return;
    sending = true;
    const sentAt = mono();
    show('claiming');
    try {
      const raw = await scope.api.formation.claim(a.input);
      if (!live() || attempt !== a) return;
      const r = FormationPresentationClaimAcceptanceSchema.parse(raw);
      boundScope(r.scope);
      if (
        r.receipt.commandId !== a.input.commandId ||
        r.receipt.transitionId !== a.input.transitionId ||
        r.receipt.attemptNonce !== a.input.attemptNonce ||
        Date.parse(r.receipt.recordedAt) < a.readAt
      )
        throw new Error('formation_claim');
      if (r.receipt.outcome !== 'claimed' || r.current.status !== 'active') {
        a.display = false;
        show('final');
        return;
      }
      a.claim = r.receipt.claim;
      a.deadline = Math.min(a.deadline, sentAt + Date.parse(r.current.expiresAt) - Date.parse(r.current.observedAt));
      a.reduced = a.capabilities.reducedMotion || a.fact.sequence.kind === 'final_still';
      if (
        foreground &&
        !a.interrupted &&
        equal(options.capabilities(), a.capabilities) &&
        mono() < a.deadline &&
        now() < Date.parse(a.claim.expiresAt)
      ) {
        if (readyCertificate(a)) {
          a.display = true;
          show('ready');
        } else if (retainedLoadingCertificate(a)) show('waiting');
        else a.interrupted = true;
        armExpiry();
      } else a.interrupted = true;
    } catch (error) {
      if (live() && attempt === a) show('claim_unknown', reason(error));
    } finally {
      sending = false;
      if (live() && attempt === a && a.claim && a.interrupted && !a.ack) finish('skipped');
    }
  };
  const read = async (force = false) => {
    const p = currentProjection();
    if (!foreground || !p || reading || sending || (attempt && state.status !== 'final')) return;
    const key = JSON.stringify([p.c, p.m, p.g.geography]);
    if (!force && key === lastReadKey) return;
    lastReadKey = key;
    stopRead();
    const ticket = generation,
      sentAt = mono();
    abort = new AbortController();
    reading = true;
    const input = ReadFormationPresentationSchema.parse({
      version: POLICY.version,
      readId: options.newId(),
      target: { kind: 'next' },
      capabilities: p.c,
    });
    show('reading');
    try {
      const raw = await scope.api.formation.read(input, { signal: abort.signal });
      if (!live() || ticket !== generation || !foreground) return;
      if (new TextEncoder().encode(JSON.stringify(raw)).length > 32768) throw new Error('formation_limit');
      const r = FormationPresentationReadSchema.parse(raw),
        current = currentProjection();
      boundScope(r.scope);
      if (
        !current ||
        r.readId !== input.readId ||
        !equal(r.target, input.target) ||
        !equal(r.capabilities, input.capabilities) ||
        !equal(r.capabilities, current.c) ||
        !equal(r.currentGeography, current.g.geography) ||
        r.sceneRevision !== current.m.sceneRevision ||
        r.scope.personalWatermark < current.g.personalWatermark
      )
        throw new Error('formation_read');
      if (r.status !== 'available') {
        show(r.status === 'none' ? 'idle' : 'unavailable', r.status === 'none' ? undefined : 'unavailable');
        return;
      }
      if (r.eligibility.status !== 'claimable' || started.has(r.fact.transitionId)) {
        show('final');
        return;
      }
      const deadline = sentAt + Date.parse(r.eligibility.until) - Date.parse(r.recordedAt);
      if (!currentProjection(r.fact) || mono() >= deadline || now() >= Date.parse(r.eligibility.until)) {
        show('final');
        return;
      }
      attempt = {
        fact: frozen(r.fact),
        capabilities: frozen(input.capabilities),
        input: frozen(
          ClaimFormationPresentationSchema.parse({
            version: POLICY.version,
            commandId: options.newId(),
            transitionId: r.fact.transitionId,
            attemptNonce: options.newId(),
          }),
        ),
        interrupted: false,
        deadline,
        readAt: Date.parse(r.recordedAt),
        completed: false,
        display: false,
        reduced: p.c.reducedMotion,
        certificate: { geography: current.g, snapshot: current.p.snapshot! },
      };
      void claim();
    } catch (error) {
      if (live() && ticket === generation) show('unavailable', reason(error));
    } finally {
      reading = false;
      if (live() && foreground && ticket !== generation) void read();
    }
  };
  const end = () => {
    if (ended) return;
    ended = true;
    foreground = false;
    stopRead();
    clearExpiry();
    attempt = undefined;
    started.clear();
    lastReadKey = undefined;
    watermark = 0;
    const notify = [...listeners];
    listeners.clear();
    state = frozen({ status: 'ended' });
    for (const fn of notify) {
      try {
        fn();
      } catch {
        /* One released surface cannot prevent another scope fence. */
      }
    }
  };
  const off = scope.onEnd?.(end);
  return {
    getState: () => state,
    subscribe(this: void, fn: () => void) {
      if (ended) return () => {};
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    setForeground(value: boolean) {
      if (!live()) return;
      foreground = value;
      if (!value) interrupt();
      else void read();
    },
    update() {
      if (!live()) return;
      const p = currentProjection();
      if (reading && (!p || JSON.stringify([p.c, p.m, p.g.geography]) !== lastReadKey)) {
        stopRead();
        lastReadKey = undefined;
      }
      const a = attempt;
      if (a?.claim && !a.ack && !a.interrupted) {
        if (
          !foreground ||
          !equal(options.capabilities(), a.capabilities) ||
          mono() >= a.deadline ||
          now() >= Date.parse(a.claim.expiresAt)
        )
          interrupt();
        else if (readyCertificate(a)) {
          if (state.status === 'waiting') {
            a.display = true;
            show('ready');
          }
        } else if (retainedLoadingCertificate(a)) {
          if (a.startedAt === undefined) {
            a.display = false;
            show('waiting');
          }
        } else interrupt();
      } else if (a?.display && !(readyCertificate(a) || retainedLoadingCertificate(a))) interrupt();
      void read();
    },
    refresh: () => read(true),
    retry() {
      if (!live() || !foreground || sending) return;
      if (state.status === 'claim_unknown') void claim();
      else if (state.status === 'ack_unknown') void acknowledge();
    },
    mounted(expected?: FormationPresentationFact) {
      const a = attempt;
      if (
        !live() ||
        !foreground ||
        state.status !== 'ready' ||
        (expected && a?.fact !== expected) ||
        !a?.claim ||
        a.startedAt !== undefined ||
        a.interrupted ||
        started.has(a.fact.transitionId) ||
        !equal(options.capabilities(), a.capabilities) ||
        !readyCertificate(a) ||
        mono() >= a.deadline ||
        now() >= Date.parse(a.claim.expiresAt)
      )
        return false;
      a.startedAt = mono();
      started.add(a.fact.transitionId);
      while (started.size > 64) started.delete(started.values().next().value!);
      show('presenting');
      return true;
    },
    complete: (expected?: FormationPresentationFact) => finish('shown', expected),
    skip: interrupt,
    unmounted(expected: FormationPresentationFact) {
      // A waiting claim has not mounted a story. Its view's foreground/route fence (or
      // expiry) owns interruption; hiding that waiting surface is not a second start.
      if (attempt?.fact === expected && attempt.startedAt !== undefined) interrupt(expected);
    },
    dismiss(expected?: FormationPresentationFact) {
      const a = attempt;
      if (!live() || !foreground || !a?.display || !a.completed || (expected && a.fact !== expected)) return;
      a.display = false;
      show(state.status);
      return a.fact;
    },
    dispose() {
      end();
      off?.();
    },
  };
}
export type FormationPresentationSession = ReturnType<typeof createFormationPresentationSession>;
