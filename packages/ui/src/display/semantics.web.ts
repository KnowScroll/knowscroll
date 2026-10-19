import type { AccessibilityRole, ViewProps } from 'react-native';

type Semantics = Pick<ViewProps, 'accessibilityRole' | 'aria-checked' | 'aria-selected' | 'accessibilityHint'>;

/*
 * React Native Web passes these ARIA attributes through to the DOM; React Native's own types do
 * not declare them, so the web variants widen the returned props.
 */

/** A two-state button: `role="button"` with `aria-pressed`. */
export function toggleSemantics(pressed: boolean): Semantics {
  return { role: 'button', 'aria-pressed': pressed } as Semantics;
}

/** One destination of the primary navigation: a link, `aria-current="page"` when current. */
export function destinationSemantics(current: boolean): Semantics {
  return { role: 'link', 'aria-current': current ? 'page' : undefined } as Semantics;
}

/** A link to the page that is showing: `aria-current="page"`. */
export function currentPageSemantics(current: boolean): Semantics {
  return { 'aria-current': current ? 'page' : undefined } as Semantics;
}

/** A heading with its outline level (`h1`–`h3`). */
export function headingSemantics(level: 1 | 2 | 3): Semantics {
  return { role: 'heading', 'aria-level': level } as Semantics;
}

/** The `<nav>` landmark of the primary navigation. */
export function navigationContainerSemantics(label: string): {
  accessibilityRole: AccessibilityRole;
  accessibilityLabel: string;
} {
  return { role: 'navigation', 'aria-label': label } as unknown as {
    accessibilityRole: AccessibilityRole;
    accessibilityLabel: string;
  };
}

/** A description read after the name: `aria-describedby` pointing at the hidden element `id`. */
export function descriptionSemantics(description: string | undefined, id: string): Semantics {
  return description === undefined ? {} : ({ 'aria-describedby': id } as Semantics);
}

export const describedByElement = true;
