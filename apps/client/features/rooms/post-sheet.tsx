import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import {
  emptyPostDraft,
  postDraftReady,
  postRefusalWords,
  type AccountScope,
  type PostDraft,
  type PostOutcome,
} from '@knowscroll/client-core';
import { ROOM_POST_TITLE_MAX_CHARS, ROOM_POST_WORDS_MAX_CHARS, ROOM_SOURCE_MAX_CHARS } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Banner, BottomSheet, Button, Skeleton, Text } from '@knowscroll/ui';
import { FormField } from './form-field';
import { useKept } from './use-kept';

type LinkMode = 'kept' | 'source';

/**
 * "+ Post" (T3 "People and residents mixed"): a member's own find for the room's Feed. Their headline and words, and one link: a Reel
 * or Scroll they kept, or a source, the plain address of a page. Nothing is sent until they press Post, no model writes any of it and
 * a link in the words is refused, because the one link a post has is the checked one. A source is not opened or previewed here or
 * anywhere; it is shown as a plain link. Posting is conversation: it tells nobody what the member has watched or read.
 */
export function PostSheet({
  scope,
  visible,
  working,
  postsPerDay,
  onPost,
  onOpenExisting,
  onClose,
}: {
  readonly scope: AccountScope;
  readonly visible: boolean;
  readonly working: boolean;
  /** How many posts one member may make in this room on a UTC day, from the server's own numbers. */
  readonly postsPerDay: number;
  readonly onPost: (draft: PostDraft) => Promise<PostOutcome>;
  /** Opens a post the room already had about the same asset or source. */
  readonly onOpenExisting: (discussionId: string) => void;
  readonly onClose: () => void;
}) {
  const [draft, setDraft] = useState<PostDraft>(emptyPostDraft);
  const [mode, setMode] = useState<LinkMode>('kept');
  const [source, setSource] = useState('');
  const [problem, setProblem] = useState<string>();
  const [existing, setExisting] = useState<string>();
  const kept = useKept(scope, visible && mode === 'kept');
  const chosen = draft.link?.kind === 'content' ? draft.link.target : undefined;
  const ready = postDraftReady(draft) && !working;

  const pickMode = (next: LinkMode) => {
    setMode(next);
    setProblem(undefined);
    setExisting(undefined);
    setDraft({
      ...draft,
      link: next === 'source' ? (source.trim() === '' ? undefined : { kind: 'source', url: source }) : undefined,
    });
  };

  const send = async () => {
    setProblem(undefined);
    setExisting(undefined);
    const outcome = await onPost(draft);
    if (outcome.kind === 'posted') {
      setDraft(emptyPostDraft);
      setSource('');
      onClose();
    } else if (outcome.kind === 'already_there') setExisting(outcome.discussionId);
    else setProblem(postRefusalWords[outcome.kind]);
  };

  return (
    <BottomSheet visible={visible} title="Post a find" onClose={onClose} testID="post-sheet">
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <FormField
          label="Headline"
          value={draft.title}
          onChange={(title) => setDraft({ ...draft, title })}
          maxLength={ROOM_POST_TITLE_MAX_CHARS}
          testID="post-title"
        />
        <FormField
          label="Your words"
          value={draft.words}
          onChange={(words) => setDraft({ ...draft, words })}
          maxLength={ROOM_POST_WORDS_MAX_CHARS}
          multiline
          hint="Say why it is worth a look. Put the link below, not here."
          testID="post-words"
        />
        <View style={styles.modes} role="group" accessibilityLabel="What you found">
          <Button
            label="Something you kept"
            size="sm"
            variant={mode === 'kept' ? 'ink' : 'default'}
            toggled={mode === 'kept'}
            onPress={() => pickMode('kept')}
            testID="post-mode-kept"
          />
          <Button
            label="A source link"
            size="sm"
            variant={mode === 'source' ? 'ink' : 'default'}
            toggled={mode === 'source'}
            onPress={() => pickMode('source')}
            testID="post-mode-source"
          />
        </View>
        {mode === 'source' ? (
          <FormField
            label="Source address"
            value={source}
            onChange={(url) => {
              setSource(url);
              setDraft({ ...draft, link: url.trim() === '' ? undefined : { kind: 'source', url } });
            }}
            maxLength={ROOM_SOURCE_MAX_CHARS}
            hint="The plain address of a page, starting with http or https. It is shown as a link and never opened for you."
            testID="post-source"
          />
        ) : (
          <View style={styles.kept}>
            {kept.status === 'loading' ? <Skeleton rows={2} label="Loading what you kept" /> : null}
            {kept.status === 'failed' ? (
              <Text variant="metaS" color={content.ink2}>
                Can’t load what you kept right now.
              </Text>
            ) : null}
            {kept.status === 'ready' && kept.items.length === 0 ? (
              <Text variant="metaS" color={content.ink2}>
                Nothing kept yet. Keep a Reel or a Scroll, then post it here, or post a source link.
              </Text>
            ) : null}
            {kept.status === 'ready'
              ? kept.items.map((item) => {
                  const picked = chosen?.assetId === item.assetId;
                  return (
                    <Button
                      key={`${item.assetId}:${String(item.assetRevision)}`}
                      label={item.metadata?.title ?? 'Kept item'}
                      icon={item.kind === 'reel' ? 'reel' : 'scroll'}
                      variant={picked ? 'ink' : 'default'}
                      toggled={picked}
                      onPress={() =>
                        setDraft({
                          ...draft,
                          link: {
                            kind: 'content',
                            target: { assetId: item.assetId, assetRevision: item.assetRevision },
                          },
                        })
                      }
                    />
                  );
                })
              : null}
          </View>
        )}
        {problem === undefined ? null : <Banner kind="error" lead="Not posted." message={problem} />}
        {existing === undefined ? null : (
          <View style={styles.existing} testID="post-existing">
            <Text variant="bodyS">The room already has a post about that. Open it to vote or reply.</Text>
            <Button
              label="Open it"
              size="sm"
              variant="default"
              onPress={() => {
                onOpenExisting(existing);
                onClose();
              }}
              testID="post-existing-open"
            />
          </View>
        )}
        <Button
          label="Post"
          variant="primary"
          disabled={!ready}
          busy={working}
          busyLabel="Posting"
          onPress={() => void send()}
          testID="post-send"
        />
        <Text variant="metaS" color={content.ink2}>
          {`Your headline and words are yours; no AI writes or changes them. You can post ${String(postsPerDay)} a day in this room. A post is not a record of what you watched.`}
        </Text>
      </ScrollView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing[3], paddingBottom: spacing[4] },
  modes: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  kept: { gap: spacing[2] },
  existing: {
    gap: spacing[2],
    padding: spacing[3],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.card,
    backgroundColor: content.highlight,
  },
});
