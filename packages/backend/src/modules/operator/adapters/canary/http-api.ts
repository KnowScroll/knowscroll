/* eslint-disable no-restricted-globals -- The canary drives KnowScroll's own public HTTP API from the operator shell, the way a client does: fixed routes on the world's own origin, no model or provider API. */
import {
  AccountDeletionAcceptanceSchema,
  AccountDeletionStatusSchema,
  ActivateOfferResponseSchema,
  DELETE_ACCOUNT_CONFIRMATION,
  EmergingUniverseSchema,
  ExposureDocumentResponseSchema,
  GeographySnapshotSchema,
  NavigationOutcomeSchema,
  ProblemDetailsSchema,
  RecordingObservationBatchResponseSchema,
  RecordingPolicyReadSchema,
  RedeemSignInResponseSchema,
  ReelDocumentSchema,
  RegionEncounterOpenResponseSchema,
  RegionEncounterPreviewResponseSchema,
  type NavigationOutcome,
} from '@knowscroll/contracts';
import { z } from 'zod';
import {
  CanaryApiError,
  type CanaryApi,
  type CanaryAccount,
  type FormationRead,
} from '../../application/canary/ports.js';
import { CANARY_CAPABILITIES, readingUnitsOf } from './document-units.js';

const REQUEST_TIMEOUT_MS = 30_000;
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 1_000;
const REEL_PROBE_BYTES = 65_536;

const MediaGrantSchema = z.object({ document: ReelDocumentSchema, path: z.string(), expiresAt: z.string() });

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface HttpOptions {
  /** Where the API answers: the world's public origin, or a loopback address on the server itself. */
  readonly baseUrl: string;
  /** The world's own origin (`KS_PUBLIC_ORIGIN`): cookie-authenticated writes must carry it as `Origin`. */
  readonly origin: string;
  readonly newId: () => string;
}

interface Credentials {
  readonly cookie: string;
  readonly account: CanaryAccount;
}

