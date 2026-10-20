import { sql, type Kysely, type Transaction } from 'kysely';
import { z } from 'zod';
import { admitDocument, canonicalJson, canonicalSha256, utf8ByteLength, walkBlocks } from '@knowscroll/scroll-model';
import { ScrollProvenance } from '@knowscroll/scroll-model/internal';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { AdmissionTx } from '../application/ports.js';
import type {
  CoverageAdmissionPorts,
  CoverageHead,
  LockCurrentCoverageAuthorities,
  ReadAdmittedCoverageMapping,
} from '../application/coverage-ports.js';
import { makeAdmitCoverage } from '../application/admit-coverage.js';
import { CONCEPTS, CONCEPT_CATALOGUE_VERSION, conceptMeaning } from '../domain/concepts.js';
import {
  CoverageAuthoritySchema,
  CoverageMappingSchema,
  CoverageRefSchema,
  validateCoverageMapping,
  type CoverageRef,
  type CoverageTarget,
} from '../domain/coverage.js';
import { admissionTransaction, makeAdmissionStore } from './postgres-store.js';
import { readingFactsOf } from './scroll-compiler.js';

export const coverageCatalogue = {
  sha256: canonicalSha256({ version: CONCEPT_CATALOGUE_VERSION, concepts: CONCEPTS }),
  meaningSha256(topicId: string, facetId: string) {
    const meaning = conceptMeaning(topicId, facetId);
    return meaning ? canonicalSha256(meaning) : undefined;
  },
};

/** No live semantic map has been reviewed/admitted by this foundation. Never consume request config. */
const SOURCE_REVIEWED_COMMANDS: readonly {
  readonly commandSha256: string;
  readonly semanticReviewReference: string;
}[] = [];

async function readTarget(db: Transaction<Database>, ref: CoverageRef): Promise<CoverageTarget | undefined> {
  const result = await sql<{
    document: unknown;
    document_sha256: string;
    explanation_unit_id: string;
    document_version: string;
    provenance_kind: string;
    provenance_version: string;
    provenance: unknown;
  }>`select r.document,r.document_sha256,r.explanation_unit_id,r.document_version,r.provenance_kind,p.provenance_version,p.provenance
    from content.assets a join content.asset_revisions r on r.asset_id=a.id
    join content.asset_provenance p on p.asset_id=r.asset_id and p.revision=r.revision
    where a.id=${ref.assetId}::uuid and a.kind='scroll' and a.status='admitted'
      and r.revision=${ref.assetRevision}`.execute(db);
  const row = result.rows[0];
  if (!row) return undefined;
  const parsed = admitDocument(row.document);
  const provenance = ScrollProvenance.safeParse(row.provenance);
  if (parsed.kind !== 'valid' || !provenance.success || provenance.data.production.kind === 'fixture') return undefined;
  const document = parsed.document;
  if (
    provenance.data.schemaVersion !== row.provenance_version ||
    !(
      (row.provenance_kind === 'authored_editorial' && provenance.data.production.kind === 'authored-editorial') ||
      (row.provenance_kind === 'generated' && provenance.data.production.kind === 'model')
    ) ||
    document.assetId !== ref.assetId ||
    document.revision !== ref.assetRevision ||
    document.schemaVersion !== row.document_version ||
    document.integrity.sha256 !== row.document_sha256 ||
    document.explanationUnitId !== row.explanation_unit_id ||
    provenance.data.assetId !== ref.assetId ||
    provenance.data.revision !== ref.assetRevision ||
    provenance.data.documentSha256 !== document.integrity.sha256 ||
    document.framing.kind !== 'factual'
  )
    return undefined;
  const facts = readingFactsOf(document);
  const truth = new Map(provenance.data.claims.map((claim) => [claim.claimId, claim.truthState]));
  return {
    documentSha256: document.integrity.sha256,
    provenanceSha256: canonicalSha256(provenance.data),
    explanationUnitId: document.explanationUnitId,
    framing: document.framing.kind,
    framingSha256: canonicalSha256(document.framing),
    readingFactsVersion: facts.v,
    readingFactsSha256: canonicalSha256(facts),
    blocks: [...walkBlocks(document.sections)].map((visit) => ({
      id: visit.block.id,
      type: visit.block.type,
      nested: visit.parent !== null,
      truthSupported: provenance.data.bindings
        .filter((binding) => 'blockId' in binding && binding.blockId === visit.block.id)
        .every((binding) => ['documented', 'synthesis'].includes(truth.get(binding.claimId) ?? 'unknown')),
    })),
  };
}

async function readHead(db: Transaction<Database>, ref: CoverageRef): Promise<CoverageHead | undefined> {
  const result = await sql<{
    revision: number;
    status: 'active' | 'retracted';
    mapping_sha256: string;
    command_sha256: string;
    semantic_review_reference: string;
    mapping: unknown;
  }>`select r.* from content.coverage_heads h join content.coverage_revisions r
    on r.asset_id=h.asset_id and r.asset_revision=h.asset_revision and r.revision=h.revision
    where h.asset_id=${ref.assetId}::uuid and h.asset_revision=${ref.assetRevision}`.execute(db);
  const row = result.rows[0];
  if (!row) return undefined;
  const mapping = CoverageMappingSchema.parse(row.mapping);
  if (canonicalSha256(mapping) !== row.mapping_sha256) throw new Error('CONTENT_COVERAGE_STORED_HASH_INVALID');
  return {
    authority: { ...ref, headRevision: row.revision, mappingSha256: row.mapping_sha256 },
    status: row.status,
    mapping,
    commandSha256: row.command_sha256,
    semanticReviewReference: row.semantic_review_reference,
  };
}

