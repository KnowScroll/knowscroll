import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  freezeRecordingCommand,
  recordingCommandFields,
  createReelRecorder,
  type AccountScope,
} from '@knowscroll/client-core';
import { DirectActivateExposureResponseSchema, type ReelDocument } from '@knowscroll/contracts';
import { content, layout, spacing } from '@knowscroll/design-tokens';
import {
  ActionRail,
  Banner,
  Button,
  FormatSwitch,
  IconButton,
  Skeleton,
  StateBlock,
  Text,
  type ReelPositionHandle,
} from '@knowscroll/ui';
import { useAccountScope } from '../../providers/account-scope';
import { newCommandId } from '../../platform/command-id';
import { useDocumentTitle } from '../../platform/document-title';
import { SCROLL_CAPABILITIES } from '../scroll/capabilities';
import { useKeepSurface } from '../saved/use-keep-surface';
import { KeepWriteStatus } from '../saved/keep-detail';
import { readResume, writeResume } from '../encounter/encounter-history';
import { savedRemovalFor } from '../saved/saved-query';
import { EvidencePanel } from '../diagnostics/evidence-panel';
import { ReelPage, useReelPageStage } from './reel-page';
import { ActivatedReelView } from './activated-reel-view';

function OpenReel({ scope, assetId }: { scope: AccountScope; assetId: string }) {
  const insets = useSafeAreaInsets();
  const [opened, setOpened] = useState<{
    exposureId: string;
    document: ReelDocument;
    recordingGeneration?: number;
    recordingSessionId: string;
  }>();
  const [failed, setFailed] = useState(false);
  const [commands] = useState(() => ({ open: newCommandId(), activate: newCommandId() }));
  const activation = useRef<{ commandId: string; exposureId: string; recordingGeneration?: number } | undefined>(
    undefined,
  );
  useEffect(() => {
    let stopped = false;
    async function open() {
      try {
        const exposure = await scope.api.experience.openExposure({
          commandId: commands.open,
          target: { kind: 'reel', assetId },
          origin: { kind: 'direct' },
          capabilities: SCROLL_CAPABILITIES,
        });
        if (stopped || !scope.active) return;
        // Discovery outcomes are prepared supply, not direct Reel exposure lineage.
        if (exposure.status !== undefined || exposure.kind !== 'reel') throw new Error('unexpected_reel_open_result');
        const grant = await scope.api.media.grant({ exposureId: exposure.exposureId });
        if (stopped || !scope.active) return;
        activation.current ??= freezeRecordingCommand({
          ...(await recordingCommandFields(scope)),
          commandId: commands.activate,
          exposureId: exposure.exposureId,
        });
        if (stopped || !scope.active) return;
        const activated = DirectActivateExposureResponseSchema.parse(
          await scope.api.experience.activateExposure(activation.current),
        );
        if (activated.commandId !== activation.current.commandId || activated.exposureId !== exposure.exposureId)
          throw new Error('activation_lineage');
        if (!stopped && scope.active)
          setOpened({
            exposureId: exposure.exposureId,
            document: grant.document,
            ...(activation.current.recordingGeneration === undefined
              ? {}
              : { recordingGeneration: activation.current.recordingGeneration }),
            recordingSessionId: activation.current.commandId,
          });
      } catch {
        if (!stopped && scope.active) setFailed(true);
      }
    }
    void open();
    return () => {
      stopped = true;
    };
  }, [scope, assetId, commands]);
  if (failed) return <StateBlock title="This Reel isn't available" body="Check your connection, then open it again." />;
  if (!opened) return <Skeleton rows={3} label="Opening the Reel" />;
  return (
    <ReelPage
      testID="direct-reel-page"
      topInset={insets.top}
      bottomInset={insets.bottom}
      leftInset={insets.left}
      rightInset={insets.right}
    >
      <ReadyReel
        scope={scope}
        exposureId={opened.exposureId}
        document={opened.document}
        recordingGeneration={opened.recordingGeneration}
        recordingSessionId={opened.recordingSessionId}
      />
    </ReelPage>
  );
}

