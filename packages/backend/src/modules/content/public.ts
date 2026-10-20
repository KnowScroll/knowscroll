/**
 * Content's public surface for other modules and the apps: the read ports experience and evidence
 * use, and the admission use case's types. Everything here is framework-free; the ports are
 * implemented by `adapters/` and bound by the composition roots through
 * `adapters/nest-providers.ts`.
 *
 * Content is shared, not personal: no port here takes a person's data, and none writes. The one
 * write path (`importEditorialScroll`) is the operator command's.
 */
import type { ScrollDocument } from '@knowscroll/scroll-model';
import type { PersonalScopeTx } from '../identity/public.js';
import type { AssetKind } from './domain/provenance.js';
import type { ReadingFacts } from './domain/reading-facts.js';

export { PROVENANCE_KINDS, type AssetKind, type ProvenanceKind } from './domain/provenance.js';
export { type ReadingFacts } from './domain/reading-facts.js';
export {
  makeImportEditorialScroll,
  type ImportEditorialScroll,
  type ImportEditorialScrollResult,
  type ImportOutcome,
  type ImportRefusal,
} from './application/import-editorial-scroll.js';

/** The facts an action command needs about its target asset. */
export interface AssetForAction {
  readonly revision: number;
  readonly admitted: boolean;
}

/** Port: read one asset inside the caller's personal transaction (no lock). */
export type FindAssetForAction = (scope: PersonalScopeTx, assetId: string) => Promise<AssetForAction | undefined>;

export const FIND_ASSET_FOR_ACTION = Symbol('content.findAssetForAction');

/** An asset as opening it needs to know it: what it is, its current revision, whether it is admitted. */
export interface OpenableAsset {
  readonly assetId: string;
  readonly kind: AssetKind;
  /** The asset's current revision. */
  readonly revision: number;
  readonly admitted: boolean;
  /** `integrity.sha256` of the current revision's document; undefined when no stored revision exists. */
  readonly documentSha256: string | undefined;
}

/**
 * Port: the asset's current revision for opening it, read inside the caller's personal
 * transaction (no lock: assets are shared and withdrawal need not wait for personal commands).
 * `undefined` when the asset does not exist.
 */
export type FindOpenableAsset = (scope: PersonalScopeTx, assetId: string) => Promise<OpenableAsset | undefined>;

export const FIND_OPENABLE_ASSET = Symbol('content.findOpenableAsset');

/**
 * Port: the reading facts of one stored Scroll revision (block weights, owner of each nested block,
 * the reading estimate), read inside the caller's personal transaction. `undefined` when the
 * revision does not exist or is not a Scroll. Old derived versions are recovered from the immutable document; an unsupported stored document raises a typed operational failure.
 */
export type ReadScrollReadingFacts = (
  scope: PersonalScopeTx,
  assetId: string,
  revision: number,
) => Promise<ReadingFacts | undefined>;

export const READ_SCROLL_READING_FACTS = Symbol('content.readScrollReadingFacts');

/** Why a stored revision cannot be rendered for a client. */
export type CannotRenderReason = 'capabilities_invalid' | 'unsupported_document' | 'missing_baseline';

export type RenderScrollResult =
  | {
      readonly kind: 'rendition';
      /** The document negotiated for the client: unsupported blocks replaced by fallbacks, never provenance. */
      readonly document: ScrollDocument;
      /** Essential blocks the client will see only as fallback text. */
      readonly degradedEssential: readonly { readonly blockId: string; readonly originalType: string }[];
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'cannot_render'; readonly reason: CannotRenderReason };

/**
 * Port: the consumer document of one stored Scroll revision, negotiated for the client's declared
 * capabilities (D-012). Reads shared, immutable content outside any personal transaction. The
 * internal provenance is never read here.
 */
export type RenderScroll = (request: {
  readonly assetId: string;
  readonly revision: number;
  readonly capabilities: unknown;
}) => Promise<RenderScrollResult>;

export const RENDER_SCROLL = Symbol('content.renderScroll');