/** Standalone shared Content transaction. There is no authority-minting function on public.ts. */
export function makeCoverageAdmissionPorts(
  db: Kysely<Database>,
  reviewed: CoverageAdmissionPorts['reviewed'],
): CoverageAdmissionPorts {
  return {
    hash: canonicalSha256,
    bytes: (value) => utf8ByteLength(canonicalJson(value)),
    catalogue: coverageCatalogue,
    reviewed,
    inAdmission: makeAdmissionStore(db).inAdmission,
    async lockTarget(tx: AdmissionTx, ref: CoverageRef) {
      const trx = admissionTransaction(tx);
      await sql`select pg_advisory_xact_lock(hashtextextended(${`content.coverage:${ref.assetId}:${String(ref.assetRevision)}`},0))`.execute(
        trx,
      );
      await sql`select id from content.assets where id=${ref.assetId}::uuid for share`.execute(trx);
      await sql`select revision from content.coverage_heads where asset_id=${ref.assetId}::uuid and asset_revision=${ref.assetRevision} for update`.execute(
        trx,
      );
      return readTarget(trx, ref);
    },
    readHead: (tx, ref) => readHead(admissionTransaction(tx), ref),
    async append(tx, command, head) {
      const trx = admissionTransaction(tx);
      await sql`insert into content.coverage_revisions(asset_id,asset_revision,revision,status,mapping_sha256,command_sha256,semantic_review_reference,mapping)
        values(${command.assetId}::uuid,${command.assetRevision},${head.authority.headRevision},${head.status},${head.authority.mappingSha256},${head.commandSha256},${head.semanticReviewReference},${JSON.stringify(head.mapping)}::jsonb)`.execute(
        trx,
      );
      if (command.expectedHeadRevision === 0) {
        await sql`insert into content.coverage_heads(asset_id,asset_revision,revision) values(${command.assetId}::uuid,${command.assetRevision},${head.authority.headRevision})`.execute(
          trx,
        );
      } else {
        const changed =
          await sql`update content.coverage_heads set revision=${head.authority.headRevision} where asset_id=${command.assetId}::uuid and asset_revision=${command.assetRevision} and revision=${command.expectedHeadRevision} returning revision`.execute(
            trx,
          );
        if (changed.rows.length !== 1) throw new Error('CONTENT_COVERAGE_HEAD_STALE');
      }
    },
  };
}

/** Composition-only, default-deny admission capability bound to source-reviewed command digests. */
export function coverageAdmissionUseCase(db: Kysely<Database>) {
  return makeAdmitCoverage(
    makeCoverageAdmissionPorts(db, (digest, reference) =>
      SOURCE_REVIEWED_COMMANDS.some(
        (review) => review.commandSha256 === digest && review.semanticReviewReference === reference,
      ),
    ),
  );
}

export const readAdmittedCoverageMapping: ReadAdmittedCoverageMapping = async (scope, input) => {
  const ref = CoverageRefSchema.parse(input);
  const trx = transactionOf(scope);
  const target = await readTarget(trx, ref);
  if (!target) return { kind: 'unavailable' };
  const head = await readHead(trx, ref);
  if (!head) return { kind: 'unmapped' };
  if (head.status === 'retracted') return { kind: 'retracted', authority: head.authority };
  validateCoverageMapping(head.mapping, target, coverageCatalogue);
  return { kind: 'mapped', head };
};

const Authorities = z.array(CoverageAuthoritySchema).min(1).max(100);
export const lockCurrentCoverageAuthorities: LockCurrentCoverageAuthorities = async (scope, input) => {
  const expected = Authorities.parse(input);
  if (
    utf8ByteLength(canonicalJson(expected)) > 131072 ||
    new Set(expected.map((ref) => `${ref.assetId}@${String(ref.assetRevision)}`)).size !== expected.length
  )
    throw new Error('CONTENT_COVERAGE_AUTHORITY_LIMIT');
  expected.sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : a.assetRevision - b.assetRevision));
  const trx = transactionOf(scope);
  // Personal root -> canonical assets -> canonical mapping heads. Admission never takes personal roots.
  for (const ref of expected)
    await sql`select id from content.assets where id=${ref.assetId}::uuid for share`.execute(trx);
  for (const ref of expected) {
    await sql`select revision from content.coverage_heads where asset_id=${ref.assetId}::uuid and asset_revision=${ref.assetRevision} for share`.execute(
      trx,
    );
    const current = await readAdmittedCoverageMapping(scope, {
      assetId: ref.assetId,
      assetRevision: ref.assetRevision,
    });
    if (
      current.kind !== 'mapped' ||
      current.head.authority.headRevision !== ref.headRevision ||
      current.head.authority.mappingSha256 !== ref.mappingSha256
    )
      return false;
  }
  return true;
};
