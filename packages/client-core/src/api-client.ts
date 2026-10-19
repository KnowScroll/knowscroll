import { ORPCError, createORPCClient } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import {
  PROBLEM_MEDIA_TYPE,
  ProblemDetailsSchema,
  apiContract,
  type ApiContract,
  type ProblemDetails,
} from '@knowscroll/contracts';

/** The typed client of every route in `@knowscroll/contracts`. */
export type ApiClient = ContractRouterClient<ApiContract>;

export type ApiOrigin =
  | { readonly ok: true; readonly baseUrl: string }
  | { readonly ok: false; readonly reason: 'missing_origin' | 'invalid_origin' | 'insecure_origin' };

/** Hosts a development build may reach over plain HTTP (the Android emulator reaches the Mac as 10.0.2.2). */
const developmentHosts = new Set(['localhost', '127.0.0.1', '10.0.2.2']);

/**
 * Where the API lives (D-008, one origin per world). The web export is served by the same host as
 * the API, so the browser uses its own origin and never needs CORS. Native builds call the
 * configured world origin, which must be HTTPS except for a development host.
 */
export function resolveApiOrigin(
  options: { platform: 'web'; pageOrigin: string } | { platform: 'native'; configuredOrigin: string | undefined },
): ApiOrigin {
  const candidate = options.platform === 'web' ? options.pageOrigin : options.configuredOrigin;
  if (candidate === undefined || candidate.trim() === '') return { ok: false, reason: 'missing_origin' };
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, reason: 'invalid_origin' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'invalid_origin' };
  if (url.protocol === 'http:' && options.platform === 'native' && !developmentHosts.has(url.hostname)) {
    return { ok: false, reason: 'insecure_origin' };
  }
  return { ok: true, baseUrl: url.origin };
}

type Fetch = (input: Request, init?: RequestInit) => Promise<Response>;

/**
 * The API answers errors as RFC 9457 `application/problem+json`. oRPC parses JSON bodies only for
 * `application/json`, so problem bodies are re-labelled before decoding; nothing else changes.
 */
function problemAwareFetch(fetchImplementation: Fetch): Fetch {
  return async (request, init) => {
    const response = await fetchImplementation(request, init);
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.startsWith(PROBLEM_MEDIA_TYPE)) return response;
    const headers = new Headers(response.headers);
    headers.set('content-type', 'application/json');
    return new Response(await response.text(), { status: response.status, statusText: response.statusText, headers });
  };
}

/** Reads the problem document an API error carries, if it is one. */
export function apiProblem(error: unknown): ProblemDetails | undefined {
  if (!(error instanceof ORPCError)) return undefined;
  const parsed = ProblemDetailsSchema.safeParse(error.data);
  return parsed.success ? parsed.data : undefined;
}

export interface ApiClientOptions {
  readonly baseUrl: string;
  /** Defaults to the platform `fetch`. */
  readonly fetch?: Fetch;
}

/**
 * Creates the typed oRPC client over the API's OpenAPI routes. Errors that carry an RFC 9457
 * document become `ORPCError`s whose `data` is that document (read it with `apiProblem`).
 */
export function createApiClient(options: ApiClientOptions): ApiClient {
  const fetchImplementation: Fetch = options.fetch ?? ((request, init) => globalThis.fetch(request, init));
  const link = new OpenAPILink(apiContract, {
    url: options.baseUrl,
    fetch: problemAwareFetch(fetchImplementation),
    customErrorResponseBodyDecoder: (body, response) => {
      const parsed = ProblemDetailsSchema.safeParse(body);
      if (!parsed.success) return null;
      return new ORPCError(parsed.data.code, {
        status: response.status,
        message: parsed.data.title,
        data: parsed.data,
      });
    },
  });
  return createORPCClient<ApiClient>(link);
}
