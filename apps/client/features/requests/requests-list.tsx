import { useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Banner, Button, ErrorState, RequestStatusChip, Skeleton, StateBlock, Text } from '@knowscroll/ui';
import type { ContentRequestStatus } from '@knowscroll/contracts';
import { formatWord, unavailableCopy } from './request-copy';
import type { ListedRequest, RequestsListSession } from './requests-list-session';

/** What a person can open: the Scroll or Reel that a ready request bound. */
export interface ReadyRequestTarget {
  readonly kind: 'reel' | 'scroll';
  readonly assetId: string;
}

function chipStatus(status: ContentRequestStatus) {
  switch (status.status) {
    case 'preparing':
      return status.phase === 'requested' ? 'requested' : 'preparing';
    case 'ready':
      return 'ready';
    case 'unavailable':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
  }
}

function RequestRow({
  item,
  cancelling,
  onOpen,
  onCancel,
}: {
  readonly item: ListedRequest;
  readonly cancelling: 'sending' | 'unknown' | undefined;
  readonly onOpen: (target: ReadyRequestTarget) => void;
  readonly onCancel: () => void;
}) {
  const { status } = item;
  return (
    <View style={styles.row} testID="request-row">
      <Text variant="meta">{formatWord[item.format]}</Text>
      <Text variant="title" heading={3}>
        {item.title}
      </Text>
      <RequestStatusChip
        status={chipStatus(status)}
        {...(status.status === 'ready' ? { detail: 'Open it below' } : {})}
      />
      {status.status === 'preparing' ? (
        <Text variant="bodyS">We&apos;ll show it when it&apos;s ready. Keep exploring meanwhile.</Text>
      ) : null}
      {status.status === 'unavailable' ? <Text variant="bodyS">{unavailableCopy[status.reason]}</Text> : null}
      {status.status === 'ready' ? (
        <Button
          label={`Open ${status.content.metadata.kind === 'reel' ? 'Reel' : 'Scroll'}`}
          variant="primary"
          size="sm"
          onPress={() => onOpen({ kind: status.content.metadata.kind, assetId: status.content.assetId })}
        />
      ) : null}
      {status.status === 'preparing' ? (
        <Button
          label="Cancel request"
          variant="ghost"
          size="sm"
          busy={cancelling === 'sending'}
          busyLabel="Cancelling…"
          onPress={onCancel}
        />
      ) : null}
      {cancelling === 'unknown' ? (
        <Text variant="bodyS">
          Cancelling wasn&apos;t confirmed. Press Cancel request to try the same request again.
        </Text>
      ) : null}
    </View>
  );
}

/**
 * E07's "Your requests": the person's own asks with their current state, newest first, each with the
 * one action it has (Open when ready, Cancel while preparing). Calm words only: no percentages, no
 * waiting times. When a refresh fails the last known list stays, marked as possibly out of date.
 * Mount it anywhere the person looks for their requests; the session comes from `useRequestsList`.
 */
export function RequestsList({
  session,
  onOpen,
  onAsk,
}: {
  readonly session: RequestsListSession;
  readonly onOpen: (target: ReadyRequestTarget) => void;
  /** Where "Ask for something" leads when nothing was requested yet; omitted, the empty state has no action. */
  readonly onAsk?: () => void;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  if (state.phase === 'loading') return <Skeleton rows={3} label="Loading your requests" />;
  if (state.phase === 'unavailable')
    return (
      <ErrorState
        title="Couldn't load your requests"
        body="Anything you asked for is safe. Try again in a moment."
        onRetry={() => void session.refresh()}
      />
    );
  if (state.items.length === 0)
    return (
      <StateBlock
        title="Nothing requested yet"
        body="Tap Ask on any Reel or Scroll to request a topic. What you ask for shows up here, and we'll tell you when it's ready."
        actions={
          onAsk ? [{ label: 'Go to Explore', variant: 'primary', role: 'link', href: '/explore', onPress: onAsk }] : []
        }
      />
    );
  return (
    <View style={styles.list} role="list" accessibilityLabel="Your requests">
      {state.stale ? (
        <Banner kind="offline" lead="May be out of date." message="We couldn't refresh your requests just now." />
      ) : null}
      {state.items.map((item) => (
        <RequestRow
          key={item.status.requestId}
          item={item}
          cancelling={state.cancelling?.requestId === item.status.requestId ? state.cancelling.phase : undefined}
          onOpen={onOpen}
          onCancel={() => session.cancel(item.status.requestId)}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing[4] },
  row: {
    gap: spacing[2],
    padding: spacing[4],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.md,
    backgroundColor: content.paper,
    alignItems: 'flex-start',
  },
});
