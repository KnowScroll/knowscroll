import { useCallback, type Ref } from 'react';
import type { AccountScope, ReelRecorder } from '@knowscroll/client-core';
import type { ReelDocument } from '@knowscroll/contracts';
import { Banner, ReelPlayer, type ReelPositionHandle } from '@knowscroll/ui';

/** Grants remain in memory and renew against this same activated exposure. */
export function ActivatedReelView({
  scope,
  exposureId,
  document,
  recorder,
  active,
  initialPositionMs,
  positionRef,
  retainedGrant,
}: {
  readonly scope: AccountScope;
  readonly exposureId: string;
  readonly document: ReelDocument;
  readonly recorder: ReelRecorder;
  readonly active: boolean;
  readonly initialPositionMs?: number;
  readonly positionRef?: Ref<ReelPositionHandle>;
  readonly retainedGrant?: {
    get(): { path: string; expiresAt: string } | undefined;
    set(grant: { path: string; expiresAt: string }): void;
  };
}) {
  const source = useCallback(async () => {
    if (!scope.active) throw new Error('scope_ended');
    const retained = retainedGrant?.get();
    const grant =
      retained && Date.parse(retained.expiresAt) > Date.now() + 30_000
        ? retained
        : await scope.api.media.grant({ exposureId });
    if (scope.active) retainedGrant?.set({ path: grant.path, expiresAt: grant.expiresAt });
    if (!scope.active || !scope.mediaSource) throw new Error('media_adapter_unavailable');
    return { source: { ...scope.mediaSource(grant.path), useCaching: false }, expiresAt: grant.expiresAt };
  }, [scope, exposureId, retainedGrant]);
  const registerEnd = useCallback((stop: () => void) => scope.onEnd?.(stop) ?? (() => undefined), [scope]);
  const sample = useCallback((value: Parameters<ReelRecorder['sample']>[0]) => recorder.sample(value), [recorder]);
  const discontinuity = useCallback(() => recorder.discontinuity(), [recorder]);
  return (
    <>
      {document.fixture ? <Banner kind="info" lead="Fixture video" message="Local or CI demonstration media." /> : null}
      <ReelPlayer
        title={document.title}
        durationMs={document.durationMs}
        active={active && scope.active}
        loadSource={source}
        initialPositionMs={initialPositionMs}
        positionRef={positionRef}
        onSample={sample}
        onDiscontinuity={discontinuity}
        registerEnd={registerEnd}
      />
    </>
  );
}
