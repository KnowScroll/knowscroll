import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import type { PersonalAuthority } from '@knowscroll/backend/modules/identity';

/**
 * CI fixtures: rows a test needs that later stories create through real flows (accounts and
 * universes through S1.3 sign-in, assets through Phase 2 admission). Every ID is random, so a
 * fixture can never collide with or be mistaken for product data.
 */
export interface FixturePerson {
  readonly accountId: string;
  readonly universeId: string;
  readonly authority: PersonalAuthority;
}

export async function seedPerson(
  db: Kysely<Database>,
  options: { readonly privacyEpoch?: number } = {},
): Promise<FixturePerson> {
  const accountId = randomUUID();
  const universeId = randomUUID();
  const privacyEpoch = options.privacyEpoch ?? 1;
  await db.insertInto('identity.accounts').values({ id: accountId }).execute();
  await db
    .insertInto('identity.universes')
    .values({ id: universeId, account_id: accountId, privacy_epoch: privacyEpoch })
    .execute();
  return { accountId, universeId, authority: { universeId, privacyEpoch, actor: { kind: 'account', accountId } } };
}

export async function seedAsset(
  db: Kysely<Database>,
  options: { readonly revision?: number; readonly status?: 'admitted' | 'withdrawn' } = {},
): Promise<{ readonly assetId: string; readonly revision: number }> {
  const assetId = randomUUID();
  const revision = options.revision ?? 1;
  await db
    .insertInto('content.assets')
    .values({ id: assetId, revision, kind: 'reel', status: options.status ?? 'admitted' })
    .execute();
  return { assetId, revision };
}
