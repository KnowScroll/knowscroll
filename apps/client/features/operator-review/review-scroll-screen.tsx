import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  isReviewNotFound,
  operatorReviewKey,
  parseScrollDocument,
  rejectReview,
  releaseReview,
  reviewListQueryOptions,
  reviewShowQueryOptions,
  type AccountScope,
  type ReviewTarget,
} from '@knowscroll/client-core';
import type { ReviewShow } from '@knowscroll/contracts';
import { content, layout, spacing } from '@knowscroll/design-tokens';
import {
  Button,
  EssayCover,
  ErrorState,
  FolioReader,
  IconButton,
  readingModelOfV2,
  readingModelOfV3,
  Skeleton,
  Text,
  useDisplay,
} from '@knowscroll/ui';
import type { ScrollDocumentV2, ScrollDocumentV3 } from '@knowscroll/scroll-model';
import { useDocumentTitle } from '../../platform/document-title';
import { useAccountScope } from '../../providers/account-scope';
import { figureOfCover } from '../explore/cover-figure';
import { NotFoundScreen } from '../not-found/not-found-screen';
import { heldSince, refusalWords } from './review-copy';
import { reviewHref } from './review-list-screen';
import { DecisionPanel, FindingsPanel, SourcesAtEnd, SourcesUnder, type DecisionState } from './review-parts';
import { sourcesIndexOf } from './review-sources';

const ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIST_HREF = '/operator/review';

/**
 * Back to the list. The list screen is usually still under this one in the stack, so going back shows it again (refetched) instead
 * of stacking a second copy; an address opened directly has nothing under it, so it replaces itself with the list.
 */
function useBackToList(): () => void {
  const router = useRouter();
  return () => {
    if (router.canGoBack()) router.back();
    else router.replace(LIST_HREF);
  };
}

