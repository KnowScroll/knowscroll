import type { ORPCError, ORPCModuleConfig } from '@orpc/nest';
import type { Response } from 'express';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { problemFromOrpcError, sendProblem } from './problems.js';
import type { ProblemDetails } from '@knowscroll/contracts';

/**
 * oRPC integration settings. Errors from every contract handler, including input validation,
 * are encoded once as RFC 9457 problem details and sent as `application/problem+json`.
 */
export function orpcModuleConfig(logEvent: LogEvent): ORPCModuleConfig {
  return {
    customErrorResponseBodyEncoder: (error: ORPCError<string, unknown>) => problemFromOrpcError(error, logEvent),
    sendResponseInterceptors: [
      (options) => {
        if (options.standardResponse.status >= 400) {
          sendProblem(options.response as Response, options.standardResponse.body as ProblemDetails);
          return Promise.resolve(undefined);
        }
        return options.next();
      },
    ],
  };
}
