import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { ConfigurationError, readApiConfig, worldForDiagnostics } from '@knowscroll/backend/infrastructure/config';
import { createBoss, makeEnqueueJob } from '@knowscroll/backend/infrastructure/jobs';
import { runProcess } from '@knowscroll/backend/infrastructure/lifecycle';
import { ScopeNoticeRelay, type ScopeNotice, type ScopeNoticeSink } from '@knowscroll/backend/infrastructure/notices';
import { FrameworkLogAdapter, createEventLog } from '@knowscroll/backend/infrastructure/observability';
import { createDatabase, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { AppModule } from './app.module.js';
import { apiSecurityHeaders, noStoreForAuth, originGuard, sessionCookieName } from './http/auth-credentials.js';
import { bodyErrorMiddleware, requireJsonBodies } from './http/problems.js';
import { requestContextMiddleware } from './http/request-context.js';
import { ScopeGateway } from './realtime/scope.gateway.js';

/**
 * API process entry point. Start order: validate configuration → database pool → pg-boss
 * (producer: sends inside our transactions, claims nothing) → Nest application from the
 * composition root (HTTP + Socket.IO) → LISTEN relay → accept connections. LISTEN is established
 * before the first subscriber can connect, so no hint is lost between a subscribe and the relay.
 * Stop reverses it: stop accepting (HTTP and sockets), stop the relay, stop pg-boss, close the pool.
 */
async function main(): Promise<void> {
  const bootLog = createEventLog({
    service: 'api',
    environment: worldForDiagnostics(process.env),
    revision: 'unknown',
  });
  let config;
  try {
    config = readApiConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigurationError) bootLog('config.invalid', { problems: error.problems });
    else bootLog('process.start_failed', { reasonCode: 'config_failed', error });
    process.exit(1);
  }
  const logEvent = createEventLog({ service: 'api', environment: config.world, revision: config.commit });

  await runProcess({
    logEvent,
    shutdownGraceMs: config.shutdownGraceMs,
    async start() {
      const database = createDatabase<Database>(config.database, {
        onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
      });
      const boss = createBoss(config.database, 'producer', {
        onError: (error) => logEvent('jobs.error', { error }),
        onWarning: (reasonCode) => logEvent('jobs.warning', { reasonCode }),
      });
      await boss.start();
      // The relay exists before Nest (its state feeds /health); it starts once the gateway exists.
      const target: { gateway?: ScopeNoticeSink } = {};
      const sink: ScopeNoticeSink = {
        onNotice: (notice: ScopeNotice) => target.gateway?.onNotice(notice),
        onResync: (reason) => target.gateway?.onResync(reason),
        onAccessRevoked: (accountId) => target.gateway?.onAccessRevoked(accountId),
      };
      const relay = new ScopeNoticeRelay({ database: config.database, sink, logEvent });
      const app = await NestFactory.create<NestExpressApplication>(
        AppModule.forRoot({
          config,
          db: database.db,
          enqueueJob: makeEnqueueJob(boss),
          logEvent,
          relayState: () => relay.state,
        }),
        {
          bodyParser: false,
          logger: new FrameworkLogAdapter(logEvent),
          abortOnError: false,
        },
      );
      app.disable('x-powered-by');
      app.useWebSocketAdapter(new IoAdapter(app));
      app.use(apiSecurityHeaders());
      app.use(requestContextMiddleware(logEvent));
      app.use(noStoreForAuth());
      app.use(
        originGuard({
          publicOrigin: config.identity.publicOrigin,
          cookieName: sessionCookieName(config.identity.secureCookies),
          logEvent,
        }),
      );
      app.use(requireJsonBodies());
      app.useBodyParser('json', { limit: config.bodyLimitBytes });
      app.use(bodyErrorMiddleware(logEvent));
      await app.init();
      target.gateway = app.get(ScopeGateway);
      await relay.start();
      await app.listen(config.listen.port, config.listen.host);
      return {
        async stop() {
          await app.close();
          await relay.stop();
          await boss.stop({ graceful: true, timeout: config.shutdownGraceMs });
          await database.close();
        },
      };
    },
  });
}

await main();
