import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { OWNER_ID, lockUniverse, transaction } from './index.ts';

/** Also reused by `sign-in.ts` (ADR-0026 section 3) so a magic-link session's expiry stays
 * consistent with every other device session's default. */
export const DEFAULT_EXPIRY_HOURS = 24 * 30;
const MIN_EXPIRY_HOURS = 1;
const MAX_EXPIRY_HOURS = 720;

export type AuthScope = {
 sessionId: string;
 deviceId: string;
 universeId: string;
 privacyEpoch: number;
 expiresAt: string;
};

export class UnauthorizedSession extends Error {
 constructor() { super('Unauthorized'); this.name = 'UnauthorizedSession'; }
}

function tokenHash(token: string): string {
 return createHash('sha256').update(token, 'utf8').digest('hex');
}

function uuidFromHash(hash: string, domain: string): string {
 const bytes = createHash('sha256').update(`${domain}:${hash}`).digest().subarray(0, 16);
 bytes[6] = (bytes[6]! & 0x0f) | 0x40;
 bytes[8] = (bytes[8]! & 0x3f) | 0x80;
 const hex = bytes.toString('hex');
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function scopeFromRow(row: Record<string, unknown>): AuthScope {
 const expiresAt = row.expires_at;
 return {
  sessionId: String(row.id),
  deviceId: String(row.device_id),
  universeId: String(row.universe_id),
  privacyEpoch: Number(row.privacy_epoch),
  expiresAt: expiresAt instanceof Date ? expiresAt.toISOString() : new Date(String(expiresAt)).toISOString(),
 };
}

/** @deprecated ADR-0026 section 5: the operator-provisioned development token remains the local
 * bootstrap path (kept working for existing tooling/journeys) but is superseded by real magic-link
 * sign-in (`sign-in.ts`) as the production identity path; a production-mode process refuses to
 * start at all (see `apps/api/src/main.ts`), so this never runs in production either way. */
export async function ensureDevelopmentSession(token: string): Promise<void> {
 if (token.length < 24) throw new Error('KS_DEV_TOKEN must contain at least 24 characters');
 const hash = tokenHash(token);
 const sessionId = uuidFromHash(hash, 'knowscroll-development-session');
 const deviceId = uuidFromHash(hash, 'knowscroll-development-device');
 await transaction(async client => {
  await lockUniverse(client, OWNER_ID);
  const existing = (await client.query('SELECT id, universe_id, device_id FROM device_session WHERE token_hash=$1', [hash])).rows[0];
  if (existing) {
   if (existing.id !== sessionId || existing.universe_id !== OWNER_ID || existing.device_id !== deviceId) {
    throw new Error('Development token is already bound to another session');
   }
   return;
  }
  const universe = (await client.query('SELECT privacy_epoch FROM universe WHERE id=$1', [OWNER_ID])).rows[0];
  await client.query(`INSERT INTO device_session(id,universe_id,device_id,token_hash,privacy_epoch,expires_at)
   VALUES($1,$2,$3,$4,$5,clock_timestamp()+($6 * interval '1 hour'))`,
   [sessionId, OWNER_ID, deviceId, hash, universe.privacy_epoch, DEFAULT_EXPIRY_HOURS]);
 });
}

export async function authenticateAndLock(client: pg.PoolClient, token: string): Promise<AuthScope> {
 const hash = tokenHash(token);
 const candidate = (await client.query('SELECT universe_id FROM device_session WHERE token_hash=$1', [hash])).rows[0];
 if (!candidate) throw new UnauthorizedSession();
 await lockUniverse(client, candidate.universe_id);
 const row = (await client.query(`SELECT s.* FROM device_session s JOIN universe u ON u.id=s.universe_id
  WHERE s.token_hash=$1 AND s.universe_id=$2 AND s.revoked_at IS NULL
    AND s.expires_at>clock_timestamp() AND s.privacy_epoch=u.privacy_epoch
  FOR UPDATE OF s`, [hash, candidate.universe_id])).rows[0];
 if (!row) throw new UnauthorizedSession();
 return scopeFromRow(row);
}

export async function revokeSession(client: pg.PoolClient, scope: AuthScope): Promise<void> {
 const result = await client.query(`UPDATE device_session SET revoked_at=clock_timestamp()
  WHERE id=$1 AND universe_id=$2 AND revoked_at IS NULL`, [scope.sessionId, scope.universeId]);
 if (!result.rowCount) throw new UnauthorizedSession();
}

export async function provisionIdentity(
 options: {universeId?: string; deviceId?: string; expiresInHours?: number} = {},
): Promise<{token: string; scope: AuthScope}> {
 const expiresInHours = options.expiresInHours ?? DEFAULT_EXPIRY_HOURS;
 if (!Number.isInteger(expiresInHours) || expiresInHours < MIN_EXPIRY_HOURS || expiresInHours > MAX_EXPIRY_HOURS) {
  throw new Error('expiresInHours must be an integer from 1 through 720');
 }
 const token = randomBytes(32).toString('base64url');
 const hash = tokenHash(token);
 const universeId = options.universeId ?? randomUUID();
 const deviceId = options.deviceId ?? randomUUID();
 const scope = await transaction(async client => {
  if (options.universeId === undefined) {
   await client.query('INSERT INTO universe(id) VALUES($1)', [universeId]);
   await client.query('INSERT INTO accounts(universe_id) VALUES($1)', [universeId]);
  }
  await lockUniverse(client, universeId);
  const universe = (await client.query('SELECT privacy_epoch FROM universe WHERE id=$1', [universeId])).rows[0];
  const sessionId = randomUUID();
  const row = (await client.query(`INSERT INTO device_session(id,universe_id,device_id,token_hash,privacy_epoch,expires_at)
   VALUES($1,$2,$3,$4,$5,clock_timestamp()+($6 * interval '1 hour')) RETURNING *`,
   [sessionId, universeId, deviceId, hash, universe.privacy_epoch, expiresInHours])).rows[0];
  return scopeFromRow(row);
 });
 return {token, scope};
}
