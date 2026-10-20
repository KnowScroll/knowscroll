/**
 * How an admitted revision came to be (D-005). The label is a product fact, not decoration: an
 * authored starter Scroll is never presented as generated, and a Cutroom import never as written
 * here. Stored as `content.asset_revisions.provenance_kind`; the database checks the same list.
 */
export const PROVENANCE_KINDS = ['authored_editorial', 'generated', 'cutroom_import'] as const;

export type ProvenanceKind = (typeof PROVENANCE_KINDS)[number];

/** The kinds of asset the inventory holds (`content.assets.kind`). */
export type AssetKind = 'reel' | 'scroll';
