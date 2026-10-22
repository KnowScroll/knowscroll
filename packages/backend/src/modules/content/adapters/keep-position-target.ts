import { KeepAssetRefSchema, ReelDocumentSchema } from '@knowscroll/contracts';
import { admitDocument } from '@knowscroll/scroll-model/admission';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { LockKeepPositionTarget } from '../public.js';
import { readReelMediaBinding } from './media-access.js';

/** Caller already holds its own Identity account gate and has checked the Saved membership.
 * AccountAccess is plain context, not proof of that gate. Content owns only its SHARE lock,
 * fresh current-head check and minimized canonical facts, all in this still-open transaction. */
export const lockKeepPositionTarget: LockKeepPositionTarget = async (scope, owner, input) => {
  const trx = transactionOf(scope);
  const authority = scope.authority;
  if (
    authority.actor.kind !== 'account' ||
    owner.accountId !== authority.actor.accountId ||
    owner.universeId !== authority.universeId ||
    owner.privacyEpoch !== authority.privacyEpoch
  )
    return undefined;
  const parsed = KeepAssetRefSchema.safeParse(input);
  if (!parsed.success) return undefined;
  const ref = parsed.data;
  // Never read head/status in a statement that might wait: re-read separately after SHARE.
  const locked = await trx
    .selectFrom('content.assets')
    .select('id')
    .where('id', '=', ref.assetId)
    .forShare()
    .executeTakeFirst();
  if (!locked) return undefined;
  const head = await trx
    .selectFrom('content.assets')
    .select(['kind', 'revision', 'status'])
    .where('id', '=', ref.assetId)
    .executeTakeFirst();
  if (!head || head.status !== 'admitted' || head.revision !== ref.assetRevision) return undefined;
  const row = await trx
    .selectFrom('content.asset_revisions')
    .select(['document', 'document_version', 'document_sha256'])
    .where('asset_id', '=', ref.assetId)
    .where('revision', '=', ref.assetRevision)
    .executeTakeFirst();
  if (!row) return undefined;
  if (head.kind === 'scroll' && row.document_version === 'scroll-document.v1') {
    // Stored admission validation verifies integrity/measures/bounds and excludes renditions.
    const result = admitDocument(row.document);
    if (result.kind !== 'valid') return undefined;
    const document = result.document;
    if (
      document.assetId.toLowerCase() !== ref.assetId.toLowerCase() ||
      document.revision !== ref.assetRevision ||
      document.integrity.sha256 !== row.document_sha256
    )
      return undefined;
    return {
      kind: 'scroll',
      topLevelBlockIds: document.sections.flatMap((section) => section.blocks.map((block) => block.id)),
    };
  }
  if (head.kind !== 'reel' || row.document_version !== 'reel-document.v1') return undefined;
  const result = ReelDocumentSchema.safeParse(row.document);
  if (
    !result.success ||
    result.data.assetId.toLowerCase() !== ref.assetId.toLowerCase() ||
    result.data.revision !== ref.assetRevision
  )
    return undefined;
  // Same immutable document/media-key binding as Content's existing media-access port.
  // No media URL/key leaves this adapter and no filesystem/probe/network I/O runs here.
  const media = await readReelMediaBinding(trx, ref);
  if (!media || media.key !== result.data.mediaKey) return undefined;
  return { kind: 'reel', durationMs: result.data.durationMs };
};
