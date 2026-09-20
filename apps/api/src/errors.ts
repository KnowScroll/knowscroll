/** Shared HTTP error type for apps/api/src/**: a typed status/message pair that `app.ts`'s global
 * error handler turns into the standard `{error:string}` shape. Kept in its own file so route
 * helper modules (e.g. `media.ts`) can throw it without an import cycle back into `app.ts`. */
export class HttpError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}
