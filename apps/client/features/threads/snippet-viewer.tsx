import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  createScopedBlockStateStore,
  findThread,
  formatRange,
  overlayBlockState,
  talkFailure,
  type AccountScope,
} from '@knowscroll/client-core';
import type { ContentThreadRef, ThreadSnippetOpening } from '@knowscroll/contracts';
import { borderWidth, content, layout, radius, spacing, status } from '@knowscroll/design-tokens';
import { Banner, Button, Skeleton, StateBlock, Tag, Text } from '@knowscroll/ui';
import { newCommandId } from '../../platform/command-id';
import { useAccountScope } from '../../providers/account-scope';
import { writeResume } from '../encounter/encounter-history';
import { ReelEncounter } from './reel-encounter';
import { OpenScroll, ThreadScrollArticle } from './scroll-open';
import { threadHref, threadRefFromParams } from './thread-links';

type Opening = Extract<ThreadSnippetOpening, { status: 'ready' }>;
type Changed = Extract<ThreadSnippetOpening, { status: 'changed' }>;

const kindWord = (kind: 'reel' | 'scroll') => (kind === 'reel' ? 'Reel' : 'Scroll');

/** "This Reel was corrected and this moment changed": the old moment is never played, the current content is offered. */
function ChangedMoment({ opening, onBack }: { readonly opening: Changed; readonly onBack: () => void }) {
  const router = useRouter();
  const word = kindWord(opening.current.kind);
  return (
    <View style={styles.card}>
      <Tag variant="corrected" label="Corrected · moment changed" />
      <Text variant="title" heading={1}>
        This {word} was corrected and this moment changed
      </Text>
      <Text variant="bodyS" color={content.ink2}>
        The moment that was shared is no longer there as it was. The current {word}, “{opening.current.title}”, is
        open to you.
      </Text>
      <View style={styles.actions}>
        <Button
          label={`${opening.current.kind === 'reel' ? 'Watch' : 'Open'} the revised ${word}`}
          variant="primary"
          onPress={() => router.push(`/${opening.current.kind}/${opening.current.assetId}`)}
        />
        <Button label="Back to thread" variant="ghost" onPress={onBack} />
      </View>
    </View>
  );
}

/** A Reel moment: the poster and Play, then the range plays and pauses at its end. Replay and Watch from here follow. */
function ReelMoment({
  scope,
  opening,
  onBack,
}: {
  readonly scope: AccountScope;
  readonly opening: Opening;
  readonly onBack: () => void;
}) {
  const router = useRouter();
  if (opening.anchor.kind !== 'reel_range') return null;
  const { startMs, endMs } = opening.anchor;
  const watchFromHere = () => {
    // The full Reel opens at the start of the moment, as this person's own encounter.
    writeResume(scope, opening.content.assetId, opening.content.assetRevision, {
      kind: 'reel',
      positionMs: startMs,
      playing: false,
      muted: false,
    });
    router.push(`/reel/${opening.content.assetId}`);
  };
  return (
    <View style={styles.card}>
      <Text variant="monoXs" color={content.ink2}>
        {formatRange(startMs, endMs)} of the Reel
      </Text>
      <Text variant="title" heading={1}>
        {opening.content.title}
      </Text>
      <ReelEncounter
        scope={scope}
        assetId={opening.content.assetId}
        title={opening.content.title}
        moment={{ startMs, endMs }}
        active
        afterEnd={<Button label="Watch from here" variant="ghost" onPress={watchFromHere} />}
      />
      <View style={styles.actions}>
        <Button label="Watch from here" variant="ghost" onPress={watchFromHere} />
        <Button label="Back to thread" onPress={onBack} />
      </View>
    </View>
  );
}

/** A passage or a block of a Scroll: an introduction first (opening it is not reading it), then the Scroll at that place. */
function ScrollSnippet({
  scope,
  opening,
  onBack,
}: {
  readonly scope: AccountScope;
  readonly opening: Opening;
  readonly onBack: () => void;
}) {
  const [reading, setReading] = useState(false);
  const base = useMemo(() => createScopedBlockStateStore(scope.storage), [scope]);
  const { anchor } = opening;
  if (anchor.kind === 'reel_range') return null;
  if (!reading)
    return (
      <View style={styles.card}>
        <Text variant="monoXs" color={content.ink2}>
          {anchor.kind === 'scroll_passage' ? 'Passage' : 'Shared part'} · {opening.content.title}
        </Text>
        {anchor.kind === 'scroll_passage' ? (
          <Text variant="body" style={styles.quote}>
            “{anchor.quote}”
          </Text>
        ) : (
          <>
            <Text variant="title" heading={1}>
              {anchor.label ?? opening.content.title}
            </Text>
            <Text variant="bodyS" color={content.ink2}>
              {anchor.snapshot === undefined
                ? 'The settings were not included.'
                : anchor.description === undefined || anchor.description === ''
                  ? 'Shared as the sender set it.'
                  : `Set as: ${anchor.description}`}
            </Text>
          </>
        )}
        {opening.mapped ? (
          <Banner kind="corrected" lead="Updated." message="The Scroll changed after this was shared; this is where it is now." />
        ) : null}
        {opening.settingsReset ? (
          <Banner kind="info" lead="Settings reset." message="The block changed, so it starts from its own default settings." />
        ) : null}
        <View style={styles.actions}>
          <Button
            label={anchor.kind === 'scroll_passage' ? 'Read in context' : anchor.snapshot === undefined ? 'Open it' : 'Open as set'}
            variant="primary"
            onPress={() => setReading(true)}
            testID="open-snippet-scroll"
          />
          <Button label="Back to thread" variant="ghost" onPress={onBack} />
        </View>
      </View>
    );
  return (
    <OpenScroll scope={scope} assetId={opening.content.assetId} onBack={onBack}>
      {(scroll) => (
        <ThreadScrollArticle
          scope={scope}
          scroll={scroll}
          anchorBlockId={anchor.blockId}
          store={
            anchor.kind === 'scroll_block'
              ? overlayBlockState(base, scroll.document, anchor.blockId, anchor.snapshot)
              : base
          }
          afterHeader={
            anchor.kind === 'scroll_passage' ? (
              <View style={styles.passage}>
                <Text variant="meta" color={content.ink2}>
                  Shared passage
                </Text>
                <Text variant="bodyS" style={styles.quote}>
                  “{anchor.quote}”
                </Text>
              </View>
            ) : undefined
          }
        />
      )}
    </OpenScroll>
  );
}

