import { makeMediaAccess } from '@knowscroll/backend/modules/content/nest-providers';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { localMediaStore } from '@knowscroll/backend/infrastructure/media-store';
import type { Kysely } from 'kysely';
import { mediaGrants } from '../http/media-grants.js';
import { API_CONFIG, DATABASE } from '../tokens.js';
import type { ApiConfig } from '@knowscroll/backend/infrastructure/config';

export const MEDIA_ACCESS = Symbol('media.access');
export const MEDIA_STORE = Symbol('media.store');
export const MEDIA_GRANTS = Symbol('media.grants');
export type MediaAccess = ReturnType<typeof makeMediaAccess>;
export type MediaGrants = ReturnType<typeof mediaGrants>;
export const mediaWiring = [
  {
    provide: MEDIA_ACCESS,
    inject: [DATABASE, API_CONFIG],
    useFactory: (db: Kysely<Database>, config: ApiConfig) => makeMediaAccess(db, config.scopeLockTimeoutMs),
  },
  {
    provide: MEDIA_STORE,
    inject: [API_CONFIG],
    useFactory: (config: ApiConfig) => (config.mediaRoot === undefined ? undefined : localMediaStore(config.mediaRoot)),
  },
  {
    provide: MEDIA_GRANTS,
    inject: [API_CONFIG],
    useFactory: (config: ApiConfig) => mediaGrants(`knowscroll-media:${config.world}`),
  },
];
