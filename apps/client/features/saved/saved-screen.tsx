import { useState } from 'react';
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
import { SavedCard } from './saved-card';
import { createSavedRemoval, savedQueryOptions } from './saved-query';

const removals = new WeakMap<AccountScope, ReturnType<typeof createSavedRemoval>>();
function removalFor(scope: AccountScope) {
  let removal = removals.get(scope);
  if (!removal) {
    removal = createSavedRemoval(scope, newCommandId);
    removals.set(scope, removal);
  }
  return removal;
}
export function SignedInSaved({ scope }: { readonly scope: AccountScope }) {
  const query = useQuery(savedQueryOptions(scope));
  const router = useRouter();
  const [filter, setFilter] = useState<'all' | 'reel' | 'scroll'>('all');
  const [failed, setFailed] = useState<ReadonlyMap<string, ListSavedResponse['items'][number]>>(new Map());
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set());
  const [openFailed, setOpenFailed] = useState(false);
  const remove = async (item: ListSavedResponse['items'][number]) => {
    if (removing.has(item.assetId)) return;
    setRemoving((values) => new Set(values).add(item.assetId));
    const ok = await removalFor(scope)(item);
    if (ok && scope.active) void encounterSessionFor(scope).refreshContext();
    if (!scope.active) return;
    setRemoving((values) => {
      const next = new Set(values);
      next.delete(item.assetId);
      return next;
    });
    setFailed((values) => {
      const next = new Map(values);
      if (ok) next.delete(item.assetId);
      else next.set(item.assetId, item);
      return next;
    });
  };
  const open = (item: ListSavedResponse['items'][number], assetRevision: number) => {
    const session = encounterSessionFor(scope);
    const accepted = session.open({ kind: 'return', assetId: item.assetId, assetRevision });
    if (!accepted) {
      setOpenFailed(true);
      return;
    }
    router.navigate('/explore');
  };
  const items = query.data?.items ?? [];
  const visible = items.filter((item) => filter === 'all' || item.metadata?.kind === filter);
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
              onPress={() => setFilter(kind)}
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
        {visible.map((item) => (
          <SavedCard
            key={item.assetId}
            item={item}
            resume={readResume(scope, item.assetId, item.assetRevision)}
            failed={failed.has(item.assetId)}
            removing={removing.has(item.assetId)}
            onRemove={() => {
              void remove(item);
            }}
            onOpen={(revision) => open(item, revision)}
          />
        ))}
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