function Opened({
  scope,
  opening,
  onBack,
}: {
  readonly scope: AccountScope;
  readonly opening: Exclude<ThreadSnippetOpening, { status: 'unavailable' }>;
  readonly onBack: () => void;
}) {
  if (opening.status === 'changed') return <ChangedMoment opening={opening} onBack={onBack} />;
  return opening.anchor.kind === 'reel_range' ? (
    <ReelMoment scope={scope} opening={opening} onBack={onBack} />
  ) : (
    <ScrollSnippet scope={scope} opening={opening} onBack={onBack} />
  );
}

type Loaded =
  | { readonly phase: 'loading' | 'failed' | 'unavailable' }
  | { readonly phase: 'opened'; readonly opening: Exclude<ThreadSnippetOpening, { status: 'unavailable' }> };

function Viewer({
  scope,
  thread,
  messageId,
}: {
  readonly scope: AccountScope;
  readonly thread: ContentThreadRef;
  readonly messageId: string;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [loaded, setLoaded] = useState<Loaded>({ phase: 'loading' });
  const back = () => (router.canGoBack() ? router.back() : router.replace(threadHref(thread)));
  useEffect(() => {
    let stopped = false;
    void scope.api.threads
      .openSnippet({ version: 'content-thread.v1', readId: newCommandId(), thread, messageId })
      .then((opening) => {
        if (!stopped) setLoaded(opening.status === 'unavailable' ? { phase: 'unavailable' } : { phase: 'opened', opening });
      })
      .catch((error: unknown) => {
        const kind = talkFailure(error);
        if (!stopped && kind !== 'ended') setLoaded({ phase: kind === 'unavailable' ? 'unavailable' : 'failed' });
      });
    return () => {
      stopped = true;
    };
  }, [scope, thread, messageId]);

  if (loaded.phase === 'loading')
    return (
      <View style={[styles.screen, { paddingTop: insets.top + spacing[4] }]}>
        <Skeleton rows={3} label="Opening the snippet" />
      </View>
    );
  if (loaded.phase !== 'opened')
    return (
      <View style={[styles.screen, { paddingTop: insets.top + spacing[4] }]}>
        <StateBlock
          title={loaded.phase === 'failed' ? 'Can’t open this right now' : 'This isn’t available any more'}
          body={
            loaded.phase === 'failed'
              ? 'Check your connection and try again.'
              : 'It may have been withdrawn, or you may no longer have access to this thread.'
          }
          actions={[{ label: 'Back to thread', onPress: back }]}
        />
      </View>
    );
  // A reader takes the whole screen; every other view sits in a scrolling column.
  const opening = loaded.opening;
  if (opening.status === 'ready' && opening.anchor.kind !== 'reel_range')
    return <Opened scope={scope} opening={opening} onBack={back} />;
  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={[styles.screen, { paddingTop: insets.top + spacing[4], paddingBottom: insets.bottom + spacing[6] }]}
    >
      <Opened scope={scope} opening={opening} onBack={back} />
    </ScrollView>
  );
}

/**
 * H03 "Open a snippet": a focused viewer over the thread. It is not a history entry of the thread:
 * Back returns to the same message. Showing it is not an encounter; Play and Read are, of the original
 * Reel or Scroll. A corrected source says whether the moment holds and never plays the old one.
 */
export function SnippetViewerScreen(params: {
  readonly threadId: string;
  readonly messageId: string;
  readonly m?: string | undefined;
  readonly r?: string | undefined;
}) {
  const { state } = useAccountScope();
  const router = useRouter();
  const carried = threadRefFromParams(params);
  const [found, setFound] = useState<ContentThreadRef | undefined>();
  const scope = state.status === 'signed_in' ? state.scope : undefined;
  useEffect(() => {
    if (scope === undefined || carried !== undefined) return;
    void findThread(scope, newCommandId, params.threadId).then(setFound, () => undefined);
  }, [scope, carried, params.threadId]);
  const thread = carried ?? found;
  if (scope === undefined || thread === undefined)
    return (
      <StateBlock
        title="Open this from the thread"
        actions={[{ label: 'Back', onPress: () => (router.canGoBack() ? router.back() : router.replace('/conversations')) }]}
      />
    );
  return <Viewer key={params.messageId} scope={scope} thread={thread} messageId={params.messageId} />;
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: content.paper },
  screen: { gap: spacing[4], paddingHorizontal: layout.gutter, backgroundColor: content.paper, width: '100%', maxWidth: layout.measureDesktop, alignSelf: 'center' },
  card: {
    gap: spacing[3],
    padding: spacing[4],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.panel,
    backgroundColor: content.paper,
    alignItems: 'flex-start',
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  quote: { fontStyle: 'italic' },
  passage: {
    gap: spacing[1],
    padding: spacing[3],
    borderLeftWidth: 4,
    borderLeftColor: status.hypothetical.edge,
    backgroundColor: content.highlight,
    borderRadius: radius.md,
  },
});
