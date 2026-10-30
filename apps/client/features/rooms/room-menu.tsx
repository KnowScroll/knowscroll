import { useRouter } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { AccountScope, RoomController, RoomState } from '@knowscroll/client-core';
import type { RoomAiLevel, RoomView } from '@knowscroll/contracts';
import { borderWidth, content, spacing } from '@knowscroll/design-tokens';
import { BottomSheet, Button, Icon, Text } from '@knowscroll/ui';
import { afterPendingBack } from '../../platform/after-pending-back';
import { AiHere } from './ai-here';
import { activitiesHref } from './room-links';
import { ModeratorTools, RULE_WORDS, WhoIsHere } from './room-parts';
import { TopicsList } from './topics-list';

type Member = Extract<RoomView, { status: 'member' }>;
type Page = 'root' | 'about' | 'guidelines' | 'ai' | 'pins' | 'topics' | 'moderation';

const LEVEL_WORDS: Record<RoomAiLevel, string> = { lively: 'Lively', quieter: 'Quieter', off: 'Off' };

function MenuRow({
  label,
  value,
  onPress,
  testID,
}: {
  readonly label: string;
  readonly value?: string;
  readonly onPress?: () => void;
  readonly testID?: string;
}) {
  const inner = (
    <>
      <Text variant="ui">{label}</Text>
      <View style={styles.rowEnd}>
        {value === undefined ? null : (
          <Text variant="meta" color={content.ink2}>
            {value}
          </Text>
        )}
        {onPress === undefined ? null : <Icon name="forward" size={16} color={content.ink2} />}
      </View>
    </>
  );
  return onPress === undefined ? (
    <View
      style={styles.row}
      accessible
      accessibilityLabel={value === undefined ? label : `${label}, ${value}`}
      testID={testID}
    >
      {inner}
    </View>
  ) : (
    <Pressable role="button" onPress={onPress} style={styles.row} testID={testID}>
      {inner}
    </Pressable>
  );
}

function PageFrame({
  title,
  onBack,
  children,
}: {
  readonly title: string;
  readonly onBack: () => void;
  readonly children: ReactNode;
}) {
  return (
    <View style={styles.page}>
      <Pressable role="button" accessibilityLabel="Back to the room menu" onPress={onBack} style={styles.back}>
        <Icon name="back" size={18} color={content.ink} />
        <Text variant="ui">{title}</Text>
      </Pressable>
      {children}
    </View>
  );
}

/**
 * The room menu behind the room's name (R3 A1 "name tapped"): About, Guidelines, AI here, Members with the member
 * total, Pins, Topics, the room's polls and quizzes, a moderator's tools and Leave. It is where the AI notice
 * lives for good after it was shown once, and where the member's own AI level and keep-out choice are changed.
 * Sharing into the room and the activities open their own screens, so the menu never holds a second sheet.
 */
export function RoomMenu({
  scope,
  view,
  controller,
  state,
  visible,
  onClose,
  onShare,
}: {
  readonly scope: AccountScope;
  readonly view: Member;
  readonly controller: RoomController;
  readonly state: RoomState;
  readonly visible: boolean;
  readonly onClose: () => void;
  /** Opens the share sheet once the menu has closed. */
  readonly onShare: () => void;
}) {
  const router = useRouter();
  const [page, setPage] = useState<Page>('root');
  const close = () => {
    setPage('root');
    onClose();
  };
  const pinned = view.discussions.filter((item) => item.pinned).length;
  const moderator = view.role === 'moderator';
  return (
    <BottomSheet visible={visible} title={view.room.name} onClose={close} testID="room-menu">
      {page === 'root' ? (
        <View style={styles.list}>
          <MenuRow label="About" onPress={() => setPage('about')} testID="menu-about" />
          <MenuRow label="Guidelines" onPress={() => setPage('guidelines')} testID="menu-guidelines" />
          <MenuRow
            label="AI here"
            value={LEVEL_WORDS[view.you.aiLevel]}
            onPress={() => setPage('ai')}
            testID="menu-ai"
          />
          <MenuRow label="Members" value={String(view.memberTotal)} testID="menu-members" />
          <MenuRow label="Pins" value={String(pinned)} onPress={() => setPage('pins')} testID="menu-pins" />
          <MenuRow
            label="Topics"
            value={String(view.discussions.length)}
            onPress={() => setPage('topics')}
            testID="menu-topics"
          />
          {view.canPost ? (
            <MenuRow
              label="Share a Reel or Scroll"
              onPress={() => {
                close();
                afterPendingBack(onShare);
              }}
              testID="menu-share"
            />
          ) : null}
          <MenuRow
            label="Polls and quizzes"
            onPress={() => {
              close();
              afterPendingBack(() => router.push(activitiesHref(view.room.roomId)));
            }}
            testID="menu-activities"
          />
          {moderator ? (
            <MenuRow label="Moderation" onPress={() => setPage('moderation')} testID="menu-moderation" />
          ) : null}
          <Button
            label="Leave room"
            variant="ghost"
            size="sm"
            busy={state.working}
            onPress={() => {
              close();
              void controller.leave();
            }}
            testID="leave-room"
          />
        </View>
      ) : page === 'about' ? (
        <PageFrame title="About" onBack={() => setPage('root')}>
          <Text variant="bodyS" color={content.ink2}>
            {view.room.description}
          </Text>
          <Text variant="meta" color={content.ink2}>
            {RULE_WORDS[view.room.joinRule]}
          </Text>
          <WhoIsHere hasModerator={view.hasModerator} inhabitants={view.inhabitants} />
        </PageFrame>
      ) : page === 'guidelines' ? (
        <PageFrame title="Guidelines" onBack={() => setPage('root')}>
          <Text variant="bodyS" color={content.ink2}>
            {view.guidelines ?? 'This room has no written guidelines.'}
          </Text>
        </PageFrame>
      ) : page === 'ai' ? (
        <PageFrame title="AI here" onBack={() => setPage('root')}>
          <AiHere
            you={view.you}
            working={state.working}
            onChange={(change) => void controller.setPreferences(change)}
          />
        </PageFrame>
      ) : page === 'pins' ? (
        <PageFrame title="Pins" onBack={() => setPage('root')}>
          <TopicsList scope={scope} view={view} controller={controller} state={state} pinnedOnly />
        </PageFrame>
      ) : page === 'topics' ? (
        <PageFrame title="Topics" onBack={() => setPage('root')}>
          <TopicsList scope={scope} view={view} controller={controller} state={state} canShare={false} />
        </PageFrame>
      ) : (
        <PageFrame title="Moderation" onBack={() => setPage('root')}>
          <ModeratorTools scope={scope} view={view} controller={controller} state={state} />
        </PageFrame>
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing[1] },
  page: { gap: spacing[3] },
  back: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], minHeight: 44 },
  row: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: borderWidth.hairline,
    borderBottomColor: content.rule,
  },
  rowEnd: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
});
