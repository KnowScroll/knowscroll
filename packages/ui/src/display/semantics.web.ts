import type { AccessibilityRole, ViewProps } from 'react-native';

type Semantics = Pick<
  ViewProps,
  | 'accessibilityRole'
  | 'aria-checked'
  | 'aria-selected'
  | 'aria-modal'
  | 'accessibilityHint'
  | 'accessibilityLabel'
  | 'accessibilityViewIsModal'
  | 'role'
>;

/*
 * React Native Web passes these ARIA attributes through to the DOM; React Native's own types do
 * not declare all of them, so the web variants widen the returned props.
 */

/** A two-state button: `role="button"` with `aria-pressed`. */
export function toggleSemantics(pressed: boolean): Semantics {
  return { role: 'button', 'aria-pressed': pressed } as Semantics;
}

/** One option of a single-choice group: `role="radio"` with `aria-checked`. */
export function radioSemantics(checked: boolean): Semantics {
  return { role: 'radio', 'aria-checked': checked };
}

/** The group of single-choice options: `role="radiogroup"`, named. */
export function radioGroupSemantics(label: string): Semantics {
  return { role: 'radiogroup', 'aria-label': label } as Semantics;
}

/**
 * One destination of the primary navigation. With an address it is a real link (`<a href>`,
 * `aria-current="page"` when current); without one it must be a button, because React Native
 * Web leaves Enter on a link-role element to the browser, which only acts on a real anchor.
 */
export function destinationSemantics(current: boolean, hasHref: boolean): Semantics {
  return { role: hasHref ? 'link' : 'button', 'aria-current': current ? 'page' : undefined } as Semantics;
}

/** A control that navigates: a link when it has an address, otherwise a button (see above). */
export function linkSemantics(hasHref: boolean): Semantics {
  return { role: hasHref ? 'link' : 'button' };
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

/** On the web the Modal is the labelled dialog, so the sheet inside it carries no dialog props. */
export function dialogSemantics(_label: string): Semantics {
  return {};
}

/** React Native Web forwards these to the Modal's `role="dialog" aria-modal="true"` element. */
export function dialogHostSemantics(label: string): object {
  return { 'aria-label': label };
}

/** A description read after the name: `aria-describedby` pointing at the hidden element `id`. */
export function descriptionSemantics(description: string | undefined, id: string): Semantics {
  return description === undefined ? {} : ({ 'aria-describedby': id } as Semantics);
}

export const describedByElement = true;
