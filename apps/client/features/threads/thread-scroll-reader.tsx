import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  createScopedBlockStateStore,
  createThreadPlaces,
  type AccountScope,
  type ThreadPlacesController,
} from '@knowscroll/client-core';
import type { ContentThreadRef } from '@knowscroll/contracts';
import { content, spacing } from '@knowscroll/design-tokens';
import { Banner, Button, StateBlock, Text } from '@knowscroll/ui';
import { newCommandId } from '../../platform/command-id';
import { useAccountScope } from '../../providers/account-scope';
import { ShareFromScrollSheet } from './share-from-scroll-sheet';
import { OpenScroll, ThreadScrollArticle } from './scroll-open';
import { partFromParam, threadHref, threadRefFromParams } from './thread-links';
import { useSnippetSend } from './use-snippet-send';

/**
 * The foot of a Scroll that is a part of a series (D-065): "I've finished this part" tells the thread, from
 * this reader only. A Scroll cannot tell that it was read to the end, so the person says so; a person who
 * hides where they are is not asked to tell anyone.
 */
function FinishedPart({ places, part }: { readonly places: ThreadPlacesController; readonly part: number }) {
  const state = useSyncExternalStore(places.subscribe, places.getState, places.getState);
  const [told, setTold] = useState(false);
  if (state.phase === 'unavailable') return null;
  return (
    <View style={styles.finished} testID="finished-part" accessibilityLiveRegion="polite">
      {told ? (
        <Text variant="bodyS">
          {state.hidden
            ? `You hide where you are, so the thread isn’t told you finished Part ${String(part)}.`
            : `The thread can see you finished Part ${String(part)}.`}
        </Text>
      ) : (
        <>
          <Text variant="bodyS">Finished this part?</Text>
          <Button
            label="I’ve finished this part"
            icon="check"
            variant="primary"
            onPress={() => {
              void places.report(part, 'finished');
              setTold(true);
            }}
          />
        </>
      )}
    </View>
  );
}

function ReaderBody({
  scope,
  thread,
  assetId,
  part,
}: {
  readonly scope: AccountScope;
  readonly thread: ContentThreadRef;
  readonly assetId: string;
  /** The part of the thread's series this Scroll is, when the address says so. */
  readonly part: number | undefined;
}) {
  const router = useRouter();
  const [places] = useState(() => createThreadPlaces({ scope, thread, newId: newCommandId }));
  useEffect(() => {
    if (part !== undefined) void places.load();
  }, [part, places]);
  const [sharing, setSharing] = useState(false);
  const send = useSnippetSend(scope, thread);
  const store = useMemo(() => createScopedBlockStateStore(scope.storage), [scope]);
  const backToThread = () => router.replace(threadHref(thread));
  return (
    <OpenScroll scope={scope} assetId={assetId} onBack={() => router.back()}>
      {(scroll) => (
        <>
          <ThreadScrollArticle
            scope={scope}
            scroll={scroll}
            store={store}
            endSlot={part === undefined ? undefined : <FinishedPart places={places} part={part} />}
            floating={
              send.status === 'sent' ? undefined : (
                <Button
                  label="Share from this Scroll"
                  icon="share"
                  size="sm"
                  onPress={() => setSharing(true)}
                  testID="share-from-scroll"
                />
              )
            }
            afterHeader={
              send.status === 'sent' ? (
                <View accessibilityLiveRegion="polite">
                  <Banner kind="info" lead="Shared to the thread." message="Your friends can open it from there." />
                  <Button label="Back to the thread" variant="primary" onPress={backToThread} />
                </View>
              ) : undefined
            }
          />
          <ShareFromScrollSheet
            visible={sharing && send.status !== 'sent'}
            document={scroll.document}
            store={store}
            threadName="this thread"
            status={send.status}
            onClose={() => setSharing(false)}
            onShare={(anchor, note) =>
              void send
                .send({
                  kind: 'snippet',
                  target: { assetId: scroll.assetId, assetRevision: scroll.assetRevision },
                  anchor,
                  ...(note === '' ? {} : { note }),
                })
                .then(() => setSharing(false))
            }
          />
        </>
      )}
    </OpenScroll>
  );
}

/**
 * `/threads/<id>/read/<assetId>`: a Scroll of the thread, read in full, with a way to share a
 * passage or a block back into the thread. Reading here is an ordinary encounter of the original
 * Scroll; the share control only writes a message into the thread.
 */
export function ThreadScrollReaderScreen(params: {
  readonly threadId: string;
  readonly assetId: string;
  readonly m?: string | undefined;
  readonly r?: string | undefined;
  readonly p?: string | undefined;
}) {
  const { state } = useAccountScope();
  const router = useRouter();
  const thread = threadRefFromParams(params);
  if (state.status !== 'signed_in' || thread === undefined)
    return (
      <StateBlock
        title="This Scroll isn’t available here"
        body="Open it from the thread."
        actions={[
          { label: 'Back', onPress: () => (router.canGoBack() ? router.back() : router.replace('/conversations')) },
        ]}
      />
    );
  return (
    <ReaderBody
      scope={state.scope}
      thread={thread}
      assetId={params.assetId.toLowerCase()}
      part={partFromParam(params.p)}
    />
  );
}

const styles = StyleSheet.create({
  finished: {
    gap: spacing[3],
    padding: spacing[4],
    borderRadius: 16,
    borderWidth: 2,
    borderColor: content.ink,
    backgroundColor: content.paper,
    alignItems: 'flex-start',
  },
});
