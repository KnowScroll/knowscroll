import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { readRoomReports, type AccountScope } from '@knowscroll/client-core';
import type { RoomReports } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Text } from '@knowscroll/ui';
import { newCommandId } from '../../platform/command-id';
import { ABUSE_CHOICES } from '../feedback/feedback-copy';
import { discussionHref } from './room-links';

const reasonLabel = (category: string): string =>
  ABUSE_CHOICES.find((choice) => choice.value === category)?.label ?? category;

/**
 * The messages of this room people have reported, for its moderators (P03, D-055): which message, why and how
 * often, newest first, with a way to open the discussion it is in. It names nobody: not who reported, not what
 * they wrote, not the author. Reading it tells no one. Nothing here is acted on for the moderator.
 */
export function ReportedMessages({ scope, roomId }: { readonly scope: AccountScope; readonly roomId: string }) {
  const router = useRouter();
  const [reports, setReports] = useState<RoomReports['reports'] | 'failed'>();
  useEffect(() => {
    let live = true;
    readRoomReports(scope, newCommandId, roomId).then(
      (found) => live && setReports(found),
      () => live && setReports('failed'),
    );
    return () => {
      live = false;
    };
  }, [scope, roomId]);
  if (reports === undefined) return null;
  return (
    <View style={styles.list} testID="reported-messages">
      <Text variant="metaS" color={content.ink2}>
        Reported messages
      </Text>
      {reports === 'failed' ? (
        <Text variant="meta" color={content.ink2}>
          Reports couldn’t be read right now.
        </Text>
      ) : reports.length === 0 ? (
        <Text variant="meta" color={content.ink2}>
          No message in this room has been reported.
        </Text>
      ) : (
        reports.map((report) => (
          <Pressable
            key={report.messageId}
            role="link"
            accessibilityRole="link"
            accessibilityLabel={`Message ${String(report.sequence)} in ${report.discussionTitle}, reported ${String(report.count)} ${report.count === 1 ? 'time' : 'times'}`}
            onPress={() => router.push(discussionHref(roomId, report.discussionId))}
            style={styles.row}
          >
            <Text variant="uiS">{`Message ${String(report.sequence)} · ${report.discussionTitle}`}</Text>
            <Text variant="metaS" color={content.ink2}>
              {`${report.categories.map(reasonLabel).join(', ')} · ${String(report.count)} ${report.count === 1 ? 'report' : 'reports'}`}
            </Text>
          </Pressable>
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing[2] },
  row: {
    gap: spacing['0.5'],
    padding: spacing[3],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.card,
    backgroundColor: content.paper,
    cursor: 'pointer' as const,
  },
});
