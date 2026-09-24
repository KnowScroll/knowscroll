/**
 * MiniMax subscription quota preflight (ADR-0011, reused by ADR-0033's worker-only answer transport).
 * Before any provider request the current interval and weekly remaining percentages must both be
 * between 25 and 100 for the one `general` window; anything else refuses the request.
 */
export const MINIMAX_QUOTA_URL = 'https://www.minimax.io/v1/token_plan/remains';

export type QuotaObservation = {intervalRemainingPercent:number;weeklyRemainingPercent:number};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateQuotaResponse(value: unknown): QuotaObservation {
  if (!object(value) || !object(value.base_resp) || value.base_resp.status_code !== 0 || !Array.isArray(value.model_remains)) {
    throw new Error('MiniMax quota response failed validation');
  }
  const general = value.model_remains.filter((entry) => object(entry) && entry.model_name === 'general');
  if (general.length !== 1) throw new Error('MiniMax quota response must contain exactly one general model window');
  const entry = general[0]!;
  const interval = entry.current_interval_remaining_percent;
  const weekly = entry.current_weekly_remaining_percent;
  if (typeof interval !== 'number' || !Number.isFinite(interval) || typeof weekly !== 'number' || !Number.isFinite(weekly) ||
      interval < 25 || interval > 100 || weekly < 25 || weekly > 100) {
    throw new Error('MiniMax general quota is missing, ambiguous, or below the certification floor');
  }
  return {intervalRemainingPercent:interval, weeklyRemainingPercent:weekly};
}

export async function checkMiniMaxQuota(apiKey: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<QuotaObservation> {
  let response: Response;
  try {
    response = await fetchImpl(MINIMAX_QUOTA_URL, {
      method:'GET',
      headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},
      redirect:'manual',
      signal,
    });
  } catch { throw new Error('MiniMax quota preflight transport failed'); }
  if (response.status !== 200) throw new Error('MiniMax quota preflight did not return HTTP 200');
  let value: unknown;
  try { value = await response.json(); } catch { throw new Error('MiniMax quota response was not JSON'); }
  return validateQuotaResponse(value);
}

