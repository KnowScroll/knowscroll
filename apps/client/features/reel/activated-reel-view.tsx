import { useCallback, useEffect, useRef, type ReactNode, type Ref } from 'react';
import type { AccountScope, ReelRecorder } from '@knowscroll/client-core';
import type { ReelDocument } from '@knowscroll/contracts';
import { Banner, ReelPlayer, type ReelPositionHandle } from '@knowscroll/ui';

function forwardPosition(ref: Ref<ReelPositionHandle> | undefined, handle: ReelPositionHandle | null) {
  if (typeof ref === 'function') ref(handle);
  else if (ref) ref.current = handle;
}

/** Grants remain in memory and renew against this same activated exposure. */
export function ActivatedReelView({
  scope,
  exposureId,
  document,
  recorder,
  active,
  initialPositionMs,
  initialMuted,
  onMutedChange,
  positionRef,
  retainedGrant,
  renderStage,
  stageMaxHeight,
  shareResumeRevision,
  resumeVisibility = active ? 'visible' : 'hidden',
  consumeShareResume,
}: {
  readonly resumeVisibility?: 'pending' | 'visible' | 'hidden';
  readonly shareResumeRevision?: number;
  readonly consumeShareResume?: () => boolean;
  readonly scope: AccountScope;
  readonly exposureId: string;
  readonly document: ReelDocument;
  readonly recorder: ReelRecorder;
  readonly active: boolean;
  readonly stageMaxHeight?: number;
  readonly renderStage?: (stage: ReactNode) => ReactNode;
  readonly initialPositionMs?: number;
  readonly initialMuted?: boolean;
  readonly onMutedChange?: (muted: boolean) => void;
  readonly positionRef?: Ref<ReelPositionHandle>;
  readonly retainedGrant?: {
    active(): boolean;
    get(): { path: string; expiresAt: string } | undefined;
    set(grant: { path: string; expiresAt: string }): void;
  };
}) {
  const localPosition = useRef<ReelPositionHandle | null>(null);
  const seenResume = useRef(shareResumeRevision ?? 0);
  const setPosition = useCallback(
    (handle: ReelPositionHandle | null) => {
      localPosition.current = handle;
      forwardPosition(positionRef, handle);
    },
    [positionRef],
  );
  useEffect(() => {
    const revision = shareResumeRevision ?? 0;
    if (revision === seenResume.current || resumeVisibility === 'pending') return;
    // Pending is limited to the current native binding's one measurement generation. The
    // observer cancels independently changed geometry/background/end, and definitive hidden
    // or SDK-not-ready is terminal. There is no timer, readiness retry or cold restore intent.
    seenResume.current = revision;
    const permitted = consumeShareResume?.();
    if (active && scope.active && resumeVisibility === 'visible' && permitted) localPosition.current?.resumeIntent?.();
  }, [shareResumeRevision, resumeVisibility, active, scope, consumeShareResume]);
  const source = useCallback(async () => {
    if (!scope.active || (retainedGrant && !retainedGrant.active())) throw new Error('encounter_ended');
    const retained = retainedGrant?.get();
    const grant =
      retained && Date.parse(retained.expiresAt) > Date.now() + 30_000
        ? retained
        : await scope.api.media.grant({ exposureId });
    if (scope.active) retainedGrant?.set({ path: grant.path, expiresAt: grant.expiresAt });
    if (!scope.active || (retainedGrant && !retainedGrant.active()) || !scope.mediaSource)
      throw new Error('media_adapter_unavailable');
    return { source: { ...scope.mediaSource(grant.path), useCaching: false }, expiresAt: grant.expiresAt };
  }, [scope, exposureId, retainedGrant]);
  const registerEnd = useCallback((stop: () => void) => scope.onEnd?.(stop) ?? (() => undefined), [scope]);
  const sample = useCallback((value: Parameters<ReelRecorder['sample']>[0]) => recorder.sample(value), [recorder]);
  const discontinuity = useCallback(() => recorder.discontinuity(), [recorder]);
  return (
    <>
      {document.fixture ? <Banner kind="info" lead="Fixture video" message="Local or CI demonstration media." /> : null}
      <ReelPlayer
        renderStage={renderStage}
        stageMaxHeight={stageMaxHeight}
        title={document.title}
        durationMs={document.durationMs}
        active={active && scope.active}
        loadSource={source}
        initialPositionMs={initialPositionMs}
        initialMuted={initialMuted}
        onMutedChange={onMutedChange}
        positionRef={setPosition}
        onSample={sample}
        onDiscontinuity={discontinuity}
        registerEnd={registerEnd}
      />
    </>
  );
}
