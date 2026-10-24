import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { useMemo, useState } from 'react';
import { createScopedBlockStateStore, type AccountScope } from '@knowscroll/client-core';
import type { ContentThreadRef } from '@knowscroll/contracts';
import { Banner, Button, StateBlock } from '@knowscroll/ui';
import { useAccountScope } from '../../providers/account-scope';
import { ShareFromScrollSheet } from './share-from-scroll-sheet';
import { OpenScroll, ThreadScrollArticle } from './scroll-open';
import { threadHref, threadRefFromParams } from './thread-links';
import { useSnippetSend } from './use-snippet-send';

function ReaderBody({
  scope,
  thread,
  assetId,
}: {
  readonly scope: AccountScope;
  readonly thread: ContentThreadRef;
  readonly assetId: string;
}) {
  const router = useRouter();
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
            floating={
              send.status === 'sent' ? undefined : (
                <Button label="Share from this Scroll" icon="share" size="sm" onPress={() => setSharing(true)} testID="share-from-scroll" />
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
}) {
  const { state } = useAccountScope();
  const router = useRouter();
  const thread = threadRefFromParams(params);
  if (state.status !== 'signed_in' || thread === undefined)
    return (
      <StateBlock
        title="This Scroll isn’t available here"
        body="Open it from the thread."
        actions={[{ label: 'Back', onPress: () => (router.canGoBack() ? router.back() : router.replace('/conversations')) }]}
      />
    );
  return <ReaderBody scope={state.scope} thread={thread} assetId={params.assetId.toLowerCase()} />;
}
