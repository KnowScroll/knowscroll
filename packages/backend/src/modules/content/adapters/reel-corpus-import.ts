import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { CutroomAuthority, WithCutroomScope } from '../../../reasoning/public.js';
import { cutroomTransactionOf } from '../../../infrastructure/postgres/cutroom-scope.js';
import {
  checkReelCorpus,
  parseCommissionReviewDraft,
  ReelCorpusRecordSchema,
  ReelCorpusManifestSchema,
} from '../production/commission-review.js';

/** Explicit trusted metadata import. No default empty completeness, seed, approval mint,
 * history replacement, availability filter or per-person corpus. Every retained row must fit. */
export function makeReelCorpusImporter(
  withScope: WithCutroomScope,
  options: {
    readonly enabled?: boolean;
    readonly records?: readonly unknown[];
    readonly manifest?: unknown;
    readonly draft?: unknown;
  } = {},
) {
  const enabled = options.enabled === true;
  const supplied = structuredClone(options.records ?? []);
  const manifest = ReelCorpusManifestSchema.safeParse(structuredClone(options.manifest));
  const draft = parseCommissionReviewDraft(structuredClone(options.draft));
  const records =
    supplied.length <= 1000
      ? supplied.map((value) => {
          if (Buffer.byteLength(JSON.stringify(value)) > 16384) return undefined;
          const p = ReelCorpusRecordSchema.safeParse(value);
          return p.success ? p.data : undefined;
        })
      : [];
  const valid =
    enabled &&
    manifest.success &&
    !!draft &&
    supplied.length === records.length &&
    records.every((r) => r !== undefined) &&
    checkReelCorpus(records, manifest.data, draft) !== 'corpus_unavailable';
  return async (
    authority: CutroomAuthority,
  ): Promise<{ readonly kind: 'imported'; readonly count: number } | { readonly kind: 'refused' }> => {
    if (!valid || !manifest.success || !draft) return { kind: 'refused' };
    try {
      const result = await withScope(authority, 'recover', async (scope) => {
        const trx = cutroomTransactionOf(scope);
        await sql`select pg_advisory_xact_lock(24031)`.execute(trx);
        const old = await trx
          .selectFrom('content.cutroom_corpus')
          .select(['source_namespace', 'generated_reel_id', 'record_sha256'])
          .orderBy('source_namespace')
          .orderBy('generated_reel_id')
          .limit(1001)
          .execute();
        if (old.length > 1000) return { kind: 'refused' } as const;
        const rows = records.map((r) => {
          if (!r) throw new Error('CUTROOM_CORPUS_INVALID');
          const utf8 = JSON.stringify(r);
          return { r, utf8, digest: createHash('sha256').update(utf8).digest('hex') };
        });
        if (
          old.some(
            (o) =>
              !rows.some(
                (v) =>
                  v.r.sourceNamespace === o.source_namespace &&
                  v.r.generatedReelId === o.generated_reel_id &&
                  v.digest === o.record_sha256,
              ),
          )
        )
          return { kind: 'refused' } as const;
        for (const row of rows) {
          if (
            old.some(
              (o) => o.source_namespace === row.r.sourceNamespace && o.generated_reel_id === row.r.generatedReelId,
            )
          )
            continue;
          await trx
            .insertInto('content.cutroom_corpus')
            .values({
              source_namespace: row.r.sourceNamespace,
              generated_reel_id: row.r.generatedReelId,
              record_utf8: row.utf8,
              record_sha256: row.digest,
              original_template_sha256: row.r.originalTemplateSha256,
              original_argument_sha256: row.r.originalArgumentSha256,
              bridge_sha256: row.r.bridgeSha256,
            })
            .execute();
        }
        return { kind: 'imported', count: rows.length } as const;
      });
      return result.kind === 'entered' ? result.value : { kind: 'refused' };
    } catch {
      return { kind: 'refused' };
    }
  };
}
