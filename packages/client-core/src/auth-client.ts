import {
  PROBLEM_MEDIA_TYPE,
  PeekSignInResponseSchema,
  ProblemDetailsSchema,
  type ProblemDetails,
  RedeemSignInResponseSchema,
  SessionResponseSchema,
  type RedeemSignInResponse,
  type SessionAccount,
  type SessionClient,
} from '@knowscroll/contracts';

type Fetch = (input: Request, init?: RequestInit) => Promise<Response>;

/** What asking for a sign-in link achieved (A01 email form and "Resend the link"). */
export type RequestLinkOutcome =
  | { readonly kind: 'requested' }
  | { readonly kind: 'invalid_address' }
  /** The address or this device asked too often; `retryAfterSeconds` from the answer when given. */
  | { readonly kind: 'rate_limited'; readonly retryAfterSeconds: number | undefined }
  | { readonly kind: 'unavailable' };

/**
 * Whose account a link opens, asked before redeeming it (review m8): the full address of a web
 * link, the masked one of a native link (re-review N6).
 */
export type PeekOutcome =
  | { readonly kind: 'usable'; readonly email: string }
  | { readonly kind: 'link_invalid' }
  | { readonly kind: 'rate_limited'; readonly retryAfterSeconds: number | undefined }
  | { readonly kind: 'unavailable' };

/** What redeeming a link achieved (the redeem page). */
export type RedeemOutcome =
  | { readonly kind: 'signed_in'; readonly response: RedeemSignInResponse }
  /** Expired, already used or unknown: one answer for each (A02 "This link didn't work"). */
  | { readonly kind: 'link_invalid' }
  | { readonly kind: 'rate_limited'; readonly retryAfterSeconds: number | undefined }
  /** Refused for another reason (account unavailable, a reused command ID); the code says which. */
  | { readonly kind: 'refused'; readonly code: string }
  | { readonly kind: 'unavailable' };

export type SessionOutcome =
  | {
      readonly kind: 'signed_in';
      readonly account: SessionAccount;
      readonly client: SessionClient;
      readonly expiresAt: string;
    }
  | { readonly kind: 'signed_out' }
  | { readonly kind: 'unavailable' };

/**
 * The `/auth/*` routes (D-018) for the scope manager. Plain `fetch` with the contract's schemas,
 * because these answers are read for their status and `Retry-After` as well as their body. On the
 * web the same-origin session cookie travels by itself; native passes its bearer header.
 * Never throws for an HTTP or network failure: each becomes a typed outcome.
 */
export interface AuthClient {
  /** `codeChallenge`: native only, the S256 challenge of the app's verifier (review m10). */
  requestLink(email: string, codeChallenge?: string): Promise<RequestLinkOutcome>;
  /** `codeVerifier`: native only; a native link answers only to its verifier. */
  peek(request: {
    readonly token: string;
    readonly client: SessionClient;
    readonly codeVerifier?: string;
  }): Promise<PeekOutcome>;
  redeem(request: {
    readonly token: string;
    readonly commandId: string;
    readonly client: SessionClient;
    /** Native only: the verifier the link's challenge was made from. */
    readonly codeVerifier?: string;
  }): Promise<RedeemOutcome>;
  session(): Promise<SessionOutcome>;
  signOut(options: { readonly everywhere: boolean }): Promise<'signed_out' | 'unavailable'>;
}

export interface AuthClientOptions {
  readonly baseUrl: string;
  readonly fetch?: Fetch;
  /** The native bearer header (`Bearer kss_…`), or `undefined` (web, or signed out). */
  readonly authorization: () => string | undefined;
  /** How long a session check may take before the API counts as unavailable. */
  readonly timeoutMs?: number;
}

async function problemOf(response: Response): Promise<ProblemDetails | undefined> {
  if (!(response.headers.get('content-type') ?? '').startsWith(PROBLEM_MEDIA_TYPE)) return undefined;
  const parsed = ProblemDetailsSchema.safeParse(await response.json().catch(() => undefined));
  return parsed.success ? parsed.data : undefined;
}

