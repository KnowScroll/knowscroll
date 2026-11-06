import { Platform, StyleSheet, View } from 'react-native';
import {
  appearancePalettes,
  borderWidth,
  content,
  printed,
  radius,
  spacing,
  type Appearance,
} from '@knowscroll/design-tokens';
import { Text } from '@knowscroll/ui';
import { useDevicePreferences } from '../../providers/device-preferences';
import { RadioRow } from '../visibility/choice-rows';
import { SettingsLabel } from './settings-parts';
import { SettingsPage } from './settings-page';

const APPEARANCE_CHOICES: readonly {
  readonly value: Appearance;
  readonly label: string;
  readonly description: string;
}[] = [
  { value: 'light', label: 'Light', description: 'Cream screens and dark text, for daylight.' },
  {
    value: 'dark',
    label: 'Dark',
    description: 'Dark screens on the night sky of your universe. This is how it starts.',
  },
];

/** The name of an appearance, for the Account row that leads here. */
export const appearanceLabel: Readonly<Record<Appearance, string>> = { light: 'Light', dark: 'Dark' };

/**
 * A small picture of the appearance, drawn with its own fixed values so both previews show what
 * they name whichever one is in force: a page, a line of text and a message of yours.
 */
function Preview({ appearance }: { readonly appearance: Appearance }) {
  const palette = appearancePalettes[appearance];
  return (
    <View
      aria-hidden
      style={[styles.preview, { backgroundColor: palette.paper, borderColor: palette.rule }]}
      testID={`appearance-preview-${appearance}`}
    >
      <View style={[styles.previewLine, { backgroundColor: palette.ink, width: '58%' }]} />
      <View style={[styles.previewLine, { backgroundColor: palette.ink2, width: '40%' }]} />
      <View style={[styles.previewBubble, { backgroundColor: palette.paper2 }]} />
      <View style={[styles.previewBubble, styles.previewOwn, { backgroundColor: printed.accent }]} />
    </View>
  );
}

/**
 * `/account/appearance`: Light or Dark for the whole app (#666). The choice applies at once and is
 * kept on this device with the other device choices (D-057, D-151): it survives signing out,
 * switching account and a privacy clear, and nothing is sent to the server. The Universe's sky,
 * a Scroll's page and Reels keep their own colours in both.
 */
export function AppearanceScreen() {
  const { preferences, update } = useDevicePreferences();
  return (
    <SettingsPage title="Appearance" current="appearance">
      <Text variant="body">Choose how KnowScroll looks. Changes apply at once.</Text>
      <SettingsLabel>Theme</SettingsLabel>
      <View role="radiogroup" aria-label="Appearance" style={styles.choices}>
        {APPEARANCE_CHOICES.map((choice) => (
          <RadioRow
            key={choice.value}
            testID={`appearance-${choice.value}`}
            label={choice.label}
            description={choice.description}
            checked={preferences.appearance === choice.value}
            onPress={() => update({ appearance: choice.value })}
          >
            <Preview appearance={choice.value} />
          </RadioRow>
        ))}
      </View>
      <Text variant="meta" color={content.ink2} style={styles.note}>
        Your universe, Reels and the pages of a Scroll keep their own colours. Your choice is kept on this device.
      </Text>
      {Platform.OS === 'web' ? null : (
        <Text variant="meta" color={content.ink2}>
          On this phone, Talk and rooms follow your choice now; other screens stay light for the moment.
        </Text>
      )}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  choices: { gap: spacing[2] },
  preview: {
    height: 64,
    marginTop: spacing[2],
    marginLeft: spacing[8],
    marginRight: spacing[3],
    marginBottom: spacing[2],
    padding: spacing[2],
    gap: spacing[1],
    borderRadius: radius.md,
    borderWidth: borderWidth.hairline,
    overflow: 'hidden',
  },
  previewLine: { height: 6, borderRadius: radius.pill },
  previewBubble: { height: 12, width: '46%', borderRadius: radius.pill },
  previewOwn: { alignSelf: 'flex-end', width: '30%' },
  note: { paddingTop: spacing[4] },
});
