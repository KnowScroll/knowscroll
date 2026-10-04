import { createHash } from 'node:crypto';
import { compareCodeUnits } from '@knowscroll/core/shared/compare';
import type { ContextRefusal } from '@knowscroll/contracts/reasoning-context';
import {
  ReasoningDenied,
  validateReasoningPolicy,
  type ReasoningScope,
} from './runtime-policy.ts';

export function deny(reason: ContextRefusal): never {
  throw new ReasoningDenied(`context_${reason}`);
}

export function canonical(value: unknown): string {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('Canonical context values must be JSON data');
}

export function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function canonicalHash(value: unknown): string {
  return digest(canonical(value));
}

export function asIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new Error('Invalid stored timestamp');
  return date.toISOString();
}

export function policyDigest(
  policy: unknown,
  scope: ReasoningScope,
): { version: string; hash: string } {
  const resolved = validateReasoningPolicy(policy, scope).policy;
  const canonicalPolicy = {
    scope: {
      jobId: scope.jobId,
      privacyEpoch: scope.privacyEpoch,
      universeId: scope.universeId,
    },
    policy: {
      ...resolved,
      requiredDimensions: [...resolved.requiredDimensions].sort(),
      buckets: [...resolved.buckets].sort((left, right) =>
        compareCodeUnits(left.bucketId, right.bucketId),
      ),
    },
  };
  return {
    version: resolved.policyVersion,
    hash: canonicalHash(canonicalPolicy),
  };
}

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
