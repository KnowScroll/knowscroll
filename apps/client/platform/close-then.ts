import { afterPendingBack, notePendingBack } from './after-pending-back';

/**
 * Closes a sheet and then does what the person chose in it (opens a screen). On the web a sheet's history entry is
 * removed by an asynchronous Back, and a navigation that starts before it lands is popped with it: the address
 * changes and the old screen stays. This waits for that Back (see `after-pending-back.web.ts`); on native it just
 * closes the sheet and runs.
 */
export function closeThen(close: () => void, run: () => void): void {
  notePendingBack();
  close();
  afterPendingBack(run);
}