function ReadyReel({
  scope,
  exposureId,
  document,
  recordingGeneration,
  recordingSessionId,
}: {
  scope: AccountScope;
  exposureId: string;
  document: ReelDocument;
  recordingGeneration: number | undefined;
  recordingSessionId: string;
}) {
  const router = useRouter();
  const [active, setActive] = useState(AppState.currentState === 'active');
  const [saving, setSaving] = useState(false);
  const removal = useMemo(() => savedRemovalFor(scope, newCommandId), [scope]);
  const removalState = useSyncExternalStore(removal.subscribe, removal.getState, removal.getState);
  const positionRef = useRef<ReelPositionHandle>(null);
  const pause = useCallback(() => positionRef.current?.pause(), []);
  const visibility = useReelPageStage(scope, active, pause);
  const renderStage = useCallback(
    (stage: React.ReactNode) => (
      <View ref={visibility.ref} onLayout={visibility.onLayout} style={styles.stage}>
        {stage}
      </View>
    ),
    [visibility.ref, visibility.onLayout],
  );
  const target = useMemo(() => ({ assetId: document.assetId, assetRevision: document.revision }), [document]);
  const capture = useCallback(() => {
    const value = positionRef.current?.capture();
    if (!value || !Number.isFinite(value.positionMs) || value.positionMs < 0) return undefined;
    const positionMs = Math.min(value.positionMs, document.durationMs);
    writeResume(scope, document.assetId, document.revision, { kind: 'reel', ...value, positionMs });
    return { kind: 'reel' as const, positionMs };
  }, [scope, document]);
  const kept = useKeepSurface(scope, target, exposureId, capture);
  const snapshot = kept.state.place.snapshot;
  const saved =
    kept.state.place.snapshot?.status === 'available' || kept.state.place.snapshot?.status === 'saved_unavailable';
  const [resume] = useState(() => readResume(scope, document.assetId, document.revision));
  const [saveFailed, setSaveFailed] = useState(false);
  useDocumentTitle(document.title);
  const recorder = useMemo(
    () =>
      createReelRecorder({
        exposure: {
          exposureId,
          assetId: document.assetId,
          assetRevision: document.revision,
          ...(recordingGeneration === undefined ? {} : { recordingGeneration }),
          recordingSessionId,
        },
        durationMs: document.durationMs,
        scope,
        newId: newCommandId,
      }),
    [scope, exposureId, document, recordingGeneration, recordingSessionId],
  );
  useEffect(() => {
    if (removalState.status === 'confirmed' && removalState.item.assetId === document.assetId) kept.surface.refresh();
  }, [removalState, document.assetId, kept.surface]);
  useEffect(() => () => recorder.end(), [recorder]);
  useFocusEffect(
    useCallback(() => {
      setActive(AppState.currentState === 'active');
      const listener = AppState.addEventListener('change', (value) => {
        setActive(value === 'active');
        if (value !== 'active') recorder.discontinuity();
      });
      return () => {
        setActive(false);
        recorder.discontinuity();
        listener.remove();
      };
    }, [recorder]),
  );
  const save = async () => {
    if (saving || !scope.active) return;
    if (saved && kept.state.save !== 'unknown') {
      await removal.prepare({
        assetId: document.assetId,
        assetRevision: document.revision,
        savedEntryId: snapshot && snapshot.status !== 'not_saved' ? snapshot.entry.savedEntryId : undefined,
      });
      return;
    }
    capture();
    setSaving(true);
    setSaveFailed(false);
    try {
      const confirmed = await kept.surface.save();
      if (scope.active) {
        if (!confirmed) setSaveFailed(true);
      }
    } catch {
      if (scope.active) setSaveFailed(true);
    } finally {
      if (scope.active) setSaving(false);
    }
  };
  return (
    <View style={styles.page}>
      <View style={[styles.top, { paddingTop: spacing[2] }]}>
        <IconButton
          icon="back"
          label="Back"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/explore'))}
        />
        <FormatSwitch selected="reel" availability={{ scroll: 'unavailable' }} onSelect={() => undefined} />
      </View>
      <ActivatedReelView
        scope={scope}
        exposureId={exposureId}
        document={document}
        recorder={recorder}
        active={active && visibility.visible}
        renderStage={renderStage}
        stageMaxHeight={visibility.stageMaxHeight}
        positionRef={positionRef}
        initialPositionMs={resume?.kind === 'reel' ? resume.positionMs : undefined}
      />
      <View style={styles.caption}>
        <View style={styles.copy}>
          <Text variant="title" color={content.paper}>
            {document.title}
          </Text>
          <Text variant="bodyS" color={content.paper}>
            {document.summary}
          </Text>
        </View>
        <ActionRail
          available={['save']}
          saved={saved}
          saving={saving}
          onAction={() => {
            void save();
          }}
        />
      </View>
      {removalState.status === 'grace' ? (
        <View>
          <Text variant="bodyS">Removal starts in five seconds.</Text>
          <Button
            label="Undo removal"
            onPress={() => {
              removal.undo();
            }}
          />
        </View>
      ) : null}
      {removalState.status === 'preparing' || removalState.status === 'sending' ? (
        <Text variant="meta">Checking your removal…</Text>
      ) : null}
      {removalState.status === 'unknown' ? (
        <View>
          <Text variant="bodyS">Removal wasn't confirmed. Undo is no longer available.</Text>
          <Button
            label="Retry removal"
            onPress={() => {
              removal.retry();
            }}
          />
        </View>
      ) : null}
      {removalState.status === 'unavailable' ? (
        <Text variant="bodyS">This removal couldn't be completed. Check Keep before choosing again.</Text>
      ) : null}
      <Button
        label="Keep this place"
        variant="ghost"
        disabled={
          kept.state.place.snapshot?.status !== 'available' ||
          kept.state.place.write === 'unknown' ||
          kept.state.place.write === 'conflict'
        }
        onPress={() => {
          void kept.surface.captureFresh();
        }}
      />
      <KeepWriteStatus
        state={kept.state.place}
        refresh={kept.surface.refresh}
        retry={kept.surface.retry}
        resolve={kept.surface.resolveConflict}
      />
      {saveFailed ? <Banner kind="info" lead="Couldn't save" message="Try the Save button again." /> : null}
      <EvidencePanel scope={scope} exposureId={exposureId} />
    </View>
  );
}

/** An admitted immutable Reel by address. Missing actions are hidden; no social state is invented. */
export function ReelScreen() {
  const { assetId } = useLocalSearchParams<{ assetId?: string | string[] }>();
  const id = Array.isArray(assetId) ? assetId[0] : assetId;
  const { state } = useAccountScope();
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    return <StateBlock title="This Reel isn't available" body="The address doesn't name a Reel." />;
  if (state.status !== 'signed_in')
    return <StateBlock title="Sign in to watch" body="Open KnowScroll with your email to continue." />;
  return <OpenReel key={`${state.scope.id}:${id}`} scope={state.scope} assetId={id.toLowerCase()} />;
}
const styles = StyleSheet.create({
  page: { flexGrow: 1, backgroundColor: content.paper, paddingBottom: spacing[24] },
  stage: { flex: 1, minHeight: 0 },
  top: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing[2],
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: layout.gutter,
    paddingBottom: spacing[2],
  },
  caption: {
    backgroundColor: content.ink,
    flexDirection: 'row',
    padding: spacing[4],
    gap: spacing[4],
    alignItems: 'center',
  },
  copy: { flex: 1, gap: spacing[2] },
});
