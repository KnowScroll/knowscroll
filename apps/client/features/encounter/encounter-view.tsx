import type { ReactNode } from 'react';
import type { AccountScope } from '@knowscroll/client-core';
import type { EncounterEntry } from './encounter-history';
import type { EncounterSession, EncounterState } from './encounter-session';
import { ReelEncounter } from './encounter-reel';
import { ScrollEncounter } from './encounter-scroll';

/** The activated Reel or Scroll of the current entry, drawn as E01 or E02. */
export function EncounterView({
  scope,
  entry,
  state,
  session,
  foreground,
  back,
  hint,
}: {
  readonly scope: AccountScope;
  readonly entry: EncounterEntry;
  readonly state: EncounterState;
  readonly session: EncounterSession;
  readonly foreground: boolean;
  readonly back: () => void;
  readonly hint: ReactNode;
}) {
  return entry.kind === 'reel' ? (
    <ReelEncounter
      scope={scope}
      entry={entry}
      state={state}
      session={session}
      foreground={foreground}
      back={back}
      hint={hint}
    />
  ) : (
    <ScrollEncounter
      scope={scope}
      entry={entry}
      state={state}
      session={session}
      foreground={foreground}
      back={back}
      hint={hint}
    />
  );
}
