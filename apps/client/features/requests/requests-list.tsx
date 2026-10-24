import { useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';
import { borderWidth, content, spacing } from '@knowscroll/design-tokens';
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
      return status.reason === 'could_not_prepare' ? 'failed' : 'unavailable';
    case 'cancelled':
      return 'cancelled';
  }
}

/** The line a request is known by: the person's words, and the format they asked for when it was one. */
function requestLine(item: ListedRequest): string {
  return item.format === 'either' ? item.title : `${item.title}, as a ${formatWord[item.format]}`;
}

function RequestRow({
  item,
  cancelling,
  onOpen,
  onCancel,
  onAskDifferently,
}: {
  readonly item: ListedRequest;
  readonly cancelling: 'sending' | 'unknown' | undefined;
  readonly onOpen: (target: ReadyRequestTarget) => void;
  readonly onCancel: () => void;
  /** Where a failed ask goes to be asked another way; the list cannot resend it (see below). */
  readonly onAskDifferently?: () => void;
}) {
  const { status } = item;
  const chip = chipStatus(status);
  return (
    <View style={styles.row} testID="request-row">
      <Text variant="ui">{requestLine(item)}</Text>
      {status.status === 'ready' ? (
        <RequestStatusChip
          status="ready"
          detail="Open"
          onPress={() => onOpen({ kind: status.content.metadata.kind, assetId: status.content.assetId })}
        />
      ) : (
        <RequestStatusChip status={chip} />
      )}
      {status.status === 'unavailable' && chip === 'unavailable' ? (
        <Text variant="bodyS">{unavailableCopy[status.reason]}</Text>
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
      {chip === 'failed' && onAskDifferently ? (
        <Button label="Ask differently" variant="ghost" size="sm" onPress={onAskDifferently} />
      ) : null}
    </View>
  );
}

/**
 * E07's "Your requests": the person's own asks with their current state, newest first, each with the
 * one action it has (Open when ready, Cancel while preparing, Ask differently after "Couldn't prepare").
 * The list does not resend a closed ask: it knows the person's words but not whether they were a
 * catalogue topic, a facet or a variant, so a resend could be a different request. The request sheet,
 * which holds the exact ask, offers Try again; a `request.retry{requestId}` contract would let the list too. Calm words only: no percentages, no
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
          onAskDifferently={onAsk}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing[1] },
  row: {
    gap: spacing[2],
    paddingVertical: spacing[4],
    borderBottomWidth: borderWidth.hairline,
    borderBottomColor: content.rule,
    alignItems: 'flex-start',
  },
});
