import { View } from 'react-native';
import { content, spacing } from '@knowscroll/design-tokens';
import { SwitchRow, Text } from '@knowscroll/ui';
import { useDevicePreferences } from '../../providers/device-preferences';
import { SettingsLabel } from './settings-parts';
import { SettingsPage } from './settings-page';

/**
 * `/account/notifications` (P01): the notices KnowScroll shows inside the app. Only things a person
 * asked for appear here; there are no streak or "you missed" reminders to turn off, and no
 * push notifications yet. The choice is kept on this device.
 */
export function NotificationsScreen() {
  const { preferences, update } = useDevicePreferences();
  return (
    <SettingsPage title="Notifications" current="notifications">
      <Text variant="body">Only things you asked for or people said, shown in the app.</Text>
      <SettingsLabel>Notify me</SettingsLabel>
      <SwitchRow
        label="Ready requests"
        description="A Scroll or Reel you asked for is ready. It is still waiting in Keep if you turn this off."
        on={preferences.readyNotices}
        onChange={(readyNotices) => update({ readyNotices })}
      />
      <View style={{ paddingTop: spacing[4], gap: spacing[2] }}>
        <Text variant="meta" color={content.ink2}>
          Messages follow each conversation: mute one from its menu in Talk.
        </Text>
        <Text variant="meta" color={content.ink2}>
          We never send streak or "you missed" reminders. This choice is kept on this device.
        </Text>
      </View>
    </SettingsPage>
  );
}
