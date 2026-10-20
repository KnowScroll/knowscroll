import { canonicalJson } from '@knowscroll/backend/infrastructure/receipts';
import type { ReportedUsage } from '@knowscroll/backend/reasoning';
import {
  ModelNotSentError,
  ModelOutcomeUnknownError,
  ModelRejectedError,
  type ModelPort,
  type ModelReply,
  type ModelRequest,
  type QuotaObservation,
  type StopReason,
} from '@knowscroll/backend/reasoning/nest-providers';

/**
 * CI FIXTURE: a labelled stand-in for a hosted model. It never touches the network and never
 * returns provider output: every answer is scripted by the test that created it. It is selected
 * only by tests and role evaluations. It lives in test support, not in the backend package: no
 * deployed build contains it and no composition root can select it.
 *
 * Scenarios mirror the MiniMax adapter's outcome classes, so the harness and ledger are exercised
 * exactly as the real transport would drive them:
 * - `success`: a conclusive answer with the given text (and usage);
 * - `malformed`: a conclusive answer that is not one JSON object;
 * - `truncated`: a conclusive answer cut off at the output ceiling;
 * - `timeout_after_dispatch`: the request left and no answer came (`unknown`);
 * - `rate_limited`: HTTP 429 (conclusive rejection, optionally reporting usage);
 * - `not_connected`: the connection was refused (nothing was sent; conclusive failure);
 * - `server_error`: HTTP 500/503 (conclusive failure, optionally reporting usage);
 * - `gateway_timeout`: HTTP 504 (`unknown`: the provider may have processed it);
 * - `hold`: waits for the test, then plays the scenario it is given.
 */
export type FixtureScenario =
  | {
      readonly kind: 'success';
      readonly text: string;
      readonly usage?: Partial<ReportedUsage>;
      readonly remoteId?: string;
      readonly stop?: StopReason;
    }
  | { readonly kind: 'malformed'; readonly text?: string }
  | { readonly kind: 'truncated'; readonly text?: string }
  | { readonly kind: 'timeout_after_dispatch' }
  | { readonly kind: 'rate_limited'; readonly usage?: Partial<ReportedUsage> }
  | { readonly kind: 'not_connected' }
  | { readonly kind: 'server_error'; readonly status?: 500 | 503; readonly usage?: Partial<ReportedUsage> }
  | { readonly kind: 'gateway_timeout' }
  | { readonly kind: 'hold'; readonly until: Promise<FixtureScenario> };

/** One request that reached the fixture (after the transaction guard), decoded for assertions. */
export interface FixtureCall {
  readonly sequence: number;
  readonly request: ModelRequest & { readonly fixture: string };
  readonly bytes: Uint8Array;
}

export interface FixtureModelPort extends ModelPort {
  /** Every `send` that reached the fixture, in order. */
  readonly calls: readonly FixtureCall[];
  /** How many quota observations were made. */
  readonly quotaChecks: () => number;
}

export interface FixtureModelOptions {
  /** A label recorded in every encoded request (`fixture` field), e.g. the test's name. */
  readonly label: string;
  /** The scenario for each call (1-based sequence), in order. */
  readonly script: (call: FixtureCall) => FixtureScenario | Promise<FixtureScenario>;
  /** The quota observation before each attempt (default `not_applicable`). */
  readonly quota?: () => QuotaObservation;
  /** Model name recorded on attempts (default `fixture-model-v1`). */
  readonly model?: string;
}

/** Usage a failure reports: nothing unless the scenario says so (`undefined` = none reported). */
function failureUsage(usage: Partial<ReportedUsage> | undefined): ReportedUsage | undefined {
  return usage === undefined
    ? undefined
    : { inputTokens: null, outputTokens: null, reasoningTokens: null, cachedTokens: null, ...usage };
}

const defaultUsage: ReportedUsage = { inputTokens: 40, outputTokens: 12, reasoningTokens: null, cachedTokens: 0 };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Creates a labelled fixture model port. Wrap it with `guardedModelPort` like any transport. */
export function fixtureModelPort(options: FixtureModelOptions): FixtureModelPort {
  const calls: FixtureCall[] = [];
  let quotaChecks = 0;

  async function play(scenario: FixtureScenario): Promise<ModelReply> {
    switch (scenario.kind) {
      case 'success':
        return {
          ...(scenario.remoteId === undefined ? {} : { remoteId: scenario.remoteId }),
          usage: { ...defaultUsage, ...scenario.usage },
          answer: { kind: 'text', text: scenario.text, stop: scenario.stop ?? 'end' },
        };
      case 'malformed':
        return {
          usage: defaultUsage,
          answer: { kind: 'text', text: scenario.text ?? 'Sure! Here is what you asked for: {not json', stop: 'end' },
        };
      case 'truncated':
        return {
          usage: defaultUsage,
          answer: { kind: 'text', text: scenario.text ?? '{"partial": tr', stop: 'max_tokens' },
        };
      case 'timeout_after_dispatch':
        throw new ModelOutcomeUnknownError('TIMEOUT_AFTER_DISPATCH');
      case 'rate_limited':
        throw new ModelRejectedError('HTTP_429_RATE_LIMIT_ERROR', failureUsage(scenario.usage));
      case 'not_connected':
        throw new ModelNotSentError('NOT_CONNECTED_ECONNREFUSED');
      case 'server_error':
        throw new ModelRejectedError(`HTTP_${scenario.status ?? 500}`, failureUsage(scenario.usage));
      case 'gateway_timeout':
        throw new ModelOutcomeUnknownError('HTTP_504');
      case 'hold':
        return play(await scenario.until);
    }
  }

  return {
    provider: 'fixture',
    model: options.model ?? 'fixture-model-v1',
    calls,
    quotaChecks: () => quotaChecks,
    encode(request) {
      return encoder.encode(
        canonicalJson({
          fixture: options.label,
          max_tokens: request.maxOutputTokens,
          system: request.system,
          user: request.user,
        }),
      );
    },
    observeQuota() {
      quotaChecks += 1;
      return Promise.resolve(
        options.quota?.() ?? {
          verdict: 'not_applicable',
          intervalRemainingPercent: null,
          weeklyRemainingPercent: null,
        },
      );
    },
    async send(bytes) {
      const decoded = JSON.parse(decoder.decode(bytes)) as {
        fixture: string;
        max_tokens: number;
        system: string;
        user: string;
      };
      const call: FixtureCall = {
        sequence: calls.length + 1,
        request: {
          fixture: decoded.fixture,
          system: decoded.system,
          user: decoded.user,
          maxOutputTokens: decoded.max_tokens,
        },
        bytes,
      };
      calls.push(call);
      return play(await options.script(call));
    },
  };
}