/** A route value: Expo Router gives a string, or the list when the parameter repeats. */
function firstOf(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The held revision the route names, or `undefined` for an address that is not one. */
function targetOf(params: { assetId?: string | string[]; revision?: string | string[] }): ReviewTarget | undefined {
  const assetId = firstOf(params.assetId);
  const revision = firstOf(params.revision);
  if (assetId === undefined || !ASSET_ID.test(assetId) || revision === undefined || !/^[1-9][0-9]{0,6}$/.test(revision))
    return undefined;
  return { assetId: assetId.toLowerCase(), revision: Number(revision) };
}

/** One quiet screen for the states that are not the Scroll itself: Back to the list, and what is going on. */
function Frame({ children }: { readonly children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  const backToList = useBackToList();
  return (
    <View role="main" style={[styles.ground, { paddingTop: insets.top + spacing[3] }]}>
      <View style={styles.frameBar}>
        <IconButton icon="back" label="Back to the list" onPress={backToList} />
      </View>
      <View style={styles.state}>{children}</View>
    </View>
  );
}

/**
 * A held revision as a reader sees it (#780): its cover, then the essay in Folio with every picture drawn by the real renderer,
 * the sources each part cites on request, what the checks said at the top, and Release and Reject at the end. Nothing here is
 * recorded as reading: the reader has no observer.
 */
function ReviewBody({
  scope,
  target,
  review,
}: {
  readonly scope: AccountScope;
  readonly target: ReviewTarget;
  readonly review: ReviewShow;
}) {
  const router = useRouter();
  const backToList = useBackToList();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { reducedMotion, breakpoint } = useDisplay();
  const wide = breakpoint === 'tablet' || breakpoint === 'desktop';
  // On a desktop the checks sit in a panel beside the essay, open all the time; elsewhere they are above it.
  const sideBySide = breakpoint === 'desktop';
  const [opened, setOpened] = useState(false);
  const [showSources, setShowSources] = useState(false);
  // Above the essay the checks start as chips, so the cover keeps its picture; unfold them to read them in words.
  const [findingsOpen, setFindingsOpen] = useState(false);
  const [decision, setDecision] = useState<DecisionState>({ step: 'choose' });
  const [stageHeight, setStageHeight] = useState(0);
  // The held revisions, for the cover's place in the hand and the move to the next one. Not needed to read this one.
  const list = useQuery({ ...reviewListQueryOptions(scope.api), staleTime: 30_000 });
  useDocumentTitle(review.document.title);

  const parsed = useMemo(() => parseScrollDocument(review.document), [review.document]);
  const document: ScrollDocumentV2 | ScrollDocumentV3 | undefined =
    parsed.kind === 'valid' && parsed.schema !== 'v1' ? parsed.document : undefined;
  const model = useMemo(() => {
    if (parsed.kind !== 'valid') return undefined;
    if (parsed.schema === 'v3') return readingModelOfV3(parsed.document);
    return parsed.schema === 'v2' ? readingModelOfV2(parsed.document) : undefined;
  }, [parsed]);
  const sources = useMemo(
    () => (document === undefined ? undefined : sourcesIndexOf(document, review.parts)),
    [document, review.parts],
  );

  const decided = useMutation({
    mutationFn: async (action: { readonly kind: 'release' } | { readonly kind: 'reject'; readonly reason: string }) =>
      action.kind === 'release' ? releaseReview(scope.api, target) : rejectReview(scope.api, target, action.reason),
    onMutate: (action) => setDecision({ step: 'sending', action: action.kind }),
    onSuccess: async (result) => {
      // A refusal is the gate's answer, not a failure: the revision is still held and the page stays.
      if (result.outcome === 'refused') {
        setDecision({ step: 'refused', words: refusalWords(result.reason) });
        return;
      }
      await queryClient.invalidateQueries({ queryKey: operatorReviewKey });
      backToList();
    },
    onError: (error) => setDecision(isReviewNotFound(error) ? { step: 'gone' } : { step: 'failed' }),
  });

  if (document === undefined || model === undefined || sources === undefined)
    return (
      <Frame>
        <ErrorState
          title="This revision cannot be read"
          body="Its stored document is not one this screen can draw. Reject it with the CLI, or leave it held."
        />
      </Frame>
    );

  const revisions = list.data?.revisions ?? [];
  const at = revisions.findIndex((item) => item.assetId === target.assetId && item.revision === target.revision);
  const previous = at > 0 ? revisions[at - 1] : undefined;
  const following = at >= 0 ? revisions[at + 1] : undefined;
  const cover = review.cover;
  const figure = cover === null ? undefined : figureOfCover(cover, `review-${target.assetId}`);
  const sourcesLabel = showSources ? 'Hide sources' : 'Show sources';

  return (
    <View role="main" style={[styles.ground, { paddingTop: insets.top + spacing[2] }]} testID="review-page">
      <View style={[styles.column, sideBySide ? styles.split : wide ? styles.wide : null]}>
        <View style={styles.bar}>
          <IconButton icon="back" label="Back to the list" onPress={backToList} testID="review-back" />
          <View style={styles.barWords}>
            <Text variant="monoXs" color={content.ink2}>{`Held · revision ${String(target.revision)}`}</Text>
            <Text variant="meta" color={content.ink2} numberOfLines={1}>
              {[heldSince(review.heldAt), review.recipe].filter((part) => part !== null).join(' · ')}
            </Text>
          </View>
          <Button
            label="Sources"
            accessibilityLabel={sourcesLabel}
            size="sm"
            variant="default"
            toggled={showSources}
            onPress={() => setShowSources((on) => !on)}
            testID="review-sources-toggle"
          />
        </View>
        <View style={sideBySide ? styles.row : styles.stack}>
          {sideBySide ? null : (
            <FindingsPanel review={review} expanded={findingsOpen} onToggle={() => setFindingsOpen((open) => !open)} />
          )}
          <View
            style={styles.stage}
            testID="review-stage"
            onLayout={(event: LayoutChangeEvent) => setStageHeight(Math.round(event.nativeEvent.layout.height))}
          >
            {stageHeight === 0 ? null : opened ? (
              <FolioReader
                key={`${target.assetId}:${String(target.revision)}`}
                model={model}
                commands={{}}
                stopFooter={showSources ? (unitId) => <SourcesUnder parts={sources.under(unitId)} /> : undefined}
                endSlot={
                  <View>
                    {showSources ? <SourcesAtEnd sources={sources} /> : null}
                    <DecisionPanel
                      title={document.title}
                      revision={target.revision}
                      coverage={review.coverage}
                      documentVersion={'sections' in document ? 'v3' : 'v2'}
                      state={decision}
                      onState={setDecision}
                      onRelease={() => decided.mutate({ kind: 'release' })}
                      onReject={(reason) => decided.mutate({ kind: 'reject', reason })}
                      onBackToList={backToList}
                    />
                  </View>
                }
              />
            ) : (
              <EssayCover
                kicker={cover?.kicker ?? document.kicker}
                title={document.title}
                dek={document.dek}
                minutes={cover?.readingMinutes ?? document.measures.readingMinutes}
                figure={figure}
                way="read"
                position={{ index: at >= 0 ? at + 1 : 1, count: Math.max(revisions.length, 1) }}
                next={following === undefined ? 'more' : { kicker: following.kicker, title: following.title }}
                onOpen={() => {
                  setOpened(true);
                  setFindingsOpen(false);
                }}
                onNext={() => router.replace(following === undefined ? LIST_HREF : reviewHref(following))}
                {...(previous === undefined ? {} : { onPrevious: () => router.replace(reviewHref(previous)) })}
                reducedMotion={reducedMotion}
                height={stageHeight}
                testID="essay-cover"
              />
            )}
          </View>
          {sideBySide ? (
            <ScrollView style={styles.aside} contentContainerStyle={styles.asideContent} testID="review-aside">
              <FindingsPanel review={review} expanded />
            </ScrollView>
          ) : null}
        </View>
      </View>
    </View>
  );
}

/**
 * `/operator/review/<assetId>/<revision>` (#780): the screen of one held revision. Anyone who is not an operator, and a
 * revision that is not held, is shown the unknown-page screen, as the server answers 404 to both.
 */
export function ReviewScroll({ scope }: { readonly scope: AccountScope }) {
  const params = useLocalSearchParams<{ assetId?: string; revision?: string }>();
  const target = targetOf(params);
  const show = useQuery({
    ...reviewShowQueryOptions(scope.api, target ?? { assetId: '', revision: 1 }),
    enabled: target !== undefined,
  });
  if (target === undefined) return <NotFoundScreen />;
  if (show.isError && isReviewNotFound(show.error)) return <NotFoundScreen />;
  if (show.isError)
    return (
      <Frame>
        <ErrorState
          title="Could not read this Scroll"
          body="The held revision could not be read. Nothing was changed."
          onRetry={() => void show.refetch()}
        />
      </Frame>
    );
  if (show.data === undefined)
    return (
      <Frame>
        <Skeleton rows={2} label="Loading the held Scroll" />
      </Frame>
    );
  return <ReviewBody scope={scope} target={target} review={show.data} />;
}

/** `/operator/review/[assetId]/[revision]`. */
export function ReviewScrollScreen() {
  const { state } = useAccountScope();
  if (state.status !== 'signed_in') return <NotFoundScreen />;
  return <ReviewScroll scope={state.scope} />;
}

const styles = StyleSheet.create({
  ground: { flex: 1, backgroundColor: content.paper, alignItems: 'center' },
  frameBar: { alignSelf: 'stretch', paddingHorizontal: layout.gutter, paddingBottom: spacing[3] },
  state: { alignSelf: 'stretch', paddingHorizontal: layout.gutter },
  column: { flex: 1, minHeight: 0, width: '100%', gap: spacing[2], paddingHorizontal: layout.gutter },
  wide: { maxWidth: Math.round(layout.measureDesktop * 1.7) + 2 * layout.gutter + spacing[8] },
  split: { maxWidth: 1440 },
  stack: { flex: 1, minHeight: 0, gap: spacing[2] },
  row: { flex: 1, minHeight: 0, flexDirection: 'row', gap: spacing[4] },
  aside: { width: layout.asideDesktop, flexGrow: 0, flexShrink: 0 },
  asideContent: { paddingBottom: spacing[6] },
  bar: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  barWords: { flex: 1, minWidth: 0 },
  stage: { flex: 1, minHeight: 0 },
});
