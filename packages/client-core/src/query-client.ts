import { ORPCError } from '@orpc/client';
import { QueryClient } from '@tanstack/react-query';

/** Queries retry at most this many times, and only for failures that may pass on their own. */
const maxQueryRetries = 2;

/**
 * Whether a failed query may be tried again: a network failure or a server-side 5xx can pass on
 * its own; a 4xx answer (invalid, unauthenticated, forbidden, not found) will not.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= maxQueryRetries) return false;
  if (error instanceof ORPCError) return error.status >= 500;
  return error instanceof TypeError;
}

/** 1 s, 2 s, 4 s … capped at 8 s. */
export function queryRetryDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 8000);
}

/**
 * The TanStack Query client for one account scope. Commands (mutations) never retry: their
 * outcome may be unknown, and an unknown outcome is reconciled through a durable read, never
 * resent blindly (blueprint §19). Account-scoped query keys arrive with the AccountScope (#226),
 * which owns one client per (account, privacy epoch) and discards it on switch, logout or reset.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: shouldRetryQuery,
        retryDelay: queryRetryDelay,
      },
      mutations: {
        retry: false,
      },
    },
  });
}
