import { defaultTalkTheme, type TalkThemeName } from '@knowscroll/design-tokens';

/**
 * What a person chose for this device in Account (P01 Accessibility & playback, Notifications).
 * Device settings, not account settings: they change how this screen looks and plays, they are
 * not private data, and they survive signing out and a privacy clear.
 */
export interface DevicePreferences {
  /** Follow the system's reduce-motion setting, or always reduce motion in the app. */
  readonly motion: 'device' | 'reduce';
  /** The system's text size, or larger steps on top of it. */
  readonly textSize: 'device' | 'larger' | 'largest';
  /** Reels open with sound; off, a Reel opens muted and can be unmuted on the Reel. */
  readonly reelSound: boolean;
  /** Show the "Ready" notice over the encounter where a request was made. */
  readonly readyNotices: boolean;
  /** How Talk looks: the dark sky (the default) or Paper, for long reading (T3 Q1, D-151). */
  readonly talkTheme: TalkThemeName;
}

export const defaultDevicePreferences: DevicePreferences = {
  motion: 'device',
  textSize: 'device',
  reelSound: true,
  readyNotices: true,
  talkTheme: defaultTalkTheme,
};

/** How much each text size step multiplies the system's size. */
export const textSizeFactor: Readonly<Record<DevicePreferences['textSize'], number>> = {
  device: 1,
  larger: 1.15,
  largest: 1.3,
};

const motionChoices: readonly DevicePreferences['motion'][] = ['device', 'reduce'];
const textSizeChoices: readonly DevicePreferences['textSize'][] = ['device', 'larger', 'largest'];
const talkThemeChoices: readonly TalkThemeName[] = ['sky', 'paper'];

/**
 * Reads stored preferences. Anything missing, misspelt or of the wrong kind falls back to its
 * default, so an older or damaged value never blocks the app.
 */
export function parseDevicePreferences(stored: string | null | undefined): DevicePreferences {
  if (stored === null || stored === undefined) return defaultDevicePreferences;
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return defaultDevicePreferences;
  }
  if (typeof value !== 'object' || value === null) return defaultDevicePreferences;
  const record = value as Record<string, unknown>;
  const defaults = defaultDevicePreferences;
  return {
    motion: motionChoices.find((choice) => choice === record.motion) ?? defaults.motion,
    textSize: textSizeChoices.find((choice) => choice === record.textSize) ?? defaults.textSize,
    reelSound: typeof record.reelSound === 'boolean' ? record.reelSound : defaults.reelSound,
    readyNotices: typeof record.readyNotices === 'boolean' ? record.readyNotices : defaults.readyNotices,
    talkTheme: talkThemeChoices.find((choice) => choice === record.talkTheme) ?? defaults.talkTheme,
  };
}
