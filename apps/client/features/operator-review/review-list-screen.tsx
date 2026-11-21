import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { isReviewNotFound, reviewListQueryOptions, type AccountScope } from '@knowscroll/client-core';
import type { ReviewListItem } from '@knowscroll/contracts';
import { borderWidth, content, layout, spacing } from '@knowscroll/design-tokens';
import { Button, ErrorState, IconButton, RowLink, Skeleton, StateBlock, Text } from '@knowscroll/ui';
import { useDocumentTitle } from '../../platform/document-title';
import { useAccountScope } from '../../providers/account-scope';
import { NotFoundScreen } from '../not-found/not-found-screen';
import { answerChip, heldSince, supportChip } from './review-copy';
import { ReviewChip } from './review-parts';

/** The address of one held revision's page. */
export function reviewHref(item: Pick<ReviewListItem, 'assetId' | 'revision'>): string {
  return `/operator/review/${item.assetId}/${String(item.revision)}`;
}

function ReviewRow({ item, onOpen }: { readonly item: ReviewListItem; readonly onOpen: () => void }) {
  const answers = answerChip(item.answerCheck);
  const support = supportChip(item.supportCheck);
  const minutes = Math.max(1, Math.round(item.readingMinutes));
  return (
    <RowLink
      label={`${item.title}, revision ${String(item.revision)}. ${answers.text}. ${support.text}. Open to read.`}
      href={reviewHref(item)}
      onPress={onOpen}
      testID={`review-row-${item.assetId}`}
    >
      <View style={styles.row}>
        <Text variant="monoXs" color={content.ink2}>
          {[item.kicker, item.documentVersion === 'scroll-document.v3' ? 'document v3' : 'document v2'].join(' · ')}
        </Text>
        <Text variant="title">{item.title}</Text>
        <View style={styles.chips}>
          <ReviewChip text={support.text} tone={support.tone} />
          <ReviewChip text={answers.text} tone={answers.tone} />
          <ReviewChip
            text={item.coverage === 'mapped' ? 'Coverage: mapped' : 'Coverage: not mapped'}
            tone={item.coverage === 'mapped' ? 'ok' : 'attention'}
          />
        </View>
        <Text variant="meta" color={content.ink2}>
          {[
            `revision ${String(item.revision)}`,
            `${String(minutes)} min`,
            item.topic ?? 'no topic yet',
            item.recipe,
            heldSince(item.heldAt),
          ]
            .filter((part) => part !== null)
            .join(' · ')}
        </Text>
      </View>
    </RowLink>
  );
}

/**
 * The held Scrolls waiting for a decision (`/operator/review`, #780): one row for each, oldest first, with what the checks said in
 * words. Shared content only; nothing here is a reader's own. Operators only: anyone else is shown the unknown-page screen, as
 * the server answers them 404.
 */
export function ReviewList({ scope }: { readonly scope: AccountScope }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const list = useQuery(reviewListQueryOptions(scope.api));
  useDocumentTitle('Review held Scrolls');
  if (list.isError && isReviewNotFound(list.error)) return <NotFoundScreen />;
  const revisions = list.data?.revisions;
  return (
    <ScrollView
      role="main"
      style={styles.ground}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing[3] }]}
      testID="review-list"
    >
      <View style={styles.column}>
        <View style={styles.bar}>
          <IconButton icon="back" label="Back to the Operator screen" onPress={() => router.push('/operator')} />
          <Text variant="label" color={content.ink2}>
            Operator · not consumer UI
          </Text>
        </View>
        <Text variant="page" heading={1}>
          Held Scrolls
        </Text>
        <Text variant="bodyS" color={content.ink2}>
          A Scroll a model wrote waits here until you release it or reject it. Open one to read it as a reader would,
          with the passages it cites and what the checks said.
        </Text>
        <View style={styles.refresh}>
          <Button
            label="Refresh"
            size="sm"
            variant="default"
            busy={list.isFetching}
            busyLabel="Reading"
            onPress={() => void list.refetch()}
            accessibilityLabel="Read the list again"
          />
        </View>
        {list.isPending ? <Skeleton rows={3} label="Loading held Scrolls" /> : null}
        {list.isError ? (
          <ErrorState
            title="Could not read the list"
            body="The held Scrolls could not be read. Nothing was changed."
            onRetry={() => void list.refetch()}
          />
        ) : null}
        {revisions?.length === 0 ? (
          <StateBlock
            testID="review-empty"
            title="Nothing is waiting"
            body="Every Scroll written so far has been released or rejected."
          />
        ) : null}
        {revisions === undefined
          ? null
          : revisions.map((item) => (
              <ReviewRow
                key={`${item.assetId}:${String(item.revision)}`}
                item={item}
                onOpen={() => router.push(reviewHref(item))}
              />
            ))}
      </View>
    </ScrollView>
  );
}

/** `/operator/review`. */
export function ReviewListScreen() {
  const { state } = useAccountScope();
  if (state.status !== 'signed_in') return <NotFoundScreen />;
  return <ReviewList scope={state.scope} />;
}

const styles = StyleSheet.create({
  ground: { flex: 1, backgroundColor: content.paper },
  content: { paddingHorizontal: layout.gutter, paddingBottom: spacing[18], alignItems: 'center' },
  column: { width: '100%', maxWidth: layout.blockDesktop, gap: spacing[3] },
  bar: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  refresh: { flexDirection: 'row' },
  row: {
    gap: spacing[2],
    paddingVertical: spacing[3],
    borderBottomWidth: borderWidth.hairline,
    borderBottomColor: content.rule,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
});
