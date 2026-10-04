/**
 * The three things almost every route does before or after its db call, each with exactly the
 * behavior the routes had inline: refuse unparseable input with a 400 and the route's own message,
 * refuse a non-UUID id the same way, and mark a response as not cacheable.
 */
import type { FastifyReply } from 'fastify';
import type { z } from 'zod';
import { uuid } from '@knowscroll/contracts';
import { HttpError } from './errors.ts';

/** `schema.safeParse(value)`'s data, or `HttpError(400, message)`. */
export function parseInput<S extends z.ZodType>(
  schema: S,
  value: unknown,
  message: string,
): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, message);
  return parsed.data;
}

/** Nothing when `value` is a UUID; otherwise `HttpError(400, message)`. */
export function requireUuid(value: unknown, message: string): void {
  if (!uuid.safeParse(value).success) throw new HttpError(400, message);
}

/** Sets `Cache-Control: no-store` and returns the reply, for chaining into `.send()`. */
export function noStore(reply: FastifyReply): FastifyReply {
  return reply.header('Cache-Control', 'no-store');
}
