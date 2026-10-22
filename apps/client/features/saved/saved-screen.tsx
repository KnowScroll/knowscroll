import { useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import type { AccountScope } from '@knowscroll/client-core';
import type { ListSavedResponse } from '@knowscroll/contracts';
import { spacing } from '@knowscroll/design-tokens';
import { Banner, Button, ErrorState, Skeleton, StateBlock, Text } from '@knowscroll/ui';
import { newCommandId } from '../../platform/command-id';
import { useAccountScope } from '../../providers/account-scope';
import { readResume } from '../encounter/encounter-history';
import { encounterSessionFor } from '../encounter/use-encounter-session';
import { ScreenFrame } from '../shell/screen-frame';
import { EmptyKeepScreen } from './empty-keep-screen';
import { KeptSavedCard } from './saved-card';
import { KeepDetail } from './keep-detail';
import type { AvailableKeep } from './keep-place-bridge';
import { savedRemovalFor, savedQueryOptions } from './saved-query';

export function SignedInSaved({ scope }: { readonly scope: AccountScope }) {
  const query = useQuery(savedQueryOptions(scope));
  const router = useRouter();
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState<'all' | 'reel' | 'scroll'>('all');
  const removal = savedRemovalFor(scope, newCommandId);
  const removalState = useSyncExternalStore(removal.subscribe, removal.getState, removal.getState);
  const [openFailed, setOpenFailed] = useState(false);
  const [selected, setSelected] = useState<ListSavedResponse['items'][number]>();
  const removing = ['preparing', 'grace', 'sending', 'unknown'].includes(removalState.status);
  const open = (
    item: ListSavedResponse['items'][number],
    assetRevision: number,
    mode: 'resume' | 'top' = 'top',
    snapshot?: AvailableKeep,
  ) => {
    const session = encounterSessionFor(scope);
    const accepted = session.openKept({ assetId: item.assetId, assetRevision }, mode, snapshot);
    if (!accepted) {
      setOpenFailed(true);
      return;
    }
    router.navigate('/explore');
  };
  const items = query.data?.items ?? [];
  const filtered = items.filter((item) => filter === 'all' || item.metadata?.kind === filter);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 20) - 1));
  const visible = filtered.slice(currentPage * 20, currentPage * 20 + 20);
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
                setFilter(kind);
                setPage(0);
                setSelected(undefined);
              }}
            />
          ))}
        </View>
        {query.isPending ? <Skeleton rows={3} label="Loading kept encounters" /> : null}
        {query.isError && !query.data ? (
          <ErrorState
            title="Couldn't load Keep"
            body="Check your connection and try again."
            onRetry={() => {
              void query.refetch();
            }}
          />
        ) : null}
        {query.isError && query.data ? (
          <Banner
            kind="info"
            lead="Your saved list may be out of date."
            message="The last loaded list is shown while the connection is unavailable."
          />
        ) : null}
        {query.isError && query.data ? (
          <Button
            label="Refresh Keep"
            onPress={() => {
              void query.refetch();
            }}
          />
        ) : null}
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
        {query.data && items.length === 0 ? (
          <StateBlock
            title="Nothing kept yet"
            body="Save a Reel or Scroll to keep a way back to your place."
            actions={[
              {
                label: 'Go to Explore',
                href: '/explore',
                role: 'link',
                onPress: () => router.navigate('/explore'),
                variant: 'primary',
              },
            ]}
          />
        ) : null}
        {items.length > 0 && visible.length === 0 ? (
          <StateBlock title="No saved encounters in this filter" body="Try All to see the rest of this list." />
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
            onBack={() => setSelected(undefined)}
            onOpen={(mode, snapshot) => open(selected, selected.assetRevision, mode, snapshot)}
          />
        ) : null}
        {!selected
          ? visible.map((item) => (
              <KeptSavedCard
                scope={scope}
                key={item.assetId}
                item={item}
                resume={readResume(scope, item.assetId, item.assetRevision)}
                failed={removalState.status === 'unavailable' && removalState.item.assetId === item.assetId}
                removing={removing && 'item' in removalState && removalState.item.assetId === item.assetId}
                onRemove={() => {
                  void removal.prepare(item);
                }}
                onOpen={(revision) => {
                  if (revision === item.assetRevision) setSelected(item);
                  else open(item, revision);
                }}
              />
            ))
          : null}
        {!selected && filtered.length > 20 ? (
          <View role="group" accessibilityLabel="Keep pages" style={styles.filters}>
            <Text variant="meta">
              Showing {currentPage * 20 + 1}–{Math.min(currentPage * 20 + 20, filtered.length)} of {filtered.length}{' '}
              loaded encounters
            </Text>
            <Button
              label="Previous 20 saved encounters"
              variant="ghost"
              disabled={currentPage === 0}
              onPress={() => setPage(currentPage - 1)}
            />
            <Button
              label="Next 20 saved encounters"
              variant="ghost"
              disabled={(currentPage + 1) * 20 >= filtered.length}
              onPress={() => setPage(currentPage + 1)}
            />
          </View>
        ) : null}
        {items.length >= 100 ? (
          <Text variant="meta">
            Showing the newest 100 saved encounters. This is a bounded list, not your complete library.
          </Text>
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
