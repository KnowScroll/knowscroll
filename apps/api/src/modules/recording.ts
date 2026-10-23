import type { Provider } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { ApiConfig } from '@knowscroll/backend/infrastructure/config';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { recordingPolicyFor, recordingPolicyProviders } from '@knowscroll/backend/modules/identity/nest-providers';
import { API_CONFIG, DATABASE } from '../tokens.js';

const RECORDING_CASES = Symbol('api.recording-use-cases');
/** Actual owner use cases and genuine collection fence, without a worker/provider dependency. */
export const recordingWiring: Provider[] = [
  {
    provide: RECORDING_CASES,
    inject: [DATABASE, API_CONFIG],
    useFactory: (db: Kysely<Database>, config: ApiConfig) =>
      recordingPolicyFor(db, { lockTimeoutMs: config.scopeLockTimeoutMs }),
  },
  ...recordingPolicyProviders({ useCases: RECORDING_CASES }),
];
