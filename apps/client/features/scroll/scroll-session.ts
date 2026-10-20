import { apiProblem, ScopeEndedError, type AccountScope } from '@knowscroll/client-core';
import { parseDocument, type ScrollDocument } from '@knowscroll/scroll-model';
import { SCROLL_CAPABILITIES } from './capabilities';

/** The lineage the recorder's observations carry. */
export interface OpenedScroll {
  readonly exposureId: string;
  readonly assetId: string;
  readonly assetRevision: number;
  readonly document: ScrollDocument;
  /** Essential blocks the client shows only as fallback text ("this part needs an app update"). */
  readonly degradedEssential: readonly { readonly blockId: string; readonly originalType: string }[];
}

/**
 * Where opening a Scroll stands. Every state has a screen: loading, unavailable (no such Scroll, or
 * access ended), needs an update (the declared capabilities cannot render it), offline, an error to
 * retry, and ready.
 */
export type ScrollSessionState =
  | { readonly status: 'opening' }
  | { readonly status: 'loading' }
  | { readonly status: 'activating' }
  | { readonly status: 'ready'; readonly scroll: OpenedScroll }
  | { readonly status: 'unavailable' }
  | { readonly status: 'needs_update' }
  | { readonly status: 'offline' }
  | { readonly status: 'error' };

export interface ScrollSessionOptions {
  readonly scope: Pick<AccountScope, 'api' | 'active'>;
  readonly assetId: string;
  /** Mints a UUID per user intent (a command ID); one per step, kept for every retry of that step. */
  readonly newId: () => string;
}

export interface ScrollSession {
  readonly getState: () => ScrollSessionState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Starts (or restarts after a failure) from the first step that has not succeeded. */
  readonly start: () => void;
  readonly dispose: () => void;
}

/** Answers that mean this Scroll is not (or no longer) for this person to open. */
const UNAVAILABLE_PROBLEMS: ReadonlySet<string> = new Set([
  'ASSET_NOT_FOUND',
  'NOT_FOUND',
  'UNIVERSE_UNAVAILABLE',
  'PRIVACY_EPOCH_CHANGED',
]);

/**
 * Opens a Scroll in three steps, each a command or read the API answers durably (blueprint §7):
 * `open` creates the exposure (the lineage root; a command with a receipt), the document is read for
 * that exposure (negotiated for `SCROLL_CAPABILITIES`), and `activate` marks the article the active
 * reading surface, after which, and only then, the recorder may start. Each command's ID is minted
 * once and reused when a step is retried, so a retry never opens a second exposure.
 *
 * It never throws into the UI: every failure is a state. A late answer of an ended scope is dropped
 * (`ScopeEndedError`, the scope fences it); `dispose` makes later answers do nothing.
 */
export function createScrollSession(options: ScrollSessionOptions): ScrollSession {
  const listeners = new Set<() => void>();
  let state: ScrollSessionState = { status: 'opening' };
  let disposed = false;
  let running = false;
  let openCommandId: string | undefined;
  let activateCommandId: string | undefined;
  let opened: { exposureId: string; assetRevision: number } | undefined;
  let loaded: { document: ScrollDocument; degradedEssential: OpenedScroll['degradedEssential'] } | undefined;

  const set = (next: ScrollSessionState): void => {
    if (disposed) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };

  /** A thrown value as the state the person sees. */
  const failure = (error: unknown): ScrollSessionState => {
    const problem = apiProblem(error);
    // No problem document means no answer from the API: the network (offline, refused, timed out).
    if (problem === undefined) return { status: 'offline' };
    if (UNAVAILABLE_PROBLEMS.has(problem.code)) return { status: 'unavailable' };
    // The client's declared capabilities cannot render this document at all.
    if (problem.code === 'UNPROCESSABLE_REQUEST') return { status: 'needs_update' };
    return { status: 'error' };
  };

  async function run(): Promise<void> {
    if (running || disposed) return;
    running = true;
    try {
      if (opened === undefined) {
        set({ status: 'opening' });
        openCommandId ??= options.newId();
        const response = await options.scope.api.experience.openExposure({
          commandId: openCommandId,
          target: { kind: 'scroll', assetId: options.assetId },
          origin: { kind: 'direct' },
          capabilities: SCROLL_CAPABILITIES,
        });
        if (disposed) return;
        opened = { exposureId: response.exposureId, assetRevision: response.assetRevision };
      }
      if (loaded === undefined) {
        set({ status: 'loading' });
        const response = await options.scope.api.experience.exposureDocument({ exposureId: opened.exposureId });
        if (disposed) return;
        // The client path: structure, bounds and cheap checks; the server proved the rest at admission.
        const parsed = parseDocument(response.document);
        if (parsed.kind !== 'valid') {
          set({ status: 'error' });
          return;
        }
        loaded = { document: parsed.document, degradedEssential: response.degradedEssential };
      }
      set({ status: 'activating' });
      activateCommandId ??= options.newId();
      await options.scope.api.experience.activateExposure({
        commandId: activateCommandId,
        exposureId: opened.exposureId,
      });
      set({
        status: 'ready',
        scroll: {
          exposureId: opened.exposureId,
          assetId: options.assetId,
          assetRevision: opened.assetRevision,
          document: loaded.document,
          degradedEssential: loaded.degradedEssential,
        },
      });
    } catch (error) {
      if (error instanceof ScopeEndedError || disposed) return;
      set(failure(error));
    } finally {
      running = false;
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      void run();
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}
