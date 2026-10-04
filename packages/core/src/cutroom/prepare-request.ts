/**
 * The pure half of the Cutroom client (ADR-0020): validates a submit request against the vendored
 * contract and freezes its exact bytes. `isPreparedCutroomRequest` is the client's guard that a
 * request really came through here; the registry is module-private so a hand-built object never
 * passes it.
 */
import { createHash } from 'node:crypto';
import { SubmitRequest } from '@knowscroll/contracts/cutroom-v1/request';

type Stage = 'plan' | 'stills' | 'video';
export type PreparedCutroomRequest = Readonly<{
  requestId: string;
  until: Stage;
  body: string;
  bodySha256: string;
}>;
const preparedRequests = new WeakSet<object>();
const MAX_REQUEST_BYTES = 256 * 1024;

export function isPreparedCutroomRequest(value: object): boolean {
  return preparedRequests.has(value);
}

export function prepareCutroomRequest(input: unknown): PreparedCutroomRequest {
  const parsed = SubmitRequest.safeParse(input);
  if (
    !parsed.success ||
    !([undefined, 'shotCount'] as unknown[]).includes(
      parsed.data.options.planVaryOn,
    )
  )
    throw new Error('Invalid Cutroom request');
  identity(parsed.data.requestId);
  const body = JSON.stringify(parsed.data);
  if (Buffer.byteLength(body) > MAX_REQUEST_BYTES)
    throw new Error('Cutroom request exceeds byte limit');
  const prepared = Object.freeze({
    requestId: parsed.data.requestId,
    until: parsed.data.options.until,
    body,
    bodySha256: createHash('sha256').update(body).digest('hex'),
  });
  preparedRequests.add(prepared);
  return prepared;
}

export function validIdentity(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value) > 1024
  )
    return false;
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}
export function identity(value: unknown): asserts value is string {
  if (!validIdentity(value)) throw new Error('Invalid Cutroom identity');
}
