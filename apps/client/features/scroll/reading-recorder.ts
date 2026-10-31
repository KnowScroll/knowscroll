import { createScrollRecorder, type AccountScope, type ScrollRecorder } from '@knowscroll/client-core';
import { newCommandId } from '../../platform/command-id';
import type { AnyOpenedScroll } from './scroll-session';

/**
 * The recorder of one opened Scroll: its observations carry the exposure's lineage and go through the scope's
 * durable outbox. Start it once the reader is on screen and end it when the reader goes (D-135).
 */
export function recorderFor(scope: AccountScope, scroll: AnyOpenedScroll): ScrollRecorder {
  return createScrollRecorder({
    exposure: {
      exposureId: scroll.exposureId,
      assetId: scroll.assetId,
      assetRevision: scroll.assetRevision,
      ...(scroll.recordingGeneration === undefined ? {} : { recordingGeneration: scroll.recordingGeneration }),
      ...(scroll.recordingSessionId === undefined ? {} : { recordingSessionId: scroll.recordingSessionId }),
    },
    scope,
    newId: newCommandId,
  });
}
