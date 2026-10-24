import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import type { AccountScope } from '@knowscroll/client-core';
import { spacing } from '@knowscroll/design-tokens';
import { Button, ErrorState, Skeleton, StateBlock } from '@knowscroll/ui';
import { newCommandId } from '../../platform/command-id';
import { useAccountScope } from '../../providers/account-scope';
import { SignedInRequests } from '../requests/requests-screen';
import { readResume } from '../encounter/encounter-history';
import { encounterSessionFor } from '../encounter/use-encounter-session';
import { ScreenFrame } from '../shell/screen-frame';
import { EmptyKeepScreen, KeepTile } from './empty-keep-screen';
import { RemovalNotice } from './removal-notice';
import { KeptSavedCard } from './saved-card';
import { KeepDetail } from './keep-detail';
import type { AvailableKeep } from './keep-place-bridge';
import { savedRemovalFor, savedPagesFor, type SavedItem } from './saved-query';

export function SignedInSaved({ scope }: { readonly scope: AccountScope }) {
  const pages = useMemo(() => savedPagesFor(scope), [scope]);
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
  const { view } = useLocalSearchParams<{ view?: string }>();
  // E07: "Requested" is a view of Keep beside the saved ones, opened with `/saved?view=requested`.
  const [requestedView, setRequestedView] = useState(view === 'requested');
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
  const firstVisit = filter === 'all' && !page.canPrevious && !page.olderDiscarded;
  return (
    <ScreenFrame tone="paper" title={selected ? undefined : 'Keep'} pageTitle="Keep" bodyOffset={spacing[7]}>
      <View style={styles.body}>
        {selected ? null : (
          <View role="group" accessibilityLabel="Filter saved encounters" style={styles.filters}>
            {(['all', 'reel', 'scroll'] as const).map((kind) => (
              <Button
                key={kind}
                label={kind === 'all' ? 'All' : kind === 'reel' ? 'Reels' : 'Scrolls'}
                size="sm"
                variant={filter === kind && !requestedView ? 'ink' : 'ghost'}
                toggled={filter === kind && !requestedView}
                onPress={() => {
                  setRequestedView(false);
                  pages.refresh(kind);
                }}
              />
            ))}
            <Button
              label="Requested"
              size="sm"
              variant={requestedView ? 'ink' : 'ghost'}
              toggled={requestedView}
              onPress={() => setRequestedView(true)}
            />
          </View>
        )}
        {requestedView ? <SignedInRequests scope={scope} /> : null}
        {requestedView ? null : (
          <>
            {page.status === 'loading' ? <Skeleton rows={3} label="Loading kept encounters" /> : null}
            {page.status === 'unavailable' ? (
              <ErrorState
                title="Couldn't load Keep"
                body="Your saved encounters are safe. Try again in a moment."
                onRetry={() => pages.refresh()}
              />
            ) : null}
            {openFailed ? (
              <StateBlock
                title="Finish your current move first"
                body="Go back to Explore, then open this from Keep again."
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
                illustration={firstVisit ? <KeepTile /> : undefined}
                title={
                  page.page?.continuation.status === 'more'
                    ? 'More to check'
                    : firstVisit
                      ? 'Nothing kept yet'
                      : 'Nothing on this page'
                }
                body={
                  page.page?.continuation.status === 'more'
                    ? 'Continue to look through the rest.'
                    : firstVisit
                      ? 'Tap Save on any Reel or Scroll and it lands here, with your place kept.'
                      : 'Try another filter, or go back to the newest.'
                }
                actions={
                  firstVisit
                    ? [
                        {
                          label: 'Go to Explore',
                          variant: 'primary',
                          role: 'link',
                          href: '/explore',
                          onPress: () => router.navigate('/explore'),
                        },
                      ]
                    : []
                }
              />
            ) : null}
            <RemovalNotice removal={removalState} undo={() => removal.undo()} retry={() => removal.retry()} />
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
                {page.canPrevious ? (
                  <Button
                    label="Previous 20 saved encounters"
                    variant="ghost"
                    onPress={() => {
                      pages.previous();
                    }}
                  />
                ) : null}
                {page.page?.continuation.status === 'more' ? (
                  <Button
                    label={visible.length === 0 ? 'Continue' : 'Next 20 saved encounters'}
                    variant="ghost"
                    onPress={() => {
                      pages.next();
                    }}
                  />
                ) : null}
                {!page.canPrevious && page.olderDiscarded ? (
                  <Button label="Back to the newest" variant="ghost" onPress={() => pages.refresh()} />
                ) : null}
              </View>
            ) : null}
          </>
        )}
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