async function problemCode(response: Response): Promise<string | undefined> {
  return (await problemOf(response))?.code;
}

function retryAfter(response: Response): number | undefined {
  const value = Number(response.headers.get('retry-after'));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function createAuthClient(options: AuthClientOptions): AuthClient {
  const fetchImplementation: Fetch = options.fetch ?? ((request, init) => globalThis.fetch(request, init));
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function send(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response | undefined> {
    const headers = new Headers({ accept: 'application/json' });
    if (body !== undefined) headers.set('content-type', 'application/json');
    const authorization = options.authorization();
    if (authorization !== undefined) headers.set('authorization', authorization);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImplementation(
        new Request(`${options.baseUrl}${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          credentials: 'same-origin',
          signal: controller.signal,
        }),
      );
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async requestLink(email, codeChallenge) {
      const response = await send('POST', '/auth/sign-in', {
        email,
        ...(codeChallenge === undefined ? {} : { codeChallenge }),
      });
      if (response === undefined) return { kind: 'unavailable' };
      if (response.status === 202) return { kind: 'requested' };
      if (response.status === 429) return { kind: 'rate_limited', retryAfterSeconds: retryAfter(response) };
      const problem = await problemOf(response);
      // 422 on `codeChallenge`: native sign-in is not enabled on this world (re-review N1); the
      // app cannot sign in here, which reads as the API being unavailable.
      if (problem?.issues?.some((issue) => issue.path[0] === 'codeChallenge') === true) return { kind: 'unavailable' };
      // 422: outside the accepted address grammar; 400: not even a string of the right length.
      if (problem?.code === 'UNPROCESSABLE_REQUEST' || problem?.code === 'INVALID_REQUEST')
        return { kind: 'invalid_address' };
      return { kind: 'unavailable' };
    },

    async peek(request) {
      const response = await send('POST', '/auth/peek', request);
      if (response === undefined) return { kind: 'unavailable' };
      if (response.status === 429) return { kind: 'rate_limited', retryAfterSeconds: retryAfter(response) };
      if (response.ok) {
        const parsed = PeekSignInResponseSchema.safeParse(await response.json().catch(() => undefined));
        return parsed.success ? { kind: 'usable', email: parsed.data.email } : { kind: 'unavailable' };
      }
      const code = await problemCode(response);
      if (code === 'SIGN_IN_LINK_INVALID' || code === 'INVALID_REQUEST') return { kind: 'link_invalid' };
      return { kind: 'unavailable' };
    },

    async redeem(request) {
      const response = await send('POST', '/auth/redeem', request);
      if (response === undefined) return { kind: 'unavailable' };
      if (response.status === 429) return { kind: 'rate_limited', retryAfterSeconds: retryAfter(response) };
      if (response.ok) {
        const parsed = RedeemSignInResponseSchema.safeParse(await response.json().catch(() => undefined));
        return parsed.success ? { kind: 'signed_in', response: parsed.data } : { kind: 'unavailable' };
      }
      const code = await problemCode(response);
      if (code === 'SIGN_IN_LINK_INVALID' || code === 'INVALID_REQUEST') return { kind: 'link_invalid' };
      if (code === undefined || response.status >= 500) return { kind: 'unavailable' };
      return { kind: 'refused', code };
    },

    async session() {
      const response = await send('GET', '/auth/session');
      if (response === undefined) return { kind: 'unavailable' };
      if (response.status === 401) return { kind: 'signed_out' };
      if (!response.ok) return { kind: 'unavailable' };
      // Anything that is not the contract's answer (a proxy page, an old build) is "unavailable".
      const parsed = SessionResponseSchema.safeParse(await response.json().catch(() => undefined));
      return parsed.success
        ? {
            kind: 'signed_in',
            account: parsed.data.account,
            client: parsed.data.client,
            expiresAt: parsed.data.expiresAt,
          }
        : { kind: 'unavailable' };
    },

    async signOut({ everywhere }) {
      const response = await send('POST', '/auth/sign-out', { everywhere });
      return response !== undefined && (response.ok || response.status === 401) ? 'signed_out' : 'unavailable';
    },
  };
}
