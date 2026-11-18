import type { ScrollDocumentV2 } from '@knowscroll/scroll-model';
import type { ReaderCommands } from '../reader/reader-commands';
import type { ReaderKey } from '../reader/reader-keys';
import { run } from '../reader/reader-commands';

/** What a key can reach: where the reader is, how to move, the calls and the app's commands. */
export interface KeyTargets {
  readonly stops: ScrollDocumentV2['stops'];
  /** There is a picture or a play block that has a text version: the T key has something to swap. */
  readonly hasTextVersion: boolean;
  readonly commands: ReaderCommands;
  readonly jump: (index: number, animated: boolean) => void;
  /**
   * The stop the reader is on or travelling to: where the last jump was heading while it is under way,
   * otherwise the stop on screen. Every key acts on this stop, so a key pressed before the scroll has
   * been reported lands where the reader is looking.
   */
  readonly heading: () => number;
  readonly toggleTextVersion: () => void;
  /** Shows or undoes the plainer words of the stop being read; false when that stop has none. */
  readonly toggleSimpler: (stopId: string) => boolean;
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
      return run(at.commands.wayOn);
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
    case 'save':
      return run(at.commands.save);
    case 'share-moment':
      return run(at.commands.shareMoment);
    case 'challenge':
      return run(at.commands.challenge);
    case 'small-print':
      return run(at.commands.smallPrint);
    case 'report':
      return run(at.commands.report);
    case 'undo':
      return run(at.commands.undo);
    case 'simpler':
      return stop?.kind === 'read' && at.toggleSimpler(stop.id);
    case 'text-version':
      if (!at.hasTextVersion) return false;
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
