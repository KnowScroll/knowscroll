import type { ScrollDocumentV2 } from '@knowscroll/scroll-model';
import type { ReaderKey } from './reader-keys';

/** What the app can do for the reader beyond reading: each is also a button, so no key or gesture stands alone. */
export interface ReaderCommands {
  readonly universe?: () => void;
  readonly ask?: () => void;
  readonly format?: () => void;
  readonly nextPart?: () => void;
  readonly previousPart?: () => void;
  readonly nextTopic?: () => void;
}

/** Runs a command the app may not provide; whether it ran is whether the key or swipe was used. */
export function run(command: (() => void) | undefined): boolean {
  if (command === undefined) return false;
  command();
  return true;
}

/** What a key can reach: where the reader is, how to move, the calls and the app's commands. */
export interface KeyTargets {
  readonly stops: ScrollDocumentV2['stops'];
  readonly hasStage: boolean;
  readonly commands: ReaderCommands;
  readonly jump: (index: number, animated: boolean) => void;
  /**
   * The stop the reader is on or travelling to: where the last jump was heading while it is under way,
   * otherwise the stop on screen. Every key acts on this stop, so a key pressed before the scroll has
   * been reported lands where the reader is looking.
   */
  readonly heading: () => number;
  readonly toggleTextVersion: () => void;
  readonly pick: (callId: string, option: number, optionCount: number) => void;
  readonly lock: (callId: string) => boolean;
}

/** Does what a key means (D-134); true when the key was used, so the browser's own action is held back. */
export function actOnKey(key: ReaderKey, at: KeyTargets): boolean {
  const stop = at.stops[at.heading()];
  const open = stop !== undefined && stop.kind !== 'read' ? stop : undefined;
  switch (key.action) {
    case 'next-stop':
      at.jump(at.heading() + 1, true);
      return true;
    case 'previous-stop':
      at.jump(at.heading() - 1, true);
      return true;
    case 'next-part':
      return run(at.commands.nextPart);
    case 'previous-part':
      return run(at.commands.previousPart);
    case 'next-topic':
      return run(at.commands.nextTopic);
    case 'universe':
      return run(at.commands.universe);
    case 'ask':
      return run(at.commands.ask);
    case 'format':
      return run(at.commands.format);
    case 'text-version':
      if (!at.hasStage) return false;
      at.toggleTextVersion();
      return true;
    case 'pick':
      if (open === undefined) return false;
      at.pick(open.id, key.option - 1, open.options.length);
      return true;
    case 'lock-in':
      return open !== undefined && at.lock(open.id);
  }
}
