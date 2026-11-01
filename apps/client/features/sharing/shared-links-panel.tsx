import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import type { AccountScope } from '@knowscroll/client-core';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Banner, Button, Tag, Text } from '@knowscroll/ui';
import type { ClearProgress } from '../privacy/clear-progress';
import { useSharedLinks } from './use-share-session';

const dateOf = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/**
 * "Shared links" (P02): every public link the person made and has not stopped, with a way
 * to stop each. A stopped link answers "no longer available" to everyone; copies already pasted
 * elsewhere cannot be recalled, and the panel says so. Mount it inside the privacy screen.
 */
export function SharedLinksPanel({
  scope,
  titled = true,
  clear,
  onLoadFailed,
}: {
  readonly scope: AccountScope;
  /** Draws the heading; a page that names itself passes false. */
  readonly titled?: boolean;
  /** A Clear that is under way: while the account is being cleared the list cannot load, and the panel says why. */
  readonly clear?: ClearProgress | undefined;
  /** Called when the list cannot load, so the screen can find out whether a Clear is the reason. */
  readonly onLoadFailed?: () => void;
}) {
  const { session, state } = useSharedLinks(scope);
  useEffect(() => {
    void session.refresh();
  }, [session]);
  const failed = state.status === 'failed';
  useEffect(() => {
    if (failed) onLoadFailed?.();
  }, [failed, onLoadFailed]);
  // The list is read again once the Clear that stopped it has finished.
  const clearing = clear !== undefined;
  const wasClearing = useRef(false);
  useEffect(() => {
    if (wasClearing.current && !clearing) void session.refresh();
    wasClearing.current = clearing;
  }, [clearing, session]);
  return (
    <View style={styles.panel}>
      {titled ? (
        <Text variant="title" heading={2}>
          Shared links
        </Text>
      ) : null}
      <Text variant="meta" color={content.ink2}>
        Stopping a link makes it say “no longer available” for everyone. Copies already pasted elsewhere can’t be
        recalled.
      </Text>
      {failed && clear !== undefined ? (
        <Banner
          kind="info"
          lead="Clearing exploration."
          message={`${clear.text} Your links are back when it is done.`}
        />
      ) : null}
      {failed && clear === undefined ? (
        <Banner kind="error" lead="Couldn’t load your links." message="Check your connection and try again." />
      ) : null}
      {state.status === 'ready' && state.items.length === 0 ? (
        <Text variant="bodyS">You haven’t shared any links. A link you copy from a Reel or Scroll appears here.</Text>
      ) : null}
      {state.items.map((item) => {
        const metadata =
          item.content.status === 'available'
            ? item.content.metadata
            : item.content.status === 'corrected'
              ? item.content.current.metadata
              : undefined;
        return (
          <View key={item.shareId} style={styles.row}>
            <View style={styles.rowText}>
              {metadata === undefined ? null : (
                <Tag variant="neutral" label={metadata.kind === 'reel' ? 'Reel' : 'Scroll'} />
              )}
              <Text variant="bodyS" numberOfLines={2}>
                {metadata?.title ?? 'No longer available'}
              </Text>
              <Text variant="meta" color={content.ink2}>
                Shared {dateOf(item.createdAt)} · works until {dateOf(item.expiresAt)}
              </Text>
            </View>
            <Button
              label="Stop sharing"
              size="sm"
              variant="ghost"
              busy={state.stopping === item.shareId}
              busyLabel="Stopping"
              disabled={state.stopping !== undefined}
              onPress={() => void session.stop(item.shareId)}
            />
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: spacing[3] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    padding: spacing[3],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.card,
    backgroundColor: content.paper,
  },
  rowText: { flex: 1, gap: spacing[1], alignItems: 'flex-start' },
});
