import type { Href } from 'expo-router';
import type { ComponentType } from 'react';

/**
 * A privacy control another slice owns, shown in P02 between Clear exploration and Delete account
 * (the drawn place of "Sharing & visibility"). The hub lists it as a row that opens `href`; the
 * desktop page (D05) draws `Panel` as a card of its own. An extension is added by the slice that
 * builds its screen: it appends one entry here and brings its own route and panel.
 */
export interface PrivacyExtension {
  readonly id: string;
  readonly title: string;
  /** What the row does, in the words of the other rows ("Who can open your share links"). */
  readonly description: string;
  readonly href: Href;
  readonly Panel: ComponentType;
}

/** Empty until the share slice (#242) adds revocation of share links. */
export const privacyExtensions: readonly PrivacyExtension[] = [];
