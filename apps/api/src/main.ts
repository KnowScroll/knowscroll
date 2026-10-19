import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigurationError, readApiConfig, worldForDiagnostics } from '@knowscroll/backend/infrastructure/config';
import { runProcess } from '@knowscroll/backend/infrastructure/lifecycle';
import { FrameworkLogAdapter, createEventLog } from '@knowscroll/backend/infrastructure/observability';
import { createDatabase } from '@knowscroll/backend/infrastructure/postgres';
import { AppModule } from './app.module.js';
import { bodyErrorMiddleware, requireJsonBodies } from './http/problems.js';
import { requestContextMiddleware } from './http/request-context.js';

/**
 * API process entry point. Order matters: validate configuration, open the database, build the
 * Nest application from the composition root, then listen. Stop reverses it: stop accepting
 * requests, let in-flight requests finish, then close the database.
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
      const database = createDatabase<unknown>(config.database, {
        onIdleClientError: (error) => logEvent('database.idle_client_error', { error }),
      });
      const app = await NestFactory.create<NestExpressApplication>(
        AppModule.forRoot({ config, db: database.db, logEvent }),
        {
          bodyParser: false,
          logger: new FrameworkLogAdapter(logEvent),
          abortOnError: false,
        },
      );
      app.disable('x-powered-by');
      app.use(requestContextMiddleware(logEvent));
      app.use(requireJsonBodies());
      app.useBodyParser('json', { limit: config.bodyLimitBytes });
      app.use(bodyErrorMiddleware(logEvent));
      await app.listen(config.listen.port, config.listen.host);
      return {
        async stop() {
          await app.close();
          await database.close();
        },
      };
    },
  });
}

await main();
