import type { AccountScope } from './account-scope';
import type { OutboxTimers } from './recorder/outbox';

/** How long the acknowledgement of "Not interested" offers Undo. The constraint itself lasts longer. */
export const UNDO_WINDOW_MS = 8_000;

/** Where "Not interested" stands for the last asset the person tapped it on (P03 card 2). */
export type NotInterestedState =
  | { readonly status: 'idle' }
  | { readonly status: 'saving'; readonly assetId: string }
  /** Saved. `resume` is whatever the caller handed in to put the person back where they were on Undo. */
  | { readonly status: 'acknowledged'; readonly assetId: string; readonly resume: string | undefined }
  | { readonly status: 'undoing'; readonly assetId: string }
  | { readonly status: 'failed'; readonly assetId: string; readonly step: 'mark' | 'undo' };

/** What a step of "Not interested" came to: done once the server has said so, and the place to go back to. */
export interface NotInterestedStep {
  readonly done: boolean;
  readonly resume: string | undefined;
}

export interface UndoAcknowledgementOptions {
  readonly scope: AccountScope;
  readonly newId: () => string;
  readonly timers: OutboxTimers;
  /** Called after every change of state, so the store can publish it. */
  readonly onChange: (state: NotInterestedState) => void;
}

export interface UndoAcknowledgement {
  /** Keeps the asset out of the person's offers. True once the server has said so. */
  readonly mark: (assetId: string, resume?: string) => Promise<boolean>;
  /** Repeats the step that failed (a save or an Undo) with the same command ID. */
  readonly retry: () => Promise<NotInterestedStep>;
  /** Takes the last mark back. Once done, the caller restores `resume`. */
  readonly undo: () => Promise<NotInterestedStep>;
  /** Hides the acknowledgement; the constraint stays. */
  readonly dismiss: () => void;
  /** Ends the Undo timer when the scope ends. */
  readonly stop: () => void;
}

/**
 * "Not interested" with its timed Undo (P03 card 2). The acknowledgement lives in the account scope's
 * store, not in the sheet, so it survives the move to the next subject and a closed sheet.
 *
 * Every command's ID is minted once per intent and reused by each retry, so a lost answer is repeated
 * rather than saved twice. A mark and its Undo are separate commands; Undo returns the person to the
 * place `resume` names.
 */
export function createUndoAcknowledgement(options: UndoAcknowledgementOptions): UndoAcknowledgement {
  const { scope, newId, timers, onChange } = options;
  let state: NotInterestedState = { status: 'idle' };
  let graceTimer: unknown;
  /** The step in flight or failed, with its command ID, so a retry repeats exactly it. */
  let intent:
    { readonly step: 'mark' | 'undo'; readonly commandId: string; readonly resume: string | undefined } | undefined;

  function set(next: NotInterestedState): void {
    if (!scope.active) return;
    state = next;
    onChange(next);
  }

  function startGrace(): void {
    timers.clearTimeout(graceTimer);
    graceTimer = timers.setTimeout(() => {
      if (state.status === 'acknowledged') set({ status: 'idle' });
    }, UNDO_WINDOW_MS);
  }

  async function runMark(assetId: string, commandId: string, resume: string | undefined): Promise<boolean> {
    timers.clearTimeout(graceTimer);
    intent = { step: 'mark', commandId, resume };
    set({ status: 'saving', assetId });
    try {
      const answer = await scope.api.feedback.notInterested({ commandId, assetId });
      if (!scope.active) return false;
      if (answer.commandId !== commandId || answer.assetId !== assetId) throw new Error('not_interested_lineage');
      intent = undefined;
      set({ status: 'acknowledged', assetId, resume });
      startGrace();
      return true;
    } catch {
      set({ status: 'failed', assetId, step: 'mark' });
      return false;
    }
  }

  async function runUndo(assetId: string, commandId: string, resume: string | undefined): Promise<boolean> {
    timers.clearTimeout(graceTimer);
    intent = { step: 'undo', commandId, resume };
    set({ status: 'undoing', assetId });
    try {
      const answer = await scope.api.feedback.undoNotInterested({ commandId, assetId });
      if (!scope.active) return false;
      if (answer.commandId !== commandId || answer.assetId !== assetId) throw new Error('not_interested_lineage');
      intent = undefined;
      set({ status: 'idle' });
      return true;
    } catch {
      set({ status: 'failed', assetId, step: 'undo' });
      return false;
    }
  }

  return {
    mark: (assetId, resume) => runMark(assetId, newId(), resume),
    async retry() {
      const failed = state;
      if (failed.status !== 'failed' || intent === undefined) return { done: false, resume: undefined };
      const { commandId, resume } = intent;
      const done =
        failed.step === 'mark'
          ? await runMark(failed.assetId, commandId, resume)
          : await runUndo(failed.assetId, commandId, resume);
      return { done, resume };
    },
    async undo() {
      const marked = state;
      if (marked.status !== 'acknowledged') return { done: false, resume: undefined };
      return { done: await runUndo(marked.assetId, newId(), marked.resume), resume: marked.resume };
    },
    dismiss() {
      timers.clearTimeout(graceTimer);
      if (state.status !== 'saving' && state.status !== 'undoing') set({ status: 'idle' });
    },
    stop() {
      timers.clearTimeout(graceTimer);
    },
  };
}
