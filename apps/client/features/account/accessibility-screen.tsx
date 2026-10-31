import { View } from 'react-native';
import { content, spacing } from '@knowscroll/design-tokens';
import { SwitchRow, Text } from '@knowscroll/ui';
import { useDevicePreferences } from '../../providers/device-preferences';
import { RadioRow } from '../visibility/choice-rows';
import type { DevicePreferences } from './device-preferences';
import { SettingsLabel } from './settings-parts';
import { SettingsPage } from './settings-page';

const MOTION_CHOICES: readonly {
  readonly value: DevicePreferences['motion'];
  readonly label: string;
  readonly description: string;
}[] = [
  { value: 'device', label: 'Follow my device', description: 'Motion is reduced when your device asks for it.' },
  {
    value: 'reduce',
    label: 'Always reduce motion',
    description: 'No animation in the universe. Formation shows its final state.',
  },
];

const TEXT_SIZE_CHOICES: readonly {
  readonly value: DevicePreferences['textSize'];
  readonly label: string;
  readonly description: string;
}[] = [
  { value: 'device', label: 'My device size', description: 'Uses your device or browser size, up to 200%.' },
  { value: 'larger', label: 'Larger', description: 'A little larger than your device size.' },
  { value: 'largest', label: 'Largest', description: 'Larger again. Layouts stack sooner.' },
];

const TALK_THEME_CHOICES: readonly {
  readonly value: DevicePreferences['talkTheme'];
  readonly label: string;
  readonly description: string;
}[] = [
  {
    value: 'sky',
    label: 'Dark sky',
    description: 'Talk sits on the same sky as your universe. This is how it starts.',
  },
  { value: 'paper', label: 'Paper', description: 'A light page for long reading. Your own bubbles stay cobalt.' },
];

/**
 * `/account/accessibility` (P01): how this device moves, reads and plays. The choices change the
 * app at once and are kept on this device: motion and text size lay over the device's own
 * settings, Talk is drawn on the dark sky or on Paper (D-151), and a Reel opens with or without sound.
 */
export function AccessibilityScreen() {
  const { preferences, update } = useDevicePreferences();
  return (
    <SettingsPage title="Accessibility & playback" current="accessibility">
      <Text variant="body">Follows your device by default. Changes apply at once.</Text>
      <SettingsLabel>Motion</SettingsLabel>
      <View role="radiogroup" aria-label="Motion" style={{ gap: spacing[2] }}>
        {MOTION_CHOICES.map((choice) => (
          <RadioRow
            key={choice.value}
            label={choice.label}
            description={choice.description}
            checked={preferences.motion === choice.value}
            onPress={() => update({ motion: choice.value })}
          />
        ))}
      </View>
      <SettingsLabel>Text size</SettingsLabel>
      <View role="radiogroup" aria-label="Text size" style={{ gap: spacing[2] }}>
        {TEXT_SIZE_CHOICES.map((choice) => (
          <RadioRow
            key={choice.value}
            label={choice.label}
            description={choice.description}
            checked={preferences.textSize === choice.value}
            onPress={() => update({ textSize: choice.value })}
          />
        ))}
      </View>
      <Text variant="body" style={{ paddingTop: spacing[2] }}>
        This line is the size you chose.
      </Text>
      <SettingsLabel>Talk</SettingsLabel>
      <View role="radiogroup" aria-label="How Talk looks" style={{ gap: spacing[2] }}>
        {TALK_THEME_CHOICES.map((choice) => (
          <RadioRow
            key={choice.value}
            label={choice.label}
            description={choice.description}
            checked={preferences.talkTheme === choice.value}
            onPress={() => update({ talkTheme: choice.value })}
          />
        ))}
      </View>
      <SettingsLabel>Playback</SettingsLabel>
      <SwitchRow
        label="Start Reels with sound"
        description="Off: Reels open muted. Unmute on any Reel."
        on={preferences.reelSound}
        onChange={(reelSound) => update({ reelSound })}
      />
      <Text variant="meta" color={content.ink2} style={{ paddingTop: spacing[4] }}>
        These choices are kept on this device.
      </Text>
    </SettingsPage>
  );
}
