import type { Kysely } from 'kysely';
import type { IdentitySettings } from '@knowscroll/backend/infrastructure/config';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  identityProviders,
  identityUseCases,
  signInProviders,
} from '@knowscroll/backend/modules/identity/nest-providers';
import { DATABASE, IDENTITY_USE_CASES } from '../tokens.js';

/**
 * Identity wiring for the API composition root: the read ports callers and sockets use, and the
 * sign-in use cases (sessions, links, mail) built once from the process's settings. The mail
 * sender is chosen by `IdentitySettings.mail`: AgentMail, or the CI fixture sender, which
 * configuration refuses outside `NODE_ENV=test` in a `ci`/`local` world.
 */
export function identityWiring(resources: {
  readonly settings: IdentitySettings;
  readonly lockTimeoutMs: number;
  readonly logEvent: LogEvent;
}) {
  return [
    ...identityProviders({ database: DATABASE }),
    {
      provide: IDENTITY_USE_CASES,
      inject: [DATABASE],
      useFactory: (db: Kysely<Database>) => identityUseCases({ db, ...resources }),
    },
    ...signInProviders({ useCases: IDENTITY_USE_CASES }),
  ];
}

/**
 * The operator command's use case (`dist/operator.js issue-sign-in`), over its own database
 * handle. Re-exported here because only composition roots choose concrete implementations.
 */
export { operatorSignInUseCase } from '@knowscroll/backend/modules/identity/nest-providers';
