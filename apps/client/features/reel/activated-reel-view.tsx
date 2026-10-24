import { useCallback, type ReactNode, type Ref } from 'react';
import type { AccountScope, ReelRecorder } from '@knowscroll/client-core';
import type { ReelDocument } from '@knowscroll/contracts';
import { ReelPlayer, type ReelPlayerControlProps, type ReelPlayerProps, type ReelPositionHandle } from '@knowscroll/ui';

/** Grants remain in memory and renew against this same activated exposure. */
export function ActivatedReelView({
  scope,
  exposureId,
  document,
  recorder,
  active,
  initialPositionMs,
  initialMuted,
  initialPlaying,
  onMutedChange,
  positionRef,
  controls,
  retainedGrant,
  renderStage,
  children,
}: {
  readonly scope: AccountScope;
  readonly exposureId: string;
  readonly document: ReelDocument;
  readonly recorder: ReelRecorder;
  readonly active: boolean;
  /** Chrome drawn over the full-bleed stage; see `ReelPlayer`. */
  readonly children?: ReelPlayerProps['children'];
  readonly renderStage?: (stage: ReactNode) => ReactNode;
  readonly initialPositionMs?: number;
  readonly initialMuted?: boolean;
  readonly initialPlaying?: boolean;
  readonly onMutedChange?: (muted: boolean) => void;
  readonly positionRef?: Ref<ReelPositionHandle>;
  /** Leave play and pause to the screen: `{ tapToToggle: false, controlsRef }`. */
  readonly controls?: ReelPlayerControlProps;
  readonly retainedGrant?: {
    active(): boolean;
    get(): { path: string; expiresAt: string } | undefined;
    set(grant: { path: string; expiresAt: string }): void;
  };
}) {
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
    <ReelPlayer
      renderStage={renderStage}
      title={document.title}
      durationMs={document.durationMs}
      active={active && scope.active}
      loadSource={source}
      initialPositionMs={initialPositionMs}
      initialMuted={initialMuted}
      initialPlaying={initialPlaying}
      onMutedChange={onMutedChange}
      positionRef={positionRef}
      {...controls}
      onSample={sample}
      onDiscontinuity={discontinuity}
      registerEnd={registerEnd}
    >
      {children}
    </ReelPlayer>
  );
}
