import { useCallback, useEffect, useMemo, useRef, useState, type Ref, type ReactNode } from 'react';
import { useIsFocused } from 'expo-router';
import { AppState, StyleSheet, View } from 'react-native';
import {
  createReelRecorder,
  freezeRecordingCommand,
  recordingCommandFields,
  type AccountScope,
  type ReelRecorder,
} from '@knowscroll/client-core';
import { DirectActivateExposureResponseSchema, type ReelDocument } from '@knowscroll/contracts';
import { content, radius, spacing } from '@knowscroll/design-tokens';
import { Button, Skeleton, StateBlock, Text, type ReelPositionHandle } from '@knowscroll/ui';
import { newCommandId } from '../../platform/command-id';
import { SCROLL_CAPABILITIES } from '../scroll/capabilities';
import { ActivatedReelView } from '../reel/activated-reel-view';

/** An opened and activated Reel: the lineage every observation of this viewing carries. */
export interface ReelExposure {
  readonly exposureId: string;
  readonly document: ReelDocument;
  readonly recorder: ReelRecorder;
}

export type ReelExposureState =
  | { readonly status: 'idle' }
  | { readonly status: 'opening' }
  | { readonly status: 'ready'; readonly exposure: ReelExposure }
  | { readonly status: 'unavailable' };

/**
 * Opens a Reel only when `start` is called, so a thread or a snippet that merely shows a Reel never
 * creates an exposure, and an episode only counts as visited once the person chose to play it. The
 * steps are the Reel screen's (open, media grant, activate) with the commands kept per intent, so a
 * retry after a failure never opens a second exposure. The recorder ends with the component.
 */
export function useReelExposure(scope: AccountScope, assetId: string) {
  const [state, setState] = useState<ReelExposureState>({ status: 'idle' });
  const commands = useRef({ open: newCommandId(), activate: newCommandId() });
  const activation = useRef<{ commandId: string; exposureId: string; recordingGeneration?: number } | undefined>(
    undefined,
  );
  const running = useRef(false);
  const mounted = useRef(true);
  const recorder = useRef<ReelRecorder | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      recorder.current?.end();
    };
  }, []);

  const start = useCallback(() => {
    if (running.current || state.status === 'ready') return;
    running.current = true;
    setState({ status: 'opening' });
    void (async () => {
      try {
        const opened = await scope.api.experience.openExposure({
          commandId: commands.current.open,
          target: { kind: 'reel', assetId },
          origin: { kind: 'direct' },
          capabilities: SCROLL_CAPABILITIES,
        });
        if (opened.status !== undefined || opened.kind !== 'reel') throw new Error('unexpected_reel_open_result');
        const grant = await scope.api.media.grant({ exposureId: opened.exposureId });
        activation.current ??= freezeRecordingCommand({
          ...(await recordingCommandFields(scope)),
          commandId: commands.current.activate,
          exposureId: opened.exposureId,
        });
        const activated = DirectActivateExposureResponseSchema.parse(
          await scope.api.experience.activateExposure(activation.current),
        );
        if (activated.exposureId !== opened.exposureId) throw new Error('activation_lineage');
        if (!mounted.current || !scope.active) return;
        const made = createReelRecorder({
          exposure: {
            exposureId: opened.exposureId,
            assetId: grant.document.assetId,
            assetRevision: grant.document.revision,
            ...(activation.current.recordingGeneration === undefined
              ? {}
              : { recordingGeneration: activation.current.recordingGeneration }),
            recordingSessionId: activation.current.commandId,
          },
          durationMs: grant.document.durationMs,
          scope,
          newId: newCommandId,
        });
        recorder.current = made;
        setState({
          status: 'ready',
          exposure: { exposureId: opened.exposureId, document: grant.document, recorder: made },
        });
      } catch {
        if (mounted.current && scope.active) setState({ status: 'unavailable' });
      } finally {
        running.current = false;
      }
    })();
  }, [scope, assetId, state.status]);

  return { state, start };
}

