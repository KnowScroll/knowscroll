import type { CannotRenderReason, RenderScrollResult } from '../../content/public.js';
import type { PersonalAuthority } from '../../identity/public.js';
import type { ReadExposureDocumentPorts } from './ports.js';

/** The document content negotiated for the client (the consumer document, never provenance). */
type RenderedDocument = Extract<RenderScrollResult, { kind: 'rendition' }>['document'];

export type ReadExposureDocumentResult =
  | {
      readonly kind: 'document';
      readonly exposureId: string;
      readonly assetId: string;
      readonly assetRevision: number;
      readonly document: RenderedDocument;
      readonly degradedEssential: readonly { readonly blockId: string; readonly originalType: string }[];
    }
  | {
      readonly kind: 'refused';
      readonly reason: 'exposure_not_found' | 'universe_unavailable' | 'epoch_changed' | 'cannot_render';
      readonly cannotRender?: CannotRenderReason;
    };

/**
 * `readExposureDocument`: the consumer document an exposure presents, negotiated for the
 * capabilities the client declared when it opened it (`GET /v1/experience/exposures/{id}/document`).
 *
 * Authority: the caller's account and universe at a privacy epoch, rechecked without a lock (a read
 *   never waits behind commands); the exposure must belong to that universe and epoch.
 * Steps: one statement reads the exposure (and rechecks the universe), then content renders the
 *   stored immutable revision: parsed on the client path, negotiated (unsupported blocks become
 *   fallbacks; essential ones are reported). Nothing is written.
 * Failure/retry: reads are safe to repeat. A document the client's declared capabilities cannot
 *   render at all (no baseline blocks, an unsupported schema) is `cannot_render` with its reason.
 * Invariants: only the consumer document is returned; the internal provenance is never read here.
 */
export function makeReadExposureDocument(ports: ReadExposureDocumentPorts) {
  return async function readExposureDocument(
    authority: PersonalAuthority,
    exposureId: string,
  ): Promise<ReadExposureDocumentResult> {
    const read = await ports.readExposure(authority, exposureId);
    if (read.kind === 'refused') return { kind: 'refused', reason: read.reason };
    const { exposure } = read;
    const rendered = await ports.renderScroll({
      assetId: exposure.assetId,
      revision: exposure.assetRevision,
      capabilities: exposure.capabilities,
    });
    switch (rendered.kind) {
      case 'not_found':
        return { kind: 'refused', reason: 'exposure_not_found' };
      case 'cannot_render':
        return { kind: 'refused', reason: 'cannot_render', cannotRender: rendered.reason };
      case 'rendition':
        return {
          kind: 'document',
          exposureId: exposure.id,
          assetId: exposure.assetId,
          assetRevision: exposure.assetRevision,
          document: rendered.document,
          degradedEssential: rendered.degradedEssential,
        };
    }
  };
}

export type ReadExposureDocument = ReturnType<typeof makeReadExposureDocument>;