/** The token a sign-in link carries in its fragment, or `undefined` for a link that has none. */
function tokenOf(link: string): string | undefined {
  try {
    const token = new URL(link).hash.replace(/^#token=/, '');
    return token === '' ? undefined : token;
  } catch {
    return undefined;
  }
}

async function problemCode(response: Response): Promise<string> {
  try {
    const parsed = ProblemDetailsSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.code : 'unrecognised_problem';
  } catch {
    return 'unreadable_problem';
  }
}

/** One request with a bounded retry for what is retryable (a network failure or a 503): every command carries its own idempotency key. */
async function send(options: HttpOptions, route: string, path: string, init: RequestInit): Promise<Response> {
  for (let attempt = 1; ; attempt += 1) {
    let response: Response | undefined;
    try {
      response = await fetch(options.baseUrl + path, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      if (attempt >= ATTEMPTS) throw new CanaryApiError(route, 0, 'network');
      await delay(RETRY_DELAY_MS * attempt);
      continue;
    }
    if (response.status !== 503 || attempt >= ATTEMPTS) return response;
    await response.body?.cancel();
    await delay(RETRY_DELAY_MS * attempt);
  }
}

async function parsed<T>(route: string, response: Response, schema: z.ZodType<T>): Promise<T> {
  if (!response.ok) throw new CanaryApiError(route, response.status, await problemCode(response));
  const result = schema.safeParse(await response.json().catch(() => undefined));
  if (!result.success) throw new CanaryApiError(route, response.status, 'wire_shape');
  return result.data;
}

/**
 * Redeems an operator sign-in link through the real `POST /auth/redeem` and returns the signed-in session as a
 * client would hold it: the web session cookie, the account and the scope claim every account request carries.
 * Failure: `CanaryApiError` with the status and code; a link without a token is `link_invalid`.
 */
export async function signInOverHttp(options: HttpOptions, link: string): Promise<CanaryApi> {
  const token = tokenOf(link);
  if (token === undefined) throw new CanaryApiError('identity.redeem', 0, 'link_invalid');
  const response = await send(options, 'identity.redeem', '/auth/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: options.origin },
    body: JSON.stringify({ token, commandId: options.newId(), client: 'web' }),
  });
  const redeemed = await parsed('identity.redeem', response, RedeemSignInResponseSchema);
  const cookie = response.headers.getSetCookie()[0]?.split(';')[0];
  if (cookie === undefined || redeemed.session.kind !== 'cookie')
    throw new CanaryApiError('identity.redeem', response.status, 'no_session_cookie');
  return new HttpCanaryApi(options, {
    cookie,
    account: {
      accountId: redeemed.account.accountId,
      universeId: redeemed.account.universeId,
      privacyEpoch: redeemed.account.privacyEpoch,
    },
  });
}

class HttpCanaryApi implements CanaryApi {
  readonly account: CanaryAccount;

  constructor(
    private readonly options: HttpOptions,
    private readonly credentials: Credentials,
  ) {
    this.account = credentials.account;
  }

  private headers(withBody: boolean, anonymous: boolean): Record<string, string> {
    return {
      ...(withBody ? { 'content-type': 'application/json' } : {}),
      ...(anonymous
        ? {}
        : {
            cookie: this.credentials.cookie,
            origin: this.options.origin,
            'x-ks-scope': `${this.account.accountId}:${String(this.account.privacyEpoch)}`,
          }),
    };
  }

  private async call<T>(
    route: string,
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
    anonymous = false,
  ): Promise<T> {
    const response = await send(this.options, route, path, {
      method,
      headers: this.headers(body !== undefined, anonymous),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return parsed(route, response, schema);
  }

  async recordingPolicy() {
    const read = await this.call(
      'recording.read',
      'POST',
      '/v1/privacy/recording/read',
      { version: 'recording-policy.v1', readId: this.options.newId(), target: { kind: 'current' } },
      RecordingPolicyReadSchema,
    );
    return { on: read.policy.on, generation: read.policy.generation };
  }

  discover(input: { commandId: string; recordingGeneration: number }): Promise<NavigationOutcome> {
    return this.call(
      'experience.discover',
      'POST',
      '/v1/experience/open',
      {
        commandId: input.commandId,
        target: { kind: 'discover' },
        capabilities: CANARY_CAPABILITIES,
        recordingGeneration: input.recordingGeneration,
      },
      NavigationOutcomeSchema,
    );
  }

  navigate(input: Parameters<CanaryApi['navigate']>[0]): Promise<NavigationOutcome> {
    return this.call('experience.navigate', 'POST', '/v1/experience/navigate', input, NavigationOutcomeSchema);
  }

  async activate(input: Parameters<CanaryApi['activate']>[0]) {
    const activated = await this.call(
      'experience.activate',
      'POST',
      '/v1/experience/activate',
      {
        commandId: input.commandId,
        target: {
          kind: 'offer',
          sessionId: input.sessionId,
          offerId: input.offerId,
          expectedIntentRevision: input.expectedIntentRevision,
        },
        recordingGeneration: input.recordingGeneration,
      },
      ActivateOfferResponseSchema,
    );
    return { exposureId: activated.exposureId, intentRevision: activated.intentRevision };
  }

  async readingUnits(exposureId: string) {
    const loaded = await this.call(
      'experience.document',
      'GET',
      `/v1/experience/exposures/${exposureId}/document`,
      undefined,
      ExposureDocumentResponseSchema,
    );
    return readingUnitsOf(loaded.document);
  }

  async reelGrant(exposureId: string) {
    const grant = await this.call('media.grant', 'POST', '/v1/media/grants', { exposureId }, MediaGrantSchema);
    return { durationMs: grant.document.durationMs, path: grant.path };
  }

  /** The grant's path is a short-lived credential: it is used once and never kept or reported. */
  async reelBytesServed(path: string): Promise<boolean> {
    try {
      const response = await send(this.options, 'media.bytes', path, {
        method: 'GET',
        headers: { ...this.headers(false, false), range: `bytes=0-${String(REEL_PROBE_BYTES - 1)}` },
      });
      await response.body?.cancel();
      return response.status === 200 || response.status === 206;
    } catch {
      return false;
    }
  }

  submitBatch(batch: Parameters<CanaryApi['submitBatch']>[0]) {
    return this.call(
      'observations.recording_batch',
      'POST',
      '/v1/observations/recording-batch',
      batch,
      RecordingObservationBatchResponseSchema,
    );
  }

  async formation(): Promise<FormationRead> {
    const geography = await this.call(
      'geography.read',
      'POST',
      '/v1/universe/geography/read',
      { selection: { kind: 'universe' }, limit: 100 },
      GeographySnapshotSchema,
    );
    const emerging = await this.call(
      'geography.emerging',
      'POST',
      '/v1/universe/emerging/read',
      {},
      EmergingUniverseSchema,
    );
    const objects = 'page' in geography ? geography.page.objects : [];
    const count = (kind: string) => objects.filter((object) => object.kind === kind).length;
    return {
      reading: {
        dust: emerging.dust.length,
        systems: count('system'),
        planets: count('planet'),
        regions: count('region'),
      },
      regions: objects
        .filter((object) => object.kind === 'region')
        .map((object) => ({
          regionId: object.id,
          expectedObjectRevision: object.objectRevision,
          expectedGeographyRevision: geography.geography.revision,
        })),
    };
  }

  async openRegion(input: Parameters<CanaryApi['openRegion']>[0]) {
    const target = { kind: 'region' as const, ...input.target };
    const preview = await this.call(
      'region.preview',
      'POST',
      '/v1/experience/region/preview',
      {
        version: 'region-encounter-preview.v1',
        readId: this.options.newId(),
        target,
        capabilities: CANARY_CAPABILITIES,
        alternate: true,
      },
      RegionEncounterPreviewResponseSchema,
    );
    if (preview.status === 'unavailable') return { status: 'unavailable' as const };
    const opened = await this.call(
      'region.open',
      'POST',
      '/v1/experience/region/open',
      {
        version: 'region-encounter-open.v1',
        commandId: input.commandId,
        target,
        capabilities: CANARY_CAPABILITIES,
        expectedEncounter: { assetId: preview.encounter.assetId, assetRevision: preview.encounter.assetRevision },
        recordingGeneration: input.recordingGeneration,
      },
      RegionEncounterOpenResponseSchema,
    );
    return opened.outcome;
  }

  async deleteAccount(receiptId: string): Promise<void> {
    await this.call(
      'account.delete',
      'POST',
      '/v1/account/delete',
      { receiptId, expectedPrivacyEpoch: this.account.privacyEpoch, confirmation: DELETE_ACCOUNT_CONFIRMATION },
      AccountDeletionAcceptanceSchema,
    );
  }

  async deletionState(receiptId: string) {
    const status = await this.call(
      'account.deletion_status',
      'GET',
      `/auth/deletion/${receiptId}`,
      undefined,
      AccountDeletionStatusSchema,
      true,
    );
    return status.state;
  }

  async retryDeletion(receiptId: string): Promise<void> {
    await this.call(
      'account.deletion_retry',
      'POST',
      '/auth/deletion/retry',
      { receiptId },
      AccountDeletionStatusSchema,
      true,
    );
  }
}
