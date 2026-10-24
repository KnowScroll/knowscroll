import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  TALK_QUERY_KEY,
  answerThreadInvitation,
  invitationCardView,
  type AccountScope,
  type InvitationAnswer,
} from '@knowscroll/client-core';
import type { ThreadSummary } from '@knowscroll/contracts';
import { borderWidth, content, elevation, radius, spacing } from '@knowscroll/design-tokens';
import { Banner, Button, Icon, RowLink, Text } from '@knowscroll/ui';
import { newCommandId } from '../../platform/command-id';
import { threadHref } from './thread-links';

type InvitationResponse = 'join' | 'decline';

const failureNotice: Record<Exclude<InvitationAnswer, 'done' | 'ended'>, { lead: string; message: string }> = {
  unavailable: { lead: 'This invitation isn’t available any more.', message: 'It was answered or it ended.' },
  offline: { lead: 'Couldn’t reach KnowScroll.', message: 'Nothing changed. Try again.' },
  failed: { lead: 'Couldn’t answer this invitation.', message: 'Nothing changed. Try again.' },
};

/**
 * C03's new-thread card in Talk: who started the thread and what it is about, "Preview the thread"
 * (the invitation screen, read-only), Join thread and Ignore. Ignore is the same decline the
 * invitation screen sends; it ends the invitation for this person alone and tells nobody. A retry
 * after an unknown outcome reuses the command's ID, so it cannot answer twice.
 */
export function InvitationCard({ scope, item }: { readonly scope: AccountScope; readonly item: ThreadSummary }) {
  const router = useRouter();
  const client = useQueryClient();
  const view = invitationCardView(item);
  const href = threadHref(item.thread);
  const [answering, setAnswering] = useState<InvitationResponse>();
  const [notice, setNotice] = useState<keyof typeof failureNotice>();
  const commandIds = useRef<Partial<Record<InvitationResponse, string>>>({});

  const answer = async (response: InvitationResponse) => {
    if (answering !== undefined) return;
    const commandId = (commandIds.current[response] ??= newCommandId());
    setAnswering(response);
    setNotice(undefined);
    const outcome = await answerThreadInvitation(scope, item.thread, response, commandId);
    if (outcome === 'ended') return;
    setAnswering(undefined);
    if (outcome === 'done') {
      commandIds.current = {};
      if (response === 'join') router.push(href);
    } else {
      if (outcome === 'unavailable') commandIds.current = {};
      setNotice(outcome);
    }
    // The card goes when the invitation does: read Talk again whatever happened.
    if (outcome === 'done' || outcome === 'unavailable')
      void client.invalidateQueries({ queryKey: scope.queryKey(TALK_QUERY_KEY) });
  };

  const place = view.kind === undefined ? 'it' : view.kind === 'reel' ? 'each Reel' : 'each Scroll';
  return (
    <View role="region" aria-label={`New thread: ${view.heading}`} style={styles.card} testID="thread-invitation">
      <View style={styles.top}>
        <View style={styles.tile} aria-hidden>
          <Icon name={view.kind === 'scroll' ? 'scroll' : 'reel'} size={24} color={content.paper} />
        </View>
        <View style={styles.titles}>
          <Text variant="monoXs" color={content.ink2}>
            NEW THREAD
          </Text>
          <Text variant="ui">{view.heading}</Text>
          <Text variant="meta" color={content.ink2}>
            {view.detail}
          </Text>
        </View>
      </View>
      <View style={styles.privacy}>
        <Icon name="lock" size={16} color={content.ink} />
        <Text variant="meta" style={styles.privacyText}>
          Your universe and history aren’t shared. You keep your own place in {place}.
        </Text>
      </View>
      <RowLink label="Preview the thread" href={href} onPress={() => router.push(href)} testID="preview-thread">
        <Text variant="uiS" color={content.accent} style={styles.link}>
          Preview the thread
        </Text>
      </RowLink>
      {notice === undefined ? null : (
        <Banner kind="error" lead={failureNotice[notice].lead} message={failureNotice[notice].message} />
      )}
      <View style={styles.actions}>
        <View style={styles.action}>
          <Button
            label="Join thread"
            variant="primary"
            fullWidth
            busy={answering === 'join'}
            busyLabel="Joining"
            disabled={answering === 'decline'}
            onPress={() => void answer('join')}
            testID="join-thread"
          />
        </View>
        <View style={styles.action}>
          <Button
            label="Ignore"
            fullWidth
            busy={answering === 'decline'}
            busyLabel="Ignoring"
            disabled={answering === 'join'}
            onPress={() => void answer('decline')}
            testID="ignore-thread"
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing[3],
    padding: spacing[4],
    marginBottom: spacing[4],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.panel,
    backgroundColor: content.paper,
    boxShadow: elevation.hint,
  },
  top: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  tile: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    backgroundColor: content.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titles: { flex: 1, gap: spacing['0.5'] },
  privacy: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing[2],
    padding: spacing[3],
    borderWidth: borderWidth.hairline,
    borderColor: content.rule,
    borderRadius: radius.md,
  },
  privacyText: { flex: 1 },
  link: { textDecorationLine: 'underline' },
  actions: { flexDirection: 'row', gap: spacing[3] },
  action: { flex: 1 },
});
