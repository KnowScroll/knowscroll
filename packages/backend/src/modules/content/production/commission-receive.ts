import { createHash } from 'node:crypto';
import {
  CommissionReceivePayloadSchema,
  CommissionReceiveBindingSchema,
  ReceiveWorkSchema,
  RECEIVE_MAX_BYTES,
  RECEIVE_LIFETIME_MS,
} from './commission-receive-contracts.js';
import type { CommissionReceivePayload, CommissionReceiveBinding } from './commission-receive-contracts.js';
import type { CommissionReceive, CommissionReceivePorts, ReceiveEnvelope } from './commission-receive-ports.js';
export const receiveSha256 = (utf8: string) => createHash('sha256').update(utf8).digest('hex');
/** Stable per publication/target, independent of collection/publication of the handoff packet. */
export function receiveHandoffId(origin: 'dev' | 'stage', publicationId: string, target: 'dev' | 'stage'): string {
  const hex = receiveSha256(JSON.stringify(['cutroom-receive.v1', origin, publicationId.toLowerCase(), target])).slice(
    0,
    32,
  );
  const variant = ((parseInt(hex[16]!, 16) & 3) | 8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20)}`;
}
/** Strict UTF8 byte intake before parsing, with finite depth/node guards; never error/body logging. */
export function parseReceiveEnvelope(
  input: unknown,
): { envelope: ReceiveEnvelope; payload: CommissionReceivePayload } | undefined {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).sort().join(',') !== 'payloadSha256,payloadUtf8'
  )
    return;
  const v = input as Record<string, unknown>;
  if (
    typeof v.payloadUtf8 !== 'string' ||
    typeof v.payloadSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(v.payloadSha256) ||
    Buffer.byteLength(v.payloadUtf8) > RECEIVE_MAX_BYTES ||
    new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(v.payloadUtf8)) !== v.payloadUtf8 ||
    receiveSha256(v.payloadUtf8) !== v.payloadSha256
  )
    return;
  try {
    const raw: unknown = JSON.parse(v.payloadUtf8);
    const stack = [{ v: raw, d: 0 }];
    let nodes = 0;
    while (stack.length) {
      const n = stack.pop()!;
      if (++nodes > 12000 || n.d > 20) return;
      if (n.v && typeof n.v === 'object') for (const child of Object.values(n.v)) stack.push({ v: child, d: n.d + 1 });
    }
    const parsed = CommissionReceivePayloadSchema.safeParse(raw);
    if (!parsed.success || receiveSha256(JSON.stringify(parsed.data.document)) !== parsed.data.documentSha256) return;
    const p = parsed.data,
      s = p.settlement;
    if (
      p.handoffId !== receiveHandoffId(p.originWorld, p.publicationId, p.targetWorld) ||
      receiveSha256(
        JSON.stringify({
          version: 'cutroom-financial.v1',
          worldId: p.originWorld,
          businessRunId: p.businessRunId,
          attemptId: p.attemptId,
          requestId: p.requestId,
          requestSha256: p.requestSha256,
          dispatchId: s.dispatchId,
          poolReceipt: { bindingId: s.bindingId, claimedAt: s.claimedAt, boundAt: s.boundAt },
          runs: s.runs,
          finalRunId: s.finalRunId,
          outcome: 'completed',
          actualCents: s.actualCents,
        }),
      ) !== s.financialReportSha256
    )
      return;
    return { envelope: { payloadUtf8: v.payloadUtf8, payloadSha256: v.payloadSha256 }, payload: parsed.data };
  } catch {
    return;
  }
}
export function receiveBindingCurrent(
  binding: CommissionReceiveBinding | undefined,
  payload: CommissionReceivePayload,
  digest: string,
  authority: CommissionReceivePorts['authority'],
  now: number,
): binding is CommissionReceiveBinding {
  if (!binding || !Number.isSafeInteger(now) || !CommissionReceiveBindingSchema.safeParse(binding).success)
    return false;
  const original = Date.parse(payload.settlement.claimedAt);
  return (
    payload.targetWorld === authority.worldId &&
    binding.targetWorld === authority.worldId &&
    binding.generation === authority.generation &&
    binding.handoffId === payload.handoffId &&
    binding.payloadSha256 === digest &&
    binding.observedAtMs <= now &&
    now < binding.expiresAtMs &&
    original <= now &&
    now < original + RECEIVE_LIFETIME_MS
  );
}
/** Receivers have no pool, Reasoning attempt, provider, Cutroom GET or foreign-store port. */
export function makeCommissionReceive(p: CommissionReceivePorts): CommissionReceive {
  const enabled = p.enabled === true,
    authority = Object.freeze({ ...p.authority });
  async function current(payload: CommissionReceivePayload, digest: string) {
    const b = await p.readBinding(payload.handoffId, digest);
    return receiveBindingCurrent(b, payload, digest, authority, p.now()) ? b : undefined;
  }
  return {
    async stage(input) {
      if (!enabled) return { kind: 'disabled' };
      const parsed = parseReceiveEnvelope(input);
      if (
        !parsed ||
        parsed.payload.targetWorld !== authority.worldId ||
        (parsed.payload.document.fixture && p.fixture !== true)
      )
        return { kind: 'held' };
      // Historical admitted replay is a receipt read; no registry renewal or later-state effects.
      const prior = await p.withScope(authority, 'recover', (s) => p.store.load(s, parsed.payload.handoffId, false));
      if (
        prior.kind === 'entered' &&
        prior.value?.payloadSha256 === parsed.envelope.payloadSha256 &&
        prior.value.payloadUtf8 === parsed.envelope.payloadUtf8 &&
        prior.value.receipt
      )
        return { kind: 'admitted', receipt: prior.value.receipt };
      const binding = await current(parsed.payload, parsed.envelope.payloadSha256);
      if (!binding) return { kind: 'held' };
      const result = await p.withScope(authority, 'admit', async (scope) => {
        if (!receiveBindingCurrent(binding, parsed.payload, parsed.envelope.payloadSha256, authority, p.now())) return;
        return p.store.stage(scope, parsed.envelope, parsed.payload, binding);
      });
      if (result.kind !== 'entered' || !result.value) return { kind: 'held' };
      return result.value.receipt ? { kind: 'admitted', receipt: result.value.receipt } : { kind: 'pending' };
    },
    async receive(input) {
      if (!enabled) return { kind: 'disabled' };
      const work = ReceiveWorkSchema.safeParse(input);
      if (!work.success || work.data.worldId !== authority.worldId) return { kind: 'held' };
      const loaded = await p.withScope(authority, 'recover', (s) => p.store.load(s, work.data.handoffId, true));
      if (loaded.kind !== 'entered' || !loaded.value) return { kind: 'held' };
      const record = loaded.value;
      if (record.payload.document.fixture && p.fixture !== true) return { kind: 'held' };
      if (record.receipt) return { kind: 'admitted', receipt: record.receipt };
      if (!record.leaseId || record.state !== 'pending') return { kind: 'held' };
      try {
        const binding = await current(record.payload, record.payloadSha256);
        if (!binding) return { kind: 'held' };
        const proof = await p.media.prepare(record.payload, binding);
        if (!proof) return { kind: 'held' };
        const latest = await current(record.payload, record.payloadSha256);
        if (!latest) return { kind: 'held' };
        const result = await p.withScope(authority, 'admit', async (scope) => {
          if (!receiveBindingCurrent(latest, record.payload, record.payloadSha256, authority, p.now())) return;
          const media = p.media.consume(proof, record.payload, latest);
          if (!media) return;
          return p.store.admit(scope, record, latest, media);
        });
        return result.kind === 'entered' && result.value
          ? { kind: 'admitted', receipt: result.value }
          : { kind: 'held' };
      } finally {
        await p.withScope(authority, 'recover', (s) => p.store.end(s, record.payload.handoffId, record.leaseId!));
      }
    },
    recover: (input) => (enabled ? p.store.recover(input) : Promise.resolve({ scanned: 0, woken: 0 })),
  };
}
