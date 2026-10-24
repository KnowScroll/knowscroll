import { useEffect, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { talkFailure, type AccountScope, type StartDiscussion } from '@knowscroll/client-core';
import { SavedPageResponseSchema, type SavedPageResponse } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { BottomSheet, Button, Skeleton, Text, useTypeStyle } from '@knowscroll/ui';

type SavedItem = SavedPageResponse['items'][number];
const TITLE_MAX = 80;

/** The kept Reels and Scrolls a person can bring into a room: the current, admitted revisions only. */
function useKept(scope: AccountScope, enabled: boolean) {
  const [state, setState] = useState<
    | { readonly status: 'loading' }
    | { readonly status: 'failed' }
    | { readonly status: 'ready'; readonly items: readonly SavedItem[] }
  >({ status: 'loading' });
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    scope.api.experience
      .listSaved({ pagination: 'saved-page.v1', filter: 'all', limit: '20' })
      .then((page) => {
        if (!current) return;
        const parsed = SavedPageResponseSchema.parse(page);
        setState({ status: 'ready', items: parsed.items.filter((item) => item.availability === 'available') });
      })
      .catch((error: unknown) => {
        if (current && talkFailure(error) !== 'ended') setState({ status: 'failed' });
      });
    return () => {
      current = false;
    };
  }, [scope, enabled]);
  return state;
}

/**
 * R02 "Share into room": start a discussion in words, or bring in something the person kept, which
 * makes a content thread everyone in the room can open. Sharing is conversation: it is not a
 * recommendation, and it records nothing about anyone's reading.
 */
export function ShareIntoRoomSheet({
  scope,
  visible,
  working,
  onStart,
  onClose,
}: {
  readonly scope: AccountScope;
  readonly visible: boolean;
  readonly working: boolean;
  readonly onStart: (start: StartDiscussion) => void;
  readonly onClose: () => void;
}) {
  const type = useTypeStyle('bodyS');
  const [title, setTitle] = useState('');
  const kept = useKept(scope, visible);
  const trimmed = title.trim();
  return (
    <BottomSheet visible={visible} title="Share into the room" onClose={onClose}>
      <View style={styles.body}>
        <Text variant="ui">Start a discussion</Text>
        <TextInput
          accessibilityLabel="Discussion title"
          placeholder="What do you want to talk about?"
          placeholderTextColor={content.ink2}
          value={title}
          onChangeText={setTitle}
          maxLength={TITLE_MAX}
          allowFontScaling={false}
          style={[styles.input, { fontFamily: type.fontFamily, fontSize: type.fontSize, lineHeight: type.lineHeight }]}
        />
        <Button
          label="Start discussion"
          variant="primary"
          disabled={trimmed === '' || working}
          busy={working}
          busyLabel="Starting"
          onPress={() => onStart({ kind: 'topic', title: trimmed })}
        />
        <Text variant="ui">Or share something you kept</Text>
        {kept.status === 'loading' ? <Skeleton rows={2} label="Loading what you kept" /> : null}
        {kept.status === 'failed' ? (
          <Text variant="meta" color={content.ink2}>
            Can’t load what you kept right now.
          </Text>
        ) : null}
        {kept.status === 'ready' && kept.items.length === 0 ? (
          <Text variant="meta" color={content.ink2}>
            Nothing kept yet. Keep a Reel or a Scroll, then bring it here.
          </Text>
        ) : null}
        {kept.status === 'ready'
          ? kept.items.map((item) => (
              <Button
                key={`${item.assetId}:${String(item.assetRevision)}`}
                label={item.metadata?.title ?? 'Kept item'}
                icon={item.kind === 'reel' ? 'reel' : 'scroll'}
                variant="default"
                disabled={working}
                onPress={() =>
                  onStart({ kind: 'content', root: { assetId: item.assetId, assetRevision: item.assetRevision } })
                }
              />
            ))
          : null}
        <Text variant="meta" color={content.ink2}>
          Sharing starts a thread people in the room can open. It doesn’t tell anyone what you’ve watched.
        </Text>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing[3] },
  input: {
    minHeight: 48,
    paddingHorizontal: spacing[4],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.pill,
    backgroundColor: content.paper,
    color: content.ink,
  },
});
