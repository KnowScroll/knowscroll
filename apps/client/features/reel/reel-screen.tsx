import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { createReelRecorder, type AccountScope } from '@knowscroll/client-core';
import type { ApplyActionRequest, ReelDocument } from '@knowscroll/contracts';
import { content, layout, spacing } from '@knowscroll/design-tokens';
import { ActionRail, Banner, Button, FormatSwitch, IconButton, Skeleton, StateBlock, Text } from '@knowscroll/ui';
import { useAccountScope } from '../../providers/account-scope';
import { newCommandId } from '../../platform/command-id';
import { useDocumentTitle } from '../../platform/document-title';
import { SCROLL_CAPABILITIES } from '../scroll/capabilities';
import { savedRemovalFor } from '../saved/saved-query';
import { EvidencePanel } from '../diagnostics/evidence-panel';
import { ActivatedReelView } from './activated-reel-view';

function OpenReel({ scope, assetId }: { scope: AccountScope; assetId: string }) {
  const [opened, setOpened] = useState<{ exposureId: string; document: ReelDocument }>();
  const [failed, setFailed] = useState(false);
  const [commands] = useState(() => ({ open: newCommandId(), activate: newCommandId() }));
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
        await scope.api.experience.activateExposure({ commandId: commands.activate, exposureId: exposure.exposureId });
        if (!stopped && scope.active) setOpened({ exposureId: exposure.exposureId, document: grant.document });
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
  return <ReadyReel scope={scope} exposureId={opened.exposureId} document={opened.document} />;
}

function ReadyReel({
  scope,
  exposureId,
  document,
}: {
  scope: AccountScope;
  exposureId: string;
  document: ReelDocument;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [active, setActive] = useState(AppState.currentState === 'active');
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const removal = useMemo(() => savedRemovalFor(scope, newCommandId), [scope]);
  const removalState = useSyncExternalStore(removal.subscribe, removal.getState, removal.getState);
  useEffect(() => {
    if (removalState.status !== 'confirmed' || removalState.item.assetId !== document.assetId) return;
    let live = true;
    void scope.api.keep
      .read({ version: 'keep-place.v1', target: { assetId: document.assetId, assetRevision: document.revision } })
      .then((snapshot) => {
        if (live && scope.active) setSaved(snapshot.status !== 'not_saved');
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [scope, document, removalState]);
  const saveIntent = useRef<ApplyActionRequest | undefined>(undefined);
  const [saveFailed, setSaveFailed] = useState(false);
  useDocumentTitle(document.title);
  const recorder = useMemo(
    () =>
      createReelRecorder({
        exposure: { exposureId, assetId: document.assetId, assetRevision: document.revision },
        durationMs: document.durationMs,
        scope,
        newId: newCommandId,
      }),
    [scope, exposureId, document],
  );
  useEffect(() => {
    let stopped = false;
    void scope.api.experience
      .listSaved({})
      .then((response) => {
        if (!stopped && scope.active) setSaved(response.items.some((item) => item.assetId === document.assetId));
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
      recorder.end();
    };
  }, [scope, recorder, document.assetId]);
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
    if (saved && !saveIntent.current) {
      await removal.prepare({ assetId: document.assetId, assetRevision: document.revision });
      return;
    }
    setSaving(true);
    setSaveFailed(false);
    try {
      saveIntent.current ??= {
        commandId: newCommandId(),
        kind: 'save',
        target: { assetId: document.assetId, assetRevision: document.revision },
        exposureId,
      };
      const result = await scope.api.experience.applyAction(saveIntent.current);
      if (result.kind !== 'save') throw new Error('unexpected_save_result');
      if (scope.active) {
        setSaved(result.saved);
        saveIntent.current = undefined;
      }
    } catch {
      if (scope.active) setSaveFailed(true);
    } finally {
      if (scope.active) setSaving(false);
    }
  };
  return (
    <View style={styles.ground}>
      <View style={[styles.top, { paddingTop: insets.top + spacing[2] }]}>
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
        active={active}
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
  ground: { flex: 1, backgroundColor: content.paper },
  top: {
    flexDirection: 'row',
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
