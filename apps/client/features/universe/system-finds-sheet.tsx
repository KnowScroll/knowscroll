import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { readSystemFinds, type AccountScope, type SystemFind, type SystemFindsRead } from '@knowscroll/client-core';
import { space, spacing } from '@knowscroll/design-tokens';
import { Button, Icon, IconButton, Text, useFocusRing } from '@knowscroll/ui';
import { newCommandId } from '../../platform/command-id';

const GLASS = 'rgba(6,26,38,0.92)';
const GLASS_EDGE = 'rgba(255,255,255,0.15)';

/** What the sheet says for a format the system has nothing in yet: said plainly, never a link that leads nowhere. */
export const emptyFormat = (format: 'Reels' | 'Scrolls', system: string) => `No ${format} in ${system} yet.`;

type Read = { readonly status: 'reading' } | SystemFindsRead;

/** Reads a system's finds once the sheet opens, and again on Try again; nothing is read while the sheet is shut. */
function useSystemFinds(scope: AccountScope, systemId: string) {
  const [attempt, setAttempt] = useState(0);
  // An answer counts only for the system and attempt it was read for; until then the sheet is still looking.
  const [answer, setAnswer] = useState<{ readonly key: string; readonly read: SystemFindsRead }>();
  const key = `${systemId}:${String(attempt)}`;
  useEffect(() => {
    const abort = new AbortController();
    void readSystemFinds(scope, { systemId, readId: newCommandId() }, abort.signal).then((read) => {
      // Every answer is shown, a lost authority included, so the sheet never waits on "Looking…" for good.
      if (!abort.signal.aborted) setAnswer({ key, read });
    });
    return () => abort.abort();
  }, [scope, systemId, key]);
  const read: Read = answer?.key === key ? answer.read : { status: 'reading' };
  return { read, again: useCallback(() => setAttempt((n) => n + 1), []) };
}

/**
 * What a system holds to watch or read (#697): its Reels and its Scrolls, newest first, each opening in its own reader by
 * its address, where the real encounter starts. A system has these before it has any planet, so this is the way in from
 * a system with none. A format with nothing in it says so. Opening the sheet records nothing.
 */
export function SystemFindsSheet({
  scope,
  systemId,
  systemName,
  onClose,
}: {
  readonly scope: AccountScope;
  readonly systemId: string;
  readonly systemName: string;
  readonly onClose: () => void;
}) {
  const router = useRouter();
  const { read, again } = useSystemFinds(scope, systemId);
  const open = (find: SystemFind) =>
    router.push(
      find.kind === 'reel'
        ? { pathname: '/reel/[assetId]', params: { assetId: find.assetId } }
        : { pathname: '/scroll/[assetId]', params: { assetId: find.assetId } },
    );
  return (
    <View
      testID="universe-system-finds"
      role="dialog"
      accessibilityLabel={`Watch or read in ${systemName}`}
      style={styles.sheet}
    >
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text variant="label" color={space.label2}>
            Watch or read
          </Text>
          <Text variant="title" heading={2} color="#ffffff">
            {systemName}
          </Text>
        </View>
        <IconButton icon="close" label="Close" variant="onSpace" onPress={onClose} />
      </View>
      {read.status === 'reading' ? (
        <Text variant="bodyS" color={space.label2} testID="universe-system-finds-reading">
          Looking…
        </Text>
      ) : read.status === 'unavailable' ? (
        <View style={styles.failed}>
          <Text variant="bodyS" color={space.label2}>
            {read.reason === 'not_on_map'
              ? `${systemName} is no longer on your map.`
              : `The Reels and Scrolls of ${systemName} could not be read just now.`}
          </Text>
          {read.reason === 'not_on_map' ? null : (
            <Button label="Try again" size="sm" variant="spaceGhost" onPress={again} />
          )}
        </View>
      ) : (
        <>
          <FormatGroup
            format="Reels"
            system={systemName}
            finds={read.finds.filter((find) => find.kind === 'reel')}
            onOpen={open}
          />
          <FormatGroup
            format="Scrolls"
            system={systemName}
            finds={read.finds.filter((find) => find.kind === 'scroll')}
            onOpen={open}
          />
        </>
      )}
    </View>
  );
}

function FormatGroup({
  format,
  system,
  finds,
  onOpen,
}: {
  readonly format: 'Reels' | 'Scrolls';
  readonly system: string;
  readonly finds: readonly SystemFind[];
  readonly onOpen: (find: SystemFind) => void;
}) {
  return (
    <View style={styles.group}>
      <Text variant="label" color={space.label2}>
        {format}
      </Text>
      {finds.length === 0 ? (
        <Text variant="bodyS" color={space.label2}>
          {emptyFormat(format, system)}
        </Text>
      ) : (
        <View role="list" style={styles.rows}>
          {finds.map((find) => (
            <FindRow key={find.assetId} find={find} onOpen={onOpen} />
          ))}
        </View>
      )}
    </View>
  );
}

function FindRow({ find, onOpen }: { readonly find: SystemFind; readonly onOpen: (find: SystemFind) => void }) {
  const focus = useFocusRing('onDark');
  const verb = find.kind === 'reel' ? 'Watch' : 'Read';
  return (
    <View role="listitem">
      <Pressable
        testID={`universe-system-find-${find.assetId}`}
        accessibilityRole="link"
        accessibilityLabel={`${verb} ${find.title}`}
        onPress={() => onOpen(find)}
        {...focus.props}
        style={[styles.row, focus.style]}
      >
        <Icon name={find.kind === 'reel' ? 'reel' : 'scroll'} size={18} color="#ffffff" />
        <Text variant="ui" color="#ffffff" numberOfLines={2} style={styles.rowText}>
          {find.title}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    backgroundColor: GLASS,
    borderColor: GLASS_EDGE,
    borderWidth: 1,
    borderRadius: 24,
    padding: spacing[4],
    gap: spacing[3],
    maxWidth: 460,
    width: '100%',
    alignSelf: 'center',
  },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing[3] },
  headText: { flex: 1, minWidth: 0 },
  failed: { gap: spacing[2], alignItems: 'flex-start' },
  group: { gap: spacing[2] },
  rows: { gap: spacing[1] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    minHeight: 44,
    paddingVertical: spacing[1],
    cursor: 'pointer' as const,
  },
  rowText: { flex: 1, minWidth: 0 },
});
