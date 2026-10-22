import {
  RegionEncounterPreviewRequestSchema,
  RegionEncounterPreviewResponseSchema,
  type ClientCapabilities,
  type RegionEncounterPreviewResponse,
  type RegionEncounterTarget,
} from '@knowscroll/contracts';
import { apiProblem } from './api-client';
import type { AccountScope } from './account-scope';

type Reply = RegionEncounterPreviewResponse;
export type AvailableRegionPreview = Extract<Reply, { status: 'available' }>;
export interface RegionPreviewState {
  readonly status: 'idle' | 'loading' | 'available' | 'unavailable' | 'ended';
  readonly preview?: AvailableRegionPreview;
  readonly reason?: Extract<Reply, { status: 'unavailable' }>['reason'] | 'network' | 'authority' | 'invalid';
}
const equal = (a: unknown, b: unknown): boolean => {
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b;
  const ak = Object.keys(a).sort(),
    bk = Object.keys(b).sort();
  return (
    ak.length === bk.length &&
    ak.every((k, i) => k === bk[i] && equal((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  );
};
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
/** One ephemeral card per actual scope. No cache body, storage, offer, activation or evidence. */
export function createRegionPreviewSession(options: {
  scope: AccountScope;
  capabilities: ClientCapabilities;
  newReadId: () => string;
}) {
  const { scope } = options;
  let ended = !scope.active || !scope.onEnd;
  let generation = 0;
  let controller: AbortController | undefined;
  let running = false;
  let queued: (() => Promise<void>) | undefined;
  const dispatch = async (task: () => Promise<void>) => {
    if (running) {
      queued = task;
      return;
    }
    running = true;
    try {
      await task();
    } finally {
      running = false;
      const next = queued;
      queued = undefined;
      if (next) void dispatch(next);
    }
  };
  let watermark = 0,
    geographyRevision = 0;
  let state: RegionPreviewState = { status: ended ? 'ended' : 'idle' };
  const listeners = new Set<() => void>();
  const publish = (next: RegionPreviewState) => {
    state = freeze(next);
    for (const listener of [...listeners]) listener();
  };
  const cancel = () => {
    generation++;
    queued = undefined;
    controller?.abort();
    controller = undefined;
    if (!ended) publish({ status: 'idle' });
  };
  const end = () => {
    if (ended) return;
    ended = true;
    generation++;
    queued = undefined;
    controller?.abort();
    controller = undefined;
    watermark = geographyRevision = 0;
    publish({ status: 'ended' });
    listeners.clear();
  };
  const off = scope.onEnd?.(end);
  return {
    getState: () => state,
    subscribe(this: void, listener: () => void) {
      if (ended) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    cancel,
    async read(target: RegionEncounterTarget, minimum: { personalWatermark: number; geographyRevision: number }) {
      if (ended || !scope.active) return;
      cancel();
      const mine = generation;
      const request = RegionEncounterPreviewRequestSchema.safeParse({
        version: 'region-encounter-preview.v1',
        readId: options.newReadId(),
        target,
        capabilities: options.capabilities,
      });
      if (
        !request.success ||
        !Number.isSafeInteger(minimum.personalWatermark) ||
        minimum.personalWatermark < 0 ||
        minimum.geographyRevision !== target.expectedGeographyRevision
      ) {
        publish({ status: 'unavailable', reason: 'invalid' });
        return;
      }
      watermark = Math.max(watermark, minimum.personalWatermark);
      geographyRevision = Math.max(geographyRevision, minimum.geographyRevision);
      const input = freeze(request.data);
      controller = new AbortController();
      const signal = controller.signal;
      publish({ status: 'loading' });
      const current = () => !ended && scope.active && mine === generation && !signal.aborted;
      await dispatch(async () => {
        if (!current()) return;
        try {
          const raw = await scope.api.experience.previewRegionEncounter(input, { signal });
          if (!current()) return;
          // Accepted-data bound after decoding; not a pre-decode transport allocation guarantee.
          if (new TextEncoder().encode(JSON.stringify(raw)).length > 32768) throw new Error('invalid_preview');
          const parsed = RegionEncounterPreviewResponseSchema.safeParse(raw);
          if (!parsed.success) throw new Error('invalid_preview');
          const reply = parsed.data;
          if (
            reply.readId !== input.readId ||
            !equal(reply.target, input.target) ||
            !equal(reply.capabilities, input.capabilities) ||
            reply.scope.universeId !== scope.account.universeId ||
            reply.scope.privacyEpoch !== scope.account.privacyEpoch ||
            reply.scope.personalWatermark < watermark ||
            reply.geographyRevision < geographyRevision
          )
            throw new Error('invalid_preview');
          watermark = reply.scope.personalWatermark;
          geographyRevision = reply.geographyRevision;
          publish(
            reply.status === 'available'
              ? { status: 'available', preview: reply }
              : { status: 'unavailable', reason: reply.reason },
          );
        } catch (error) {
          if (!current()) return;
          const p = apiProblem(error);
          const authority =
            p &&
            [
              'UNAUTHENTICATED',
              'FORBIDDEN',
              'SCOPE_MISMATCH',
              'PRIVACY_EPOCH_CHANGED',
              'UNIVERSE_UNAVAILABLE',
            ].includes(p.code);
          publish({
            status: 'unavailable',
            reason: authority
              ? 'authority'
              : p
                ? 'temporarily_unavailable'
                : error instanceof TypeError
                  ? 'network'
                  : 'invalid',
          });
        }
      });
    },
    dispose() {
      end();
      off?.();
    },
  };
}
