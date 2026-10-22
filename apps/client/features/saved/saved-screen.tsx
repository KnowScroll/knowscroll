import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import type { AccountScope } from '@knowscroll/client-core';
import { spacing } from '@knowscroll/design-tokens';
import { Button, ErrorState, Skeleton, StateBlock, Text } from '@knowscroll/ui';
import { newCommandId } from '../../platform/command-id';
import { useAccountScope } from '../../providers/account-scope';
import { readResume } from '../encounter/encounter-history';
import { encounterSessionFor } from '../encounter/use-encounter-session';
import { ScreenFrame } from '../shell/screen-frame';
import { EmptyKeepScreen } from './empty-keep-screen';
import { KeptSavedCard } from './saved-card';
import { KeepDetail } from './keep-detail';
import type { AvailableKeep } from './keep-place-bridge';
import { savedRemovalFor, createSavedPages, type SavedItem } from './saved-query';

export function SignedInSaved({ scope }: { readonly scope: AccountScope }) {
  const pages = useMemo(() => createSavedPages(scope), [scope]);
  useFocusEffect(
    useCallback(() => {
      pages.start();
      return () => pages.stop();
    }, [pages]),
  );
  const page = useSyncExternalStore(pages.subscribe, pages.getState, pages.getState);
  const { filter, selected } = page;
  const router = useRouter();
  const removal = savedRemovalFor(scope, newCommandId);
  const removalState = useSyncExternalStore(removal.subscribe, removal.getState, removal.getState);
  const [openFailed, setOpenFailed] = useState(false);
  const removing = ['preparing', 'grace', 'sending', 'unknown'].includes(removalState.status);
  const open = (item: SavedItem, assetRevision: number, mode: 'resume' | 'top' = 'top', snapshot?: AvailableKeep) => {
    const session = encounterSessionFor(scope);
    const accepted = session.openKept({ assetId: item.assetId, assetRevision }, mode, snapshot, {
      assetId: item.assetId,
      assetRevision: item.assetRevision,
      savedEntryId: item.savedEntryId,
    });
    if (!accepted) {
      setOpenFailed(true);
      return;
    }
    router.navigate('/explore');
  };
  const visible = page.page?.items ?? [];
  return (
    <ScreenFrame tone="paper" title="Keep" bodyOffset={spacing[7]}>
      <View style={styles.body}>
        <View role="group" accessibilityLabel="Filter saved encounters" style={styles.filters}>
          {(['all', 'reel', 'scroll'] as const).map((kind) => (
            <Button
              key={kind}
              label={kind === 'all' ? 'All' : kind === 'reel' ? 'Reels' : 'Scrolls'}
              size="sm"
              variant={filter === kind ? 'primary' : 'ghost'}
              toggled={filter === kind}
              onPress={() => {
                pages.refresh(kind);
              }}
            />
          ))}
        </View>
        {page.status === 'loading' ? <Skeleton rows={3} label="Loading kept encounters" /> : null}
        {page.status === 'unavailable' ? (
          <ErrorState
            title="Refresh Keep"
            body="This page couldn't be checked. Refresh to start with the latest saved encounters."
            onRetry={() => pages.refresh()}
          />
        ) : null}
        <Button label="Refresh Keep" variant="ghost" onPress={() => pages.refresh()} />
        {openFailed ? (
          <StateBlock
            title="Your current move needs attention"
            body="Return to Explore to retry or review the current move before opening another encounter."
            actions={[
              {
                label: 'Return to Explore',
                href: '/explore',
                role: 'link',
                onPress: () => router.navigate('/explore'),
                variant: 'primary',
              },
            ]}
          />
        ) : null}
        {page.status === 'ready' && visible.length === 0 ? (
          <StateBlock
            title={
              page.page?.continuation.status === 'more'
                ? 'More saved encounters to check'
                : filter === 'all' && !page.canPrevious && !page.olderDiscarded
                  ? 'Nothing kept yet'
                  : 'No saved encounters on this page'
            }
            body={
              page.page?.continuation.status === 'more'
                ? 'Continue to check the next part of this filter.'
                : 'Try another filter or refresh Keep. You can also save an encounter from Explore.'
            }
          />
        ) : null}
        {removalState.status === 'grace' ? (
          <View style={styles.body}>
            <Text variant="bodyS">Removal starts in five seconds. Undo keeps this encounter in Keep.</Text>
            <Button
              label="Undo removal"
              onPress={() => {
                removal.undo();
              }}
            />
          </View>
        ) : null}
        {removalState.status === 'preparing' ? <Text variant="meta">Checking this saved encounter…</Text> : null}
        {removalState.status === 'sending' ? <Text variant="meta">Removing this saved encounter…</Text> : null}
        {removalState.status === 'unknown' ? (
          <View style={styles.body}>
            <Text variant="bodyS">
              Removal wasn't confirmed. Retry checks the same removal. Undo is no longer available.
            </Text>
            <Button
              label="Retry removal"
              onPress={() => {
                removal.retry();
              }}
            />
          </View>
        ) : null}
        {removalState.status === 'confirmed' ? (
          <Text variant="meta">Removal confirmed. The latest Keep list is shown when refreshed.</Text>
        ) : null}
        {removalState.status === 'unavailable' ? (
          <Text variant="bodyS">This removal couldn't be completed. Refresh Keep before choosing again.</Text>
        ) : null}
        {selected ? (
          <KeepDetail
            key={`${selected.assetId}:${String(selected.assetRevision)}`}
            scope={scope}
            item={selected}
            onBack={() => pages.select()}
            onOpen={(mode, snapshot) => open(selected, selected.assetRevision, mode, snapshot)}
          />
        ) : null}
        {!selected
          ? visible.map((item) => (
              <KeptSavedCard
                scope={scope}
                key={item.savedEntryId}
                item={item}
                resume={readResume(scope, item.assetId, item.assetRevision)}
                failed={removalState.status === 'unavailable' && removalState.item.assetId === item.assetId}
                removing={removing && 'item' in removalState && removalState.item.assetId === item.assetId}
                onRemove={() => {
                  void removal.prepare(item);
                }}
                onOpen={(revision) => {
                  if (revision === item.assetRevision) pages.select(item);
                  else open(item, revision);
                }}
              />
            ))
          : null}
        {!selected && page.status === 'ready' ? (
          <View role="group" accessibilityLabel="Keep pages" style={styles.filters}>
            <Button
              label="Previous 20 saved encounters"
              variant="ghost"
              disabled={!page.canPrevious}
              onPress={() => {
                pages.previous();
              }}
            />
            {page.page?.continuation.status === 'more' ? (
              <Button
                label={visible.length === 0 ? 'Continue' : 'Next 20 saved encounters'}
                variant="ghost"
                onPress={() => {
                  pages.next();
                }}
              />
            ) : (
              <Text variant="meta">End of this traversal. Keep is a live list; refresh for changes.</Text>
            )}
            {!page.canPrevious && page.olderDiscarded ? (
              <Text variant="meta">This is the oldest retained page. Refresh Keep to return to the beginning.</Text>
            ) : null}
          </View>
        ) : null}
        <Text variant="meta">Content requests aren't available here yet.</Text>
      </View>
    </ScreenFrame>
  );
}
export function SavedScreen() {
  const { state } = useAccountScope();
  if (state.status === 'signed_in') return <SignedInSaved scope={state.scope} />;
  return <EmptyKeepScreen />;
}
const styles = StyleSheet.create({
  body: { gap: spacing[5], width: '100%', maxWidth: 760, alignSelf: 'center' },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
});
