import type { Provider } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { ApiConfig } from '@knowscroll/backend/infrastructure/config';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { FENCE_ACCOUNT_PAIR, type FenceAccountPair } from '@knowscroll/backend/modules/identity';
import { accountAccessUseCases } from '@knowscroll/backend/modules/identity/nest-providers';
import { socialProviders } from '@knowscroll/backend/modules/social/nest-providers';
import { API_CONFIG, DATABASE, WITH_PERSONAL_SCOPE } from '../tokens.js';

/** Reuse the existing own-account barrier. Bind only the pair port, never invalidation/erasure. */
export const socialWiring: Provider[] = [
  {
    provide: FENCE_ACCOUNT_PAIR,
    inject: [DATABASE, API_CONFIG],
    useFactory: (db: Kysely<Database>, config: ApiConfig): FenceAccountPair =>
      accountAccessUseCases({ db, lockTimeoutMs: config.scopeLockTimeoutMs }).fenceAccountPair,
  },
  ...socialProviders({ withPersonalScope: WITH_PERSONAL_SCOPE }),
];
