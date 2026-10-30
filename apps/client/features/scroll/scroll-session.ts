import {
  freezeRecordingCommand,
  recordingCommandFields,
  apiProblem,
  ScopeEndedError,
  type AccountScope,
} from '@knowscroll/client-core';
import { DirectActivateExposureResponseSchema } from '@knowscroll/contracts';
import { parseScrollDocument } from '@knowscroll/client-core';
import type { ClientCapabilities } from '@knowscroll/contracts';
import {
  SCROLL_DOCUMENT_V2_SCHEMA_VERSION,
  type ScrollDocument,
  type ScrollDocumentV2,
} from '@knowscroll/scroll-model';
import { SCROLL_CAPABILITIES, STAGE_CAPABILITIES } from './capabilities';

/** The lineage the recorder's observations carry. */
export interface OpenedScroll {
  readonly exposureId: string;
  readonly assetId: string;
  readonly assetRevision: number;
  readonly recordingGeneration?: number;
  readonly recordingSessionId?: string;
  readonly document: ScrollDocument;
  /** Essential blocks the client shows only as fallback text ("this part needs an app update"). */
  readonly degradedEssential: readonly { readonly blockId: string; readonly originalType: string }[];
}

/** A v2 Scroll, opened for the Stage + Spine reader: the same lineage, a stop-based document. */
export type OpenedStageScroll = Omit<OpenedScroll, 'document'> & { readonly document: ScrollDocumentV2 };

/** Either kind of opened Scroll, for the places that only need what both share (lineage, keep positions). */
export type AnyOpenedScroll = OpenedScroll | OpenedStageScroll;

/** Whether an opened Scroll is a v2 document, which the Stage + Spine reader draws (v1 keeps the article). */
export function isStageScroll(scroll: AnyOpenedScroll): scroll is OpenedStageScroll {
  return scroll.document.schemaVersion === SCROLL_DOCUMENT_V2_SCHEMA_VERSION;
}

/** The ids a position in this Scroll can name: block ids in v1, stop ids in v2. */
export function positionIds(scroll: AnyOpenedScroll): readonly string[] {
  return isStageScroll(scroll)
    ? scroll.document.stops.map((stop) => stop.id)
    : scroll.document.sections.flatMap((section) => section.blocks.map((block) => block.id));
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
  /** A v2 document, for a caller that declared it can read one (`stage: true`). */
  | { readonly status: 'ready_stage'; readonly scroll: OpenedStageScroll }
  | { readonly status: 'unavailable' }
  | { readonly status: 'needs_update' }
  | { readonly status: 'offline' }
  | { readonly status: 'error' };

export interface ScrollSessionOptions {
  readonly scope: Pick<AccountScope, 'api' | 'active' | 'recording'>;
  readonly assetId: string;
  /** Mints a UUID per user intent (a command ID); one per step, kept for every retry of that step. */
  readonly newId: () => string;
  /** The caller draws v2 documents (the Stage + Spine reader): declare `scroll-document.v2` and accept one. */
  readonly stage?: boolean;
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
  let activationBody: { commandId: string; exposureId: string; recordingGeneration?: number } | undefined;
  let opened: { exposureId: string; assetRevision: number } | undefined;
  let loaded:
    { document: ScrollDocument | ScrollDocumentV2; degradedEssential: OpenedScroll['degradedEssential'] } | undefined;
  const capabilities: ClientCapabilities = options.stage === true ? STAGE_CAPABILITIES : SCROLL_CAPABILITIES;

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
          capabilities,
        });
        if (disposed) return;
        // A direct open must return exposure lineage; Composer ready/pending is a different flow.
        if (response.status !== undefined) {
          set({ status: 'error' });
          return;
        }
        opened = { exposureId: response.exposureId, assetRevision: response.assetRevision };
      }
      if (loaded === undefined) {
        set({ status: 'loading' });
        const response = await options.scope.api.experience.exposureDocument({ exposureId: opened.exposureId });
        if (disposed) return;
        // The client path: structure, bounds and cheap checks; the server proved the rest at admission.
        const parsed = parseScrollDocument(response.document);
        if (parsed.kind !== 'valid' || (parsed.schema === 'v2' && options.stage !== true)) {
          set({ status: parsed.kind === 'valid' ? 'needs_update' : 'error' });
          return;
        }
        loaded = { document: parsed.document, degradedEssential: response.degradedEssential };
      }
      set({ status: 'activating' });
      activationBody ??= freezeRecordingCommand({
        ...(await recordingCommandFields(options.scope)),
        commandId: options.newId(),
        exposureId: opened.exposureId,
      });
      if (disposed || !options.scope.active) return;
      const activated = DirectActivateExposureResponseSchema.parse(
        await options.scope.api.experience.activateExposure(activationBody),
      );
      if (activated.commandId !== activationBody.commandId || activated.exposureId !== activationBody.exposureId)
        throw new Error('activation_lineage');
      const lineage = {
        exposureId: opened.exposureId,
        ...(activationBody.recordingGeneration === undefined
          ? {}
          : { recordingGeneration: activationBody.recordingGeneration }),
        recordingSessionId: activationBody.commandId,
        assetId: options.assetId,
        assetRevision: opened.assetRevision,
        degradedEssential: loaded.degradedEssential,
      };
      const { document } = loaded;
      set(
        document.schemaVersion === SCROLL_DOCUMENT_V2_SCHEMA_VERSION
          ? { status: 'ready_stage', scroll: { ...lineage, document } }
          : { status: 'ready', scroll: { ...lineage, document } },
      );
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
