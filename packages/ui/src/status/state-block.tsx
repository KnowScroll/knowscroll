import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { borderWidth, content, radius, space, spacing, status } from '@knowscroll/design-tokens';
import { Button } from '../actions/button';
import { Icon } from '../icons/icon';
import type { IconName } from '../icons/icon-paths';
import { Text } from '../text/text';

export interface StateAction {
  readonly label: string;
  readonly onPress: () => void;
  readonly variant?: 'primary' | 'default' | 'space';
  /** Navigation actions ("Go to Explore") are links. */
  readonly role?: 'button' | 'link';
  readonly icon?: IconName;
}

export interface StateBlockProps {
  /** Illustration above the title (decorative). */
  readonly illustration?: ReactNode;
  readonly title: string;
  readonly body?: ReactNode;
  /** Only actions whose destination or command exists. */
  readonly actions?: readonly StateAction[];
  /** `paper` for content screens, `space` for the universe. */
  readonly tone?: 'paper' | 'space';
  /** Empty states on content tabs start at the gutter; the universe centres its quiet state. */
  readonly align?: 'start' | 'center';
  /** `stretch` stacks full-width buttons (Talk); `hug` keeps them at their own width (Keep). */
  readonly actionLayout?: 'hug' | 'stretch';
  readonly testID?: string;
}

/**
 * An empty, offline or error state: illustration, a display title (Bricolage 800), one calm
 * sentence and the real next steps. The title is a heading for screen readers.
 */
export function StateBlock({
  illustration,
  title,
  body,
  actions = [],
  tone = 'paper',
  align = 'start',
  actionLayout = 'hug',
  testID,
}: StateBlockProps) {
  const foreground = tone === 'space' ? space.label : content.ink;
  const secondary = tone === 'space' ? space.label2 : content.ink2;
  const centred = align === 'center';
  return (
    <View testID={testID} style={[styles.block, centred ? styles.centred : styles.start]}>
      {illustration === undefined ? null : (
        <View aria-hidden importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
          {illustration}
        </View>
      )}
      <Text variant="displayL" color={foreground} heading={2} align={centred ? 'center' : 'left'}>
        {title}
      </Text>
      {body === undefined ? null : (
        <Text variant="body" color={secondary} align={centred ? 'center' : 'left'}>
          {body}
        </Text>
      )}
      {actions.length === 0 ? null : (
        <View style={[styles.actions, actionLayout === 'stretch' ? styles.stretch : centred ? styles.centred : null]}>
          {actions.map((action) => (
            <Button
              key={action.label}
              label={action.label}
              onPress={action.onPress}
              variant={action.variant ?? (tone === 'space' ? 'space' : 'primary')}
              role={action.role ?? 'button'}
              icon={action.icon}
            />
          ))}
        </View>
      )}
    </View>
  );
}

/** The icon tile used by the offline and error blocks (the S01 empty tile, solid edge). */
function IconTile({ icon, edge }: { icon: IconName; edge: string }) {
  return (
    <View style={[styles.tile, { borderColor: edge }]}>
      <Icon name={icon} size={32} color={edge} strokeWidth={1.8} />
    </View>
  );
}

export function OfflineState({ body, onRetry }: { body: string; onRetry?: () => void }) {
  return (
    <StateBlock
      illustration={<IconTile icon="offline" edge={content.ink} />}
      title="You're offline"
      body={body}
      actions={onRetry === undefined ? [] : [{ label: 'Try again', onPress: onRetry, variant: 'default' }]}
    />
  );
}

export function ErrorState({ title, body, onRetry }: { title: string; body: string; onRetry?: () => void }) {
  return (
    <StateBlock
      illustration={<IconTile icon="alert" edge={status.danger.edge} />}
      title={title}
      body={body}
      actions={onRetry === undefined ? [] : [{ label: 'Try again', onPress: onRetry, variant: 'default' }]}
    />
  );
}

const styles = StyleSheet.create({
  block: { gap: spacing[4], maxWidth: 560, width: '100%' },
  start: { alignItems: 'flex-start' },
  centred: { alignItems: 'center', alignSelf: 'center' },
  actions: { gap: spacing[3], alignSelf: 'stretch', alignItems: 'flex-start' },
  stretch: { alignItems: 'stretch' },
  tile: {
    width: 72,
    height: 72,
    borderRadius: radius.xl,
    borderWidth: borderWidth.regular,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
