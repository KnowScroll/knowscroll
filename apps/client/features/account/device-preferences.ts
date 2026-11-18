import { appearances, defaultAppearance, type Appearance } from '@knowscroll/design-tokens';

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
  /**
   * Light or Dark for the whole app: the shell, Settings, Talk, rooms, sheets and the reader's
   * controls (#666). Dark is the default. It replaces D-151's Talk-only `talkTheme`, which is read
   * once to carry an earlier choice over and is never written again.
   */
  readonly appearance: Appearance;
}

export const defaultDevicePreferences: DevicePreferences = {
  motion: 'device',
  textSize: 'device',
  reelSound: true,
  readyNotices: true,
  appearance: defaultAppearance,
};

/** How much each text size step multiplies the system's size. */
export const textSizeFactor: Readonly<Record<DevicePreferences['textSize'], number>> = {
  device: 1,
  larger: 1.15,
  largest: 1.3,
};

const motionChoices: readonly DevicePreferences['motion'][] = ['device', 'reduce'];
const textSizeChoices: readonly DevicePreferences['textSize'][] = ['device', 'larger', 'largest'];

/** D-151 kept the Talk theme as `talkTheme`; its two values carry over to the two appearances. */
const appearanceFromTalkTheme: Readonly<Record<string, Appearance>> = { paper: 'light', sky: 'dark' };

function readAppearance(record: Record<string, unknown>): Appearance {
  const chosen = appearances.find((choice) => choice === record.appearance);
  if (chosen !== undefined) return chosen;
  const earlier =
    typeof record.talkTheme === 'string' && Object.hasOwn(appearanceFromTalkTheme, record.talkTheme)
      ? appearanceFromTalkTheme[record.talkTheme]
      : undefined;
  return earlier ?? defaultAppearance;
}

/**
 * Reads stored preferences. Anything missing, misspelt or of the wrong kind falls back to its
 * default, so an older or damaged value never blocks the app. A value stored before Appearance
 * existed keeps its Talk choice: Paper becomes Light and the dark sky becomes Dark; a stored
 * `appearance` always wins over a leftover `talkTheme`.
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
    appearance: readAppearance(record),
  };
}

/**
 * Whether the stored value must be written again in today's shape: it still carries D-151's
 * `talkTheme` or has no `appearance`, so the carried-over choice becomes the only theme preference
 * on this device and no second, conflicting one is left behind.
 */
export function needsRewrite(stored: string | null | undefined): boolean {
  if (stored === null || stored === undefined) return false;
  try {
    const value: unknown = JSON.parse(stored);
    if (typeof value !== 'object' || value === null) return false;
    return 'talkTheme' in value || !('appearance' in value);
  } catch {
    return false;
  }
}
