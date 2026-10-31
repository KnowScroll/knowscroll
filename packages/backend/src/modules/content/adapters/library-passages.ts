import { sql, type Kysely } from 'kysely';
import {
  SCROLL_DOCUMENT_V2_SCHEMA_VERSION,
  parseDocument,
  parseDocumentV2,
  projectText,
  walkBlocks,
} from '@knowscroll/scroll-model';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { CONCEPTS } from '../domain/concepts.js';
import type { LibraryPassageSource, ReadLibraryPassageText, ReadLibraryPassages } from '../public.js';
import { notUnderReview } from './review-gate-sql.js';

interface Row {
  asset_id: string;
  revision: number;
  title: string;
  summary: string;
  document: unknown;
}

type Block = LibraryPassageSource['blocks'][number];

/** The most Scrolls one read looks at: a bound on the documents parsed, not on the answer. */
const READ_LIMIT_MAX = 100;

/** The prose blocks of a stored Scroll document, whichever schema it has. Anything that does not parse has none. */
export function proseBlocksOf(stored: unknown): readonly Block[] {
  if ((stored as { schemaVersion?: unknown } | null)?.schemaVersion === SCROLL_DOCUMENT_V2_SCHEMA_VERSION) {
    const parsed = parseDocumentV2(stored);
    if (parsed.kind !== 'valid') return [];
    return parsed.document.stops.flatMap((stop): Block[] => {
      if (stop.kind !== 'read') return [];
      const prose = stop.blocks.flatMap((block) => (block.type === 'heading' ? [] : [block.text]));
      return prose.length === 0 ? [] : [{ blockId: stop.id, text: prose.join(' ') }];
    });
  }
  const parsed = parseDocument(stored);
  if (parsed.kind !== 'valid') return [];
  return [...walkBlocks(parsed.document.sections)].flatMap(({ block }): Block[] => {
    if (block.type !== 'paragraph') return [];
    const text = projectText(block);
    return text === null ? [] : [{ blockId: block.id, text }];
  });
}

/** The topic IDs a library topic covers: a system covers each of its planets, a planet itself. */
function topicIdsOf(topic: { readonly kind: 'system' | 'planet'; readonly id: string }): readonly string[] {
  return topic.kind === 'planet'
    ? CONCEPTS.some((concept) => concept.id === topic.id && concept.parent !== null)
      ? [topic.id]
      : []
    : CONCEPTS.filter((concept) => concept.parent === topic.id).map((concept) => concept.id);
}

/** A Scroll made for a thread belongs to that thread and is nobody's daily item (D-049). */
const notOrdered = sql`not exists (select 1 from content.made_to_order_scrolls o where o.asset_id = r.asset_id)`;

/** The columns and joins both reads share: the current revision of an admitted Scroll that anyone may be served. */
const servedScrolls = sql`from content.assets a
  join content.asset_revisions r on r.asset_id = a.id and r.revision = a.revision
  join content.discovery_revisions d on d.asset_id = r.asset_id and d.asset_revision = r.revision
  where a.status = 'admitted' and a.kind = 'scroll' and ${notOrdered} and ${notUnderReview('r.asset_id', 'r.revision')}`;

/**
 * The library Scrolls under a topic with their prose (see `ReadLibraryPassages`). A Scroll counts under a topic when that
 * topic is its primary encounter topic. Reads the pool outside any transaction: shared, immutable content.
 */
export const makeReadLibraryPassages =
  (db: Kysely<Database>): ReadLibraryPassages =>
  async (topic, limit, only) => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > READ_LIMIT_MAX) throw new Error('LIBRARY_PASSAGES_LIMIT');
    const topicIds = topicIdsOf(topic);
    if (topicIds.length === 0) return [];
    const result = await sql<Row>`select r.asset_id, r.revision, r.title, d.summary, r.document
      ${servedScrolls}
      ${only === undefined ? sql`` : sql`and r.asset_id = ${only.assetId}::uuid and r.revision = ${only.assetRevision}`}
      and exists (select 1 from content.encounter_topics t where t.asset_id = r.asset_id
        and t.asset_revision = r.revision and t.role = 'primary' and t.topic_id = any(${topicIds}::text[]))
      order by r.asset_id limit ${limit}`.execute(db);
    return result.rows.flatMap((row): LibraryPassageSource[] => {
      const blocks = proseBlocksOf(row.document);
      return blocks.length === 0
        ? []
        : [{ assetId: row.asset_id, assetRevision: row.revision, title: row.title, summary: row.summary, blocks }];
    });
  };

/** The text of one block of an exact revision, while that revision is still the current one anyone may be served. */
export const makeReadLibraryPassageText =
  (db: Kysely<Database>): ReadLibraryPassageText =>
  async (ref) => {
    const result = await sql<Row>`select r.asset_id, r.revision, r.title, d.summary, r.document
      ${servedScrolls} and r.asset_id = ${ref.assetId}::uuid and r.revision = ${ref.assetRevision}`.execute(db);
    const [row] = result.rows;
    return row === undefined
      ? undefined
      : proseBlocksOf(row.document).find((block) => block.blockId === ref.blockId)?.text;
  };
