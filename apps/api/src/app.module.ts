import { identityScopeOwnerProviders } from '@knowscroll/backend/modules/identity/nest-providers';
import { supplyProviders } from '@knowscroll/backend/modules/supply/nest-providers';
import { mediaWiring } from './modules/media.js';
import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ORPCModule } from '@orpc/nest';
import type { Kysely } from 'kysely';
import type { ApiConfig } from '@knowscroll/backend/infrastructure/config';
import type { EnqueueJob, createBoss } from '@knowscroll/backend/infrastructure/jobs';
import type { RelayState } from '@knowscroll/backend/infrastructure/notices';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  READ_ACCOUNT_UNIVERSE,
  RESOLVE_SESSION,
  SESSION_VALID,
  type ReadAccountUniverse,
  type ResolveSession,
  type SessionValid,
} from '@knowscroll/backend/modules/identity';
import { sessionCookieName } from './http/auth-credentials.js';
import { createAuthLimiters } from './http/auth-rate-limit.js';
import { selectCallers } from './http/callers.js';
import { orpcModuleConfig } from './http/orpc.js';
import { ProblemExceptionFilter } from './http/problems.js';
import { contentWiring } from './modules/content.js';
import { sceneWiring } from './modules/scenes.js';
import { evidenceWiring } from './modules/evidence.js';
import { experienceWiring } from './modules/experience.js';
import { identityWiring } from './modules/identity.js';
import { privacyWiring } from './modules/privacy.js';
import { recordingWiring } from './modules/recording.js';
import { socialWiring } from './modules/social.js';
import { ScopeGateway } from './realtime/scope.gateway.js';
import { apiControllers } from './routes.js';
import {
  API_CONFIG,
  AUTH_LIMITERS,
  CALLERS,
  DATABASE,
  ENQUEUE_JOB,
  PG_BOSS,
  LOG_EVENT,
  RELAY_STATE,
  WITH_PERSONAL_SCOPE,
} from './tokens.js';

/** Long-lived resources created by `main.ts` before Nest starts and closed after Nest stops. */
export interface ApiResources {
  readonly config: ApiConfig;
  readonly db: Kysely<Database>;
  readonly boss: ReturnType<typeof createBoss>;
  readonly enqueueJob: EnqueueJob;
  readonly logEvent: LogEvent;
  readonly relayState: () => RelayState;
}

/**
 * The API composition root (blueprint §22). It binds every token to a concrete adapter (or a
 * module's nest-providers) and lists the controllers and the gateway; nothing else constructs
 * dependencies.
 */
@Module({})
export class AppModule {
  static forRoot(resources: ApiResources): DynamicModule {
    return {
      module: AppModule,
      imports: [ORPCModule.forRoot(orpcModuleConfig(resources.logEvent))],
      controllers: apiControllers,
      providers: [
        { provide: API_CONFIG, useValue: resources.config },
        { provide: DATABASE, useValue: resources.db },
        { provide: PG_BOSS, useValue: resources.boss },
        { provide: LOG_EVENT, useValue: resources.logEvent },
        { provide: ENQUEUE_JOB, useValue: resources.enqueueJob },
        { provide: RELAY_STATE, useValue: resources.relayState },
        {
          provide: WITH_PERSONAL_SCOPE,
          useValue: makeWithPersonalScope(resources.db, { lockTimeoutMs: resources.config.scopeLockTimeoutMs }),
        },
        // Production: identity's sessions (cookie on the web, bearer on native). The CI-only
        // test-bearer adapter is refused by configuration and again by selectCallers.
        {
          provide: CALLERS,
          inject: [READ_ACCOUNT_UNIVERSE, RESOLVE_SESSION, SESSION_VALID],
          useFactory: (
            readAccountUniverse: ReadAccountUniverse,
            resolveSession: ResolveSession,
            sessionValid: SessionValid,
          ) =>
            selectCallers(resources.config.authAdapter, resources.config, {
              readAccountUniverse,
              resolveSession,
              sessionValid,
              cookieName: sessionCookieName(resources.config.identity.secureCookies),
            }),
        },
        { provide: AUTH_LIMITERS, useFactory: () => createAuthLimiters() },
        { provide: APP_FILTER, useClass: ProblemExceptionFilter },
        ...identityWiring({
          settings: resources.config.identity,
          lockTimeoutMs: resources.config.scopeLockTimeoutMs,
          logEvent: resources.logEvent,
        }),
        ...identityScopeOwnerProviders(),
        ...privacyWiring(resources.config.scopeLockTimeoutMs),
        ...recordingWiring,
        ...contentWiring,
        ...mediaWiring,
        ...experienceWiring,
        ...socialWiring,
        ...supplyProviders({ withPersonalScope: WITH_PERSONAL_SCOPE, enqueueJob: ENQUEUE_JOB, config: API_CONFIG }),
        ...evidenceWiring,
        ...sceneWiring,
        ScopeGateway,
      ],
    };
  }
}
