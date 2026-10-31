import { sql, type Kysely } from 'kysely';
import { Framing } from '@knowscroll/scroll-model';
import type { Database } from '../../../infrastructure/postgres/database.js';
import type { ScrollV2Plan, StageKitId } from '../domain/library/plan.js';
import { isMadeToOrderKey, type MadeToOrderKey } from '../domain/order-key.js';
import { parseScrollTopic, TOPICS, type ScrollTopic } from './topics.js';
import {
  libraryIdentity,
  writerFormatOf,
  type PublicationIdentity,
  type WriterFormat,
  type WriterMode,
} from './writer.js';

/** A key the production job may run: a library recipe or an order. */
export type ProductionKey = ScrollTopic | MadeToOrderKey;

/** What one production job writes: where its Scroll goes, what the writer is told and how it is framed. */
export interface ProductionSubject {
  readonly key: ProductionKey;
  readonly mode: WriterMode;
  readonly identity: PublicationIdentity;
  readonly brief: string;
  readonly pages: readonly string[];
  readonly format: WriterFormat;
  /**
   * `library`: published Scrolls are attributed to their planet and given coverage. `none`: an order
   * is a hypothetical or a lens on someone's content and never grows the real-world map (D-049).
   */
  readonly attribution: 'library' | 'none';
  /** Present when the library plan marks the recipe as a `scroll-document.v2`; absent for v1 recipes and orders. */
  readonly scrollV2?: ScrollV2Plan;
  /** The kit that draws this recipe's subject, when the plan names one (D-125, D-194). Only a `stage` Scroll uses it. */
  readonly stageKit?: StageKitId;
}

/** The subject of a library recipe. */
export function librarySubject(topic: ScrollTopic): ProductionSubject {
  const recipe = TOPICS[topic];
  return {
    key: topic,
    mode: 'library',
    identity: libraryIdentity(topic),
    brief: recipe.brief,
    pages: recipe.pages,
    format: writerFormatOf(recipe),
    attribution: 'library',
    ...(recipe.scrollV2 === undefined ? {} : { scrollV2: recipe.scrollV2 }),
    ...(recipe.stageKit === undefined ? {} : { stageKit: recipe.stageKit }),
  };
}

interface OrderRow {
  readonly recipe: string;
  readonly asset_id: string;
  readonly explanation_unit_id: string;
  readonly mode: 'what_if' | 'perspective' | 'question';
  readonly brief: string;
  readonly pages: readonly string[];
  readonly kicker: string;
  readonly framing: unknown;
}

/**
 * The subject of a Scroll ordered from code, read from the stored order, or `undefined` when no such
 * order exists or its brief was wiped by an erasure (nothing is written for words that were erased). A what-if and a
 * perspective are comparison Scrolls: they set the changed world beside the original. The answer to a question is prose.
 */
export async function madeToOrderSubject(
  db: Kysely<Database>,
  key: MadeToOrderKey,
): Promise<ProductionSubject | undefined> {
  const row = (
    await sql<OrderRow>`select recipe, asset_id, explanation_unit_id, mode, brief, pages, kicker, framing
      from content.made_to_order_scrolls where recipe = ${key}`.execute(db)
  ).rows[0];
  const framing = row === undefined ? undefined : Framing.safeParse(row.framing);
  if (row === undefined || !framing?.success || row.brief === '') return undefined;
  return {
    key,
    mode: row.mode,
    identity: {
      assetId: row.asset_id,
      explanationUnitId: row.explanation_unit_id,
      kicker: row.kicker,
      framing: framing.data,
    },
    brief: row.brief,
    pages: row.pages,
    format: row.mode === 'question' ? 'plain' : 'comparison',
    attribution: 'none',
  };
}

/** The subject a job's key names, or `undefined` for a key that is neither a library recipe nor a stored order. */
export async function subjectOf(db: Kysely<Database>, key: string): Promise<ProductionSubject | undefined> {
  const library = parseScrollTopic(key);
  if (library !== undefined) return librarySubject(library);
  return isMadeToOrderKey(key) ? madeToOrderSubject(db, key) : undefined;
}
