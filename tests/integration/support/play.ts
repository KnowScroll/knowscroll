import {
  makeWithPersonalScope,
  fencePersonalRecording,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import { READ_SCROLL_PLAY_FACTS } from '@knowscroll/backend/modules/content';
import { readScrollPlayFacts } from '@knowscroll/backend/modules/content/nest-providers';
import { HAS_ACTIVATED_EXPOSURE } from '@knowscroll/backend/modules/experience';
import { hasActivatedExposure } from '@knowscroll/backend/modules/experience/nest-providers';
import { FENCE_OWN_ACCOUNT, FENCE_PERSONAL_RECORDING } from '@knowscroll/backend/modules/identity';
import { accountAccessUseCases } from '@knowscroll/backend/modules/identity/nest-providers';
import { PLAY_USE_CASES, type PlayUseCases } from '@knowscroll/backend/modules/play';
import { playProviders } from '@knowscroll/backend/modules/play/nest-providers';
import { callsOf, parseDocumentV2 } from '@knowscroll/scroll-model';
import type { TestDatabase } from './database.js';
import { buildFromProviders } from './providers.js';

const SCOPE = Symbol('test.withPersonalScope');

/** The play use cases from the same provider list the API composes, over a test database. */
export function playFor(database: TestDatabase<Database>): PlayUseCases {
  const values = new Map<symbol, unknown>([
    [SCOPE, makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 })],
    [FENCE_OWN_ACCOUNT, accountAccessUseCases({ db: database.db, lockTimeoutMs: 5_000 }).fenceOwnAccount],
    [FENCE_PERSONAL_RECORDING, fencePersonalRecording],
    [HAS_ACTIVATED_EXPOSURE, hasActivatedExposure],
    [READ_SCROLL_PLAY_FACTS, readScrollPlayFacts],
  ]);
  return buildFromProviders(playProviders({ withPersonalScope: SCOPE }), PLAY_USE_CASES, values) as PlayUseCases;
}

/** The calls of a stored v2 revision, read straight from its document (what the server judges against). */
export async function callsOfRevision(
  database: TestDatabase<Database>,
  scroll: { readonly assetId: string; readonly revision: number },
) {
  const row = await database.db
    .selectFrom('content.asset_revisions')
    .select('document')
    .where('asset_id', '=', scroll.assetId)
    .where('revision', '=', scroll.revision)
    .executeTakeFirstOrThrow();
  const parsed = parseDocumentV2(row.document);
  if (parsed.kind !== 'valid') throw new Error('the CI fixture must parse');
  return callsOf(parsed.document);
}

/** An option of a call that is right, and one that is not. */
export function picks(call: { readonly answer: number; readonly options: readonly string[] }) {
  return { right: call.answer, wrong: (call.answer + 1) % call.options.length };
}
