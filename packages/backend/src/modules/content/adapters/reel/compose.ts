import { createHash, randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type pg from 'pg';
import type { Database } from '../../../../infrastructure/postgres/database.js';
import { makeCheckScript } from '../../application/reel/check-script.js';
import { makeReelOperator, type ReelOperator } from '../../application/reel/operator.js';
import { cutroomEngine } from './engine.js';
import { makeReelMedia } from './media.js';
import { postgresReelCatalogue } from './postgres-catalogue.js';
import { postgresReelLedger } from './postgres-ledger.js';
import { postgresReelPublisher } from './postgres-publisher.js';
import { poolOfSharedPool } from './pool.js';
import { reelScripts } from './scripts.js';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The offline script check: the shipped scripts and the product's rules, with no world behind them. */
export const checkShippedReelScript = makeCheckScript({ scripts: reelScripts, sha256 });

export interface ReelSettings {
  readonly world: string;
  readonly cutroomOrigin: string;
  readonly cutroomArtifactRoot: string;
  readonly mediaRoot: string;
  readonly ffprobePath?: string | undefined;
  /** The clock; only tests set it. */
  readonly now?: (() => Date) | undefined;
}

/**
 * The worker operator's Reel commands over real adapters: this world's database, the shared pool's
 * database, Cutroom's loopback HTTP and the world's media folder. The caller owns both database
 * handles and closes them.
 */
export function composeReelOperator(db: Kysely<Database>, poolDatabase: pg.Pool, settings: ReelSettings): ReelOperator {
  const newId = () => randomUUID();
  return makeReelOperator({
    world: settings.world,
    scripts: reelScripts,
    ledger: postgresReelLedger(db, newId),
    pool: poolOfSharedPool(poolDatabase),
    engine: cutroomEngine({ origin: settings.cutroomOrigin }),
    media: makeReelMedia({
      origin: settings.cutroomOrigin,
      artifactRoot: settings.cutroomArtifactRoot,
      mediaRoot: settings.mediaRoot,
      ffprobePath: settings.ffprobePath,
    }),
    catalogue: postgresReelCatalogue(db),
    publisher: postgresReelPublisher(db),
    sha256,
    newId,
    now: settings.now ?? (() => new Date()),
  });
}
