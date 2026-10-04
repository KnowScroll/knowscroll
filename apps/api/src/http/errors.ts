/**
 * The API's error contract. Errors are mapped to responses in exactly one place, the global error
 * handler in `app.ts`: `UnauthorizedSession` becomes 401, and any other `Error` with a `statusCode`
 * answers that status with its `message` as `{error}`. Only 4xx and 503 keep their message; every
 * other 5xx (and an error with no usable status) becomes 500 'Internal operation failed', so
 * internal failures never leak details. Domain errors from `packages/db` carry `statusCode` and
 * are thrown through untouched. The two `kind`-style db refusals (`TraceRevisitError`,
 * `ExplicitAskError`) are mapped to `HttpError` by a small named function beside their route.
 * Kept in its own file so helper modules (e.g. `media/stream.ts`) can throw `HttpError` without
 * an import cycle back into `app.ts`.
 */
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