export interface ReelMoment {
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * A Reel in a thread or a snippet viewer: a poster with Play until the person plays it, then the
 * player. With a `moment` it starts at the moment's start and pauses at its end, then offers Replay
 * (and whatever `afterEnd` adds). `active` false (the thread's player is folded, a sheet is open) or
 * another screen in front of this one pauses it. Actual playback is an ordinary encounter of the original Reel; showing the poster is not.
 */
export function ReelEncounter({
  scope,
  assetId,
  title,
  summary,
  moment,
  active,
  positionRef,
  onOpened,
  stageMaxHeight,
  afterEnd,
}: {
  readonly scope: AccountScope;
  readonly assetId: string;
  readonly title: string;
  readonly summary?: string | undefined;
  readonly moment?: ReelMoment | undefined;
  readonly active: boolean;
  readonly positionRef?: Ref<ReelPositionHandle> | undefined;
  /** Called once the Reel is open, with the revision and length actually playing. */
  readonly onOpened?: ((document: ReelDocument) => void) | undefined;
  /** The most height the picture may take, so a screen with more on it stays usable. */
  readonly stageMaxHeight?: number | undefined;
  readonly afterEnd?: ReactNode;
}) {
  const { state, start } = useReelExposure(scope, assetId);
  const [round, setRound] = useState(0);
  const [ended, setEnded] = useState(false);
  // The player's own visibility observer cannot tell that another screen now covers this one (on
  // native it always says visible), so route focus is fenced here, as the Reel screen does.
  const focused = useIsFocused();
  const playing = active && focused && !ended;
  const internalRef = useRef<ReelPositionHandle>(null);
  const handle = positionRef ?? internalRef;
  const exposure = state.status === 'ready' ? state.exposure : undefined;
  useEffect(() => {
    if (exposure !== undefined) onOpened?.(exposure.document);
  }, [exposure, onOpened]);
  useEffect(() => {
    if (exposure === undefined) return undefined;
    const listener = AppState.addEventListener('change', (next) => {
      if (next !== 'active') exposure.recorder.discontinuity();
    });
    return () => listener.remove();
  }, [exposure]);
  useEffect(() => {
    if (!active || !focused) exposure?.recorder.discontinuity();
  }, [active, focused, exposure]);

  // The range ends where the sender chose. Setting `ended` makes the player inactive, which pauses it.
  const watched = useMemo(() => {
    if (exposure === undefined || moment === undefined) return exposure?.recorder;
    const recorder = exposure.recorder;
    return {
      ...recorder,
      sample(next: Parameters<ReelRecorder['sample']>[0]) {
        recorder.sample(next);
        if (next.playing && next.positionMs >= moment.endMs) setEnded(true);
      },
    } satisfies ReelRecorder;
  }, [exposure, moment]);

  if (state.status === 'unavailable')
    return <StateBlock title="This Reel isn't available" body="Check your connection, then try again." />;
  if (state.status === 'opening') return <Skeleton rows={2} label="Opening the Reel" />;
  if (exposure === undefined || watched === undefined)
    return (
      <View style={styles.poster}>
        <View style={styles.posterText}>
          <Text variant="ui" color={content.paper} numberOfLines={2}>
            {title}
          </Text>
          {summary === undefined || summary === '' ? null : (
            <Text variant="meta" color={content.paper} numberOfLines={2}>
              {summary}
            </Text>
          )}
        </View>
        <Button
          label={moment === undefined ? 'Watch' : 'Watch this moment'}
          icon="play"
          variant="continue"
          onPress={start}
        />
      </View>
    );
  return (
    <View style={styles.player}>
      <ActivatedReelView
        key={round}
        scope={scope}
        exposureId={exposure.exposureId}
        document={exposure.document}
        recorder={watched}
        active={playing}
        positionRef={handle}
        initialPositionMs={moment?.startMs}
        stageMaxHeight={stageMaxHeight}
      />
      {ended ? (
        <View style={styles.ended}>
          <Button
            label="Replay"
            icon="retry"
            onPress={() => {
              setEnded(false);
              setRound((value) => value + 1);
            }}
          />
          {afterEnd}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  poster: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing[3],
    padding: spacing[4],
    borderRadius: radius.panel,
    backgroundColor: content.ink,
  },
  posterText: { flexGrow: 1, flexShrink: 1, flexBasis: 160, gap: spacing[1] },
  player: { gap: spacing[2] },
  ended: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
});
