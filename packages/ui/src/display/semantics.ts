import type { AccessibilityRole, ViewProps } from 'react-native';

/**
 * Accessibility semantics that differ between platforms. Native (this file): roles and states
 * as TalkBack and VoiceOver announce them. Web (`semantics.web.ts`): ARIA as browsers expose it.
 */
type Semantics = Pick<ViewProps, 'accessibilityRole' | 'aria-checked' | 'aria-selected' | 'accessibilityHint'>;

/** A two-state button (Like, Save, a format option): "toggle button, checked". */
export function toggleSemantics(pressed: boolean): Semantics {
  return { accessibilityRole: 'togglebutton', 'aria-checked': pressed };
}

/** One destination of the primary navigation: a tab, selected when current. */
export function destinationSemantics(current: boolean): Semantics {
  return { accessibilityRole: 'tab', 'aria-selected': current };
}

/** A link to the page that is showing (the account avatar on the account screen). */
export function currentPageSemantics(current: boolean): Semantics {
  return { 'aria-selected': current };
}

/** A heading; native screen readers have one heading level. */
export function headingSemantics(_level: 1 | 2 | 3): Semantics {
  return { accessibilityRole: 'header' };
}

/** The container of the primary navigation. */
export function navigationContainerSemantics(label: string): {
  accessibilityRole: AccessibilityRole;
  accessibilityLabel: string;
} {
  return { accessibilityRole: 'tablist', accessibilityLabel: label };
}

/**
 * A description read after the name (for example "Unread messages" on Talk). Native reads it as
 * the accessibility hint; the web points `aria-describedby` at a hidden element with `id`.
 */
export function descriptionSemantics(description: string | undefined, _id: string): Semantics {
  return description === undefined ? {} : { accessibilityHint: description };
}

/** Whether the description needs its own (visually hidden) element carrying the `id`. */
export const describedByElement = false;
