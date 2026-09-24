import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type {
 HistoryClearInput, HistoryClearReceipt, PrivacyLifecycleInput, PrivacyRecordingReceipt,
 PrivacyResetInput, PrivacyResetReceipt, PrivacyExportResult, PrivacyExportDeviceSession,
 AccountDeletionInput, AccountDeletionReceipt,
} from '../../contracts/src/index.ts';
import type { AuthScope } from './identity.ts';
import {eraseReasoningForHistoryClear} from './reasoning-storage.ts';
import {eraseSemanticHistory, exportSemanticHistory} from './semantic/branches.ts';
import {erasePersonalModel, exportPersonalModel} from './semantic/personal-model.ts';
import {eraseAskAnswers, exportAskAnswers} from './reasoning-answers.ts';
import {eraseInquiries, exportInquiries, withdrawInquiries} from './reasoning-inquiries.ts';

export class HistoryClearConflict extends Error {
 readonly statusCode = 409;
 constructor(message = 'History clear conflicts with the current privacy epoch') {
  super(message);
  this.name = 'HistoryClearConflict';
 }
}

function receiptFromRow(row: Record<string, unknown>): HistoryClearReceipt {
 const clearedAt=row.cleared_at;
 return {
  receiptId:String(row.id),
  privacyEpoch:Number(row.epoch_after),
  clearedAt:clearedAt instanceof Date ? clearedAt.toISOString() : new Date(String(clearedAt)).toISOString(),
 };
}

/** Called only after exposure erasure, under the caller's existing authenticated universe lock.
 * Shared world/asset evidence and other universes are deliberately outside this deletion. */
async function eraseEncounterSystem(client:pg.PoolClient,universeId:string):Promise<void> {
 await client.query('DELETE FROM world_system_member WHERE system_id IN (SELECT id FROM world_system WHERE universe_id=$1)',[universeId]);
 await client.query('DELETE FROM world_system WHERE universe_id=$1',[universeId]);
}

/** The personal history both Clear (ADR-0010) and Reset (ADR-0030) erase, in FK-safe order, under
 * the caller's universe lock and after its epoch has advanced. Semantic rows (#131) go before the
 * exposures/decisions/ledger events they reference. Shared knowledge and other universes survive. */
async function erasePersonalHistory(client:pg.PoolClient,universeId:string,epochBefore:number,epochAfter:number):Promise<void> {
 // #132: answers and their requests go first; they reference the Ask facts erased below.
 await eraseAskAnswers(client,universeId);
 // #132 (ADR-0038): inquiry mail, inquiries and consent go before the atlas deltas and proposals they name.
 await eraseInquiries(client,universeId);
 await eraseReasoningForHistoryClear(client,{universeId,epochBefore,epochAfter});
 await client.query('DELETE FROM job WHERE universe_id=$1',[universeId]);
 await client.query('DELETE FROM trace WHERE universe_id=$1',[universeId]);
 await erasePersonalModel(client,universeId);
 await eraseSemanticHistory(client,universeId);
 await client.query('DELETE FROM exposure WHERE universe_id=$1',[universeId]);
 await eraseEncounterSystem(client,universeId);
 await client.query('DELETE FROM ledger WHERE universe_id=$1',[universeId]);
 await client.query('DELETE FROM decision WHERE universe_id=$1',[universeId]);
 const accounts=await client.query(`UPDATE accounts SET kept_asset_ids='{}'::uuid[],revision=revision+1
  WHERE universe_id=$1`,[universeId]);
 if(accounts.rowCount!==1) throw new Error('Universe accounts state is missing');
}

export async function clearScrollHistory(
 client:pg.PoolClient,
 scope:AuthScope,
 input:HistoryClearInput,
):Promise<HistoryClearReceipt> {
 const old=(await client.query(
  'SELECT id,epoch_before,epoch_after,cleared_at FROM history_clear_receipt WHERE universe_id=$1 AND request_id=$2',
  [scope.universeId,input.requestId],
 )).rows[0];
 if(old) {
  if(old.epoch_before!==input.expectedPrivacyEpoch) throw new HistoryClearConflict('History clear key was reused with a different expected privacy epoch');
  return receiptFromRow(old);
 }
 if(input.expectedPrivacyEpoch!==scope.privacyEpoch) throw new HistoryClearConflict();

 const nextEpoch=scope.privacyEpoch+1;
 const universe=await client.query(`UPDATE universe SET privacy_epoch=$3,revision=revision+1
  WHERE id=$1 AND privacy_epoch=$2 RETURNING privacy_epoch`,[scope.universeId,scope.privacyEpoch,nextEpoch]);
 if(!universe.rowCount) throw new HistoryClearConflict();
 const session=await client.query(`UPDATE device_session SET privacy_epoch=$3
  WHERE id=$1 AND universe_id=$2 AND privacy_epoch=$4 AND revoked_at IS NULL`,
  [scope.sessionId,scope.universeId,nextEpoch,scope.privacyEpoch]);
 if(session.rowCount!==1) throw new Error('Authenticated session could not advance with history clear');

 await erasePersonalHistory(client,scope.universeId,scope.privacyEpoch,nextEpoch);

 const receipt=(await client.query(`INSERT INTO history_clear_receipt
  (id,universe_id,request_id,epoch_before,epoch_after,cleared_at)
  VALUES($1,$2,$3,$4,$5,clock_timestamp()) RETURNING id,epoch_after,cleared_at`,
  [randomUUID(),scope.universeId,input.requestId,scope.privacyEpoch,nextEpoch])).rows[0];
 return receiptFromRow(receipt);
}

// ADR-0028 — privacy lifecycle: pause, export and reset. All three require the caller to already
// hold the universe lock (via `authenticateAndLock`, which every route below goes through) and
// recheck the authenticated session's epoch after that wait resolves, exactly as Clear does.

function isoDate(value:unknown):string {
 return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

export class PrivacyLifecycleConflict extends Error {
 readonly statusCode = 409;
 constructor(message = 'Privacy operation conflicts with the current privacy epoch') {
  super(message);
  this.name = 'PrivacyLifecycleConflict';
 }
}

function recordingReceiptFromRow(row: Record<string, unknown>): PrivacyRecordingReceipt {
 const action = row.action === 'pause' ? 'pause' as const : 'resume' as const;
 const appliedAt = isoDate(row.applied_at);
 return {
  receiptId: String(row.id),
  action,
  privacyEpoch: Number(row.privacy_epoch),
  recordingPausedAt: action === 'pause' ? appliedAt : null,
  appliedAt,
 };
}

/** Shared by `pauseRecording`/`resumeRecording` (ADR-0028 section "Pause / resume"): identical
 * replay contract to Clear, keyed on (universe, requestId) alone — the receipt table has no
 * per-action uniqueness, so a request id is spent the first time it is used regardless of which
 * of the two routes sent it. Unlike Clear, this never advances the privacy epoch: nothing is
 * erased or invalidated, so no other device needs to purge a cache or sign out. */
async function setRecordingPaused(
 client: pg.PoolClient,
 scope: AuthScope,
 action: 'pause' | 'resume',
 input: PrivacyLifecycleInput,
): Promise<PrivacyRecordingReceipt> {
 // The action is part of the replay key. Matching on the request id alone meant a client that
 // reused an id it had already spent on the opposite action got that earlier receipt back: a
 // pause request answered 200 with a resume receipt, and recording never stopped. A privacy
 // control must never report success for something it did not do.
 const old = (await client.query(
  'SELECT id,action,privacy_epoch,applied_at FROM privacy_recording_receipt WHERE universe_id=$1 AND request_id=$2 AND action=$3',
  [scope.universeId, input.requestId, action],
 )).rows[0];
 if (old) {
  if (old.privacy_epoch !== input.expectedPrivacyEpoch) throw new PrivacyLifecycleConflict('Pause/resume key was reused with a different expected privacy epoch');
  return recordingReceiptFromRow(old);
 }
 if (input.expectedPrivacyEpoch !== scope.privacyEpoch) throw new PrivacyLifecycleConflict();

 // The universe fact is set first, in this same transaction, so the receipt-guard trigger can
 // require it to already hold — "the receipt says paused" and "the universe is paused" can never
 // drift apart because the schema itself refuses the alternative.
 const universe = action === 'pause'
  ? await client.query('UPDATE universe SET recording_paused_at=clock_timestamp() WHERE id=$1', [scope.universeId])
  : await client.query('UPDATE universe SET recording_paused_at=NULL WHERE id=$1', [scope.universeId]);
 if (!universe.rowCount) throw new Error('Universe row is missing');

 const receipt = (await client.query(
  `INSERT INTO privacy_recording_receipt(id,universe_id,request_id,action,privacy_epoch,applied_at)
   VALUES($1,$2,$3,$4,$5,clock_timestamp()) RETURNING id,action,privacy_epoch,applied_at`,
  [randomUUID(), scope.universeId, input.requestId, action, scope.privacyEpoch],
 )).rows[0];
 // ADR-0038 §8: pausing stops every background inquiry not yet sent; a call in flight is discarded at apply.
 if (action === 'pause') await withdrawInquiries(client, scope.universeId, scope.privacyEpoch, 'recording_paused');
 return recordingReceiptFromRow(receipt);
}

export async function pauseRecording(client: pg.PoolClient, scope: AuthScope, input: PrivacyLifecycleInput): Promise<PrivacyRecordingReceipt> {
 return setRecordingPaused(client, scope, 'pause', input);
}

export async function resumeRecording(client: pg.PoolClient, scope: AuthScope, input: PrivacyLifecycleInput): Promise<PrivacyRecordingReceipt> {
 return setRecordingPaused(client, scope, 'resume', input);
}

/** ADR-0028 section "Export": read-only and always computed live, so — unlike Clear/pause/resume —
 * a reused `requestId` does not short-circuit to a stored answer; it re-reads current rows and
 * only skips re-inserting the manifest receipt row if one is already there for that key. The
 * epoch precondition is still enforced on every call, so a Reset that happened since the caller
 * last read the Universe receipt fails the export with 409 rather than silently returning a
 * smaller universe than the one the caller thinks they are reading. */
export async function exportUniverse(client: pg.PoolClient, scope: AuthScope, input: PrivacyLifecycleInput): Promise<PrivacyExportResult> {
 if (input.expectedPrivacyEpoch !== scope.privacyEpoch) throw new PrivacyLifecycleConflict();

 const universeRow = (await client.query(
  'SELECT u.id,u.revision,u.privacy_epoch,u.recording_paused_at,a.email FROM universe u LEFT JOIN account a ON a.id=u.account_id WHERE u.id=$1',
  [scope.universeId],
 )).rows[0];
 if (!universeRow) throw new Error('Universe row is missing');
 const accountsRow = (await client.query(
  'SELECT kept_asset_ids,revision FROM accounts WHERE universe_id=$1', [scope.universeId],
 )).rows[0];
 if (!accountsRow) throw new Error('Universe accounts state is missing');

 const decisions = (await client.query('SELECT * FROM decision WHERE universe_id=$1 ORDER BY created_at', [scope.universeId])).rows;
 const ledger = (await client.query('SELECT * FROM ledger WHERE universe_id=$1 ORDER BY seq', [scope.universeId])).rows;
 const exposures = (await client.query('SELECT * FROM exposure WHERE universe_id=$1', [scope.universeId])).rows;
 const traces = (await client.query('SELECT * FROM trace WHERE universe_id=$1 ORDER BY created_at', [scope.universeId])).rows;
 const jobs = (await client.query('SELECT * FROM job WHERE universe_id=$1', [scope.universeId])).rows;
 const deviceSessionRows = (await client.query(
  `SELECT device_id,origin,created_at,expires_at,revoked_at FROM device_session
   WHERE universe_id=$1 ORDER BY created_at`, [scope.universeId],
 )).rows;
 const deviceSessions: PrivacyExportDeviceSession[] = deviceSessionRows.map(row => ({
  deviceId: String(row.device_id), origin: String(row.origin),
  createdAt: isoDate(row.created_at), expiresAt: isoDate(row.expires_at),
  revokedAt: row.revoked_at ? isoDate(row.revoked_at) : null,
 }));

 // ADR-0028: "status, class, timestamps, and recorded token/cost usage — the evidence that
 // reasoning ran and what it cost, not its internal working state." Scheduling/lease/routing
 // columns (lease_owner, wake_kind, dispatch_id, request_id, fingerprint, context_id, …) are
 // deliberately left out of every one of these four selects.
 const reasoningJobs = (await client.query(
  'SELECT id,status,class,created_at FROM reasoning_job WHERE universe_id=$1 ORDER BY created_at', [scope.universeId],
 )).rows;
 const reasoningSteps = (await client.query(
  'SELECT id,job_id,ordinal,status FROM reasoning_step WHERE universe_id=$1 ORDER BY job_id,ordinal', [scope.universeId],
 )).rows;
 const reasoningReceipts = (await client.query(
  `SELECT id,attempt_id,outcome,remote_disposition,http_status,observed_at,recorded_at,
    input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_micro_usd
   FROM reasoning_receipt WHERE universe_id=$1 ORDER BY recorded_at`, [scope.universeId],
 )).rows;
 const reasoningAccounting = (await client.query(
  `SELECT attempt_id,state,output_authority,created_at,all_duties_closed_at
   FROM reasoning_accounting WHERE universe_id=$1 ORDER BY created_at`, [scope.universeId],
 )).rows;

 const semantic = await exportSemanticHistory(client, scope.universeId);
 const personalModel = await exportPersonalModel(client, scope.universeId);
 const askAnswers = await exportAskAnswers(client, scope.universeId);
 const inquiries = await exportInquiries(client, scope.universeId);

 const rowCounts = {
  decisions: decisions.length, ledger: ledger.length, exposures: exposures.length,
  traces: traces.length, jobs: jobs.length, deviceSessions: deviceSessions.length,
  reasoningJobs: reasoningJobs.length, reasoningSteps: reasoningSteps.length,
  reasoningReceipts: reasoningReceipts.length, reasoningAccounting: reasoningAccounting.length,
  branchOpens: semantic.branchOpens.length, connectionFeedback: semantic.connectionFeedback.length,
  semanticProposals: semantic.proposals.length,
  attentionAccounts: personalModel.attentionAccounts.length, hypotheses: personalModel.hypotheses.length,
  encounterFeedback: personalModel.encounterFeedback.length,
  askAnswers: askAnswers.length,
  inquiries: inquiries.inquiries.length,
 };

 const existing = (await client.query(
  'SELECT id,exported_at FROM privacy_export_receipt WHERE universe_id=$1 AND request_id=$2',
  [scope.universeId, input.requestId],
 )).rows[0];
 const receiptRow = existing ?? (await client.query(
  `INSERT INTO privacy_export_receipt(id,universe_id,request_id,privacy_epoch,exported_at,row_counts)
   VALUES($1,$2,$3,$4,clock_timestamp(),$5) RETURNING id,exported_at`,
  [randomUUID(), scope.universeId, input.requestId, scope.privacyEpoch, JSON.stringify(rowCounts)],
 )).rows[0];

 return {
  receiptId: String(receiptRow.id), privacyEpoch: scope.privacyEpoch, exportedAt: isoDate(receiptRow.exported_at),
  rowCounts,
  // A development-token universe that has never been adopted through magic-link sign-in
  // (ADR-0026) has no bound account row yet, so there is no email to report — not an omission.
  account: { email: universeRow.email === null ? null : String(universeRow.email) },
  universe: {
   id: String(universeRow.id), revision: Number(universeRow.revision), privacyEpoch: Number(universeRow.privacy_epoch),
   recordingPausedAt: universeRow.recording_paused_at ? isoDate(universeRow.recording_paused_at) : null,
  },
  accounts: { keptAssetIds: (accountsRow.kept_asset_ids as string[]) ?? [], revision: Number(accountsRow.revision) },
  decisions, ledger, exposures, traces, jobs, deviceSessions,
  reasoning: { jobs: reasoningJobs, steps: reasoningSteps, receipts: reasoningReceipts, accounting: reasoningAccounting },
  semantic,
  personalModel,
  askAnswers,
  inquiries,
 };
}

function resetReceiptFromRow(row: Record<string, unknown>): PrivacyResetReceipt {
 return {
  receiptId: String(row.id),
  epochBefore: Number(row.epoch_before),
  epochAfter: Number(row.epoch_after),
  sessionsRevoked: Number(row.sessions_revoked),
  resetAt: isoDate(row.reset_at),
 };
}

/** ADR-0028 section "Reset": every step of `clearScrollHistory` above, plus — the one concrete
 * way this is stronger than Clear — every device session for the universe is revoked, including
 * the calling one; Clear deliberately rolls the calling session forward, Reset deliberately does
 * not. Same exact-retry contract as Clear/pause/resume, keyed on (universe, requestId). */
export async function resetPersonalUniverse(client: pg.PoolClient, scope: AuthScope, input: PrivacyResetInput): Promise<PrivacyResetReceipt> {
 const old = (await client.query(
  'SELECT id,epoch_before,epoch_after,sessions_revoked,reset_at FROM privacy_reset_receipt WHERE universe_id=$1 AND request_id=$2',
  [scope.universeId, input.requestId],
 )).rows[0];
 if (old) {
  if (old.epoch_before !== input.expectedPrivacyEpoch) throw new PrivacyLifecycleConflict('Reset key was reused with a different expected privacy epoch');
  return resetReceiptFromRow(old);
 }
 if (input.expectedPrivacyEpoch !== scope.privacyEpoch) throw new PrivacyLifecycleConflict();

 const nextEpoch = scope.privacyEpoch + 1;
 const universe = await client.query(`UPDATE universe SET privacy_epoch=$3,revision=revision+1
  WHERE id=$1 AND privacy_epoch=$2 RETURNING privacy_epoch`, [scope.universeId, scope.privacyEpoch, nextEpoch]);
 if (!universe.rowCount) throw new PrivacyLifecycleConflict();

 await erasePersonalHistory(client, scope.universeId, scope.privacyEpoch, nextEpoch);

 // Beyond Clear: end every session for this universe, including the caller's own.
 const revoked = await client.query(
  `UPDATE device_session SET revoked_at=clock_timestamp() WHERE universe_id=$1 AND revoked_at IS NULL RETURNING id`,
  [scope.universeId],
 );
 const sessionsRevoked = revoked.rowCount ?? 0;
 if (sessionsRevoked < 1) throw new Error('Reset must revoke at least the calling session');

 const receipt = (await client.query(
  `INSERT INTO privacy_reset_receipt(id,universe_id,request_id,epoch_before,epoch_after,sessions_revoked,reset_at)
   VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()) RETURNING id,epoch_before,epoch_after,sessions_revoked,reset_at`,
  [randomUUID(), scope.universeId, input.requestId, scope.privacyEpoch, nextEpoch, sessionsRevoked],
 )).rows[0];
 return resetReceiptFromRow(receipt);
}

/** ADR-0035: delete the owner account. Everything Reset erases, plus — in this same transaction —
 * every session of the universe (not just revoked), every sign-in token and dated privacy receipt,
 * and the account row; the universe is left empty and unbound, so a later sign-in with the owner
 * address creates a new account that adopts it fresh. The receipt written first is what lets the
 * schema guards (0030) permit exactly these deletions and nothing else, and it outlives the
 * account: it holds epochs, a count and a time, never the address.
 *
 * There is no replay: the calling session is deleted, so a retry cannot authenticate. A client
 * reports "deleted" on a 401 only when an earlier attempt of the same request may have landed
 * (ADR-0035 section 5); otherwise the session had simply ended before anything was sent. */
export async function deleteAccount(client: pg.PoolClient, scope: AuthScope, input: AccountDeletionInput): Promise<AccountDeletionReceipt> {
 if (input.expectedPrivacyEpoch !== scope.privacyEpoch) throw new PrivacyLifecycleConflict();
 const bound = (await client.query<{ account_id: string | null; email: string | null }>(
  'SELECT u.account_id, a.email FROM universe u LEFT JOIN account a ON a.id=u.account_id WHERE u.id=$1', [scope.universeId])).rows[0];
 if (!bound?.account_id || !bound.email) throw new PrivacyLifecycleConflict('This universe has no account to delete');
 const accountId = bound.account_id;
 // The same lock `requestMagicLink` takes before it inserts a sign-in token for this address (only
 // the owner address ever gets an account, so it is this account's). Without it a link requested
 // mid-deletion inserts a token after the tokens below are deleted and the account row can no
 // longer be deleted (a foreign-key 500). Lock order is universe row, then this; the magic-link
 // path never takes the universe lock, so the two cannot deadlock.
 await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ks-magic-link-account:${bound.email}`]);

 const nextEpoch = scope.privacyEpoch + 1;
 const universe = await client.query(`UPDATE universe SET privacy_epoch=$3,revision=revision+1,recording_paused_at=NULL
  WHERE id=$1 AND privacy_epoch=$2 RETURNING privacy_epoch`, [scope.universeId, scope.privacyEpoch, nextEpoch]);
 if (!universe.rowCount) throw new PrivacyLifecycleConflict();
 await erasePersonalHistory(client, scope.universeId, scope.privacyEpoch, nextEpoch);

 const sessionRows = (await client.query<{ id: string; origin: string }>('SELECT id, origin FROM device_session WHERE universe_id=$1', [scope.universeId])).rows;
 const sessions = sessionRows.length;
 if (sessions < 1) throw new Error('Account deletion must remove at least the calling session');
 // Named in the tombstone so `ensureDevelopmentSession` never re-creates them on the next start.
 const developmentSessionIds = sessionRows.filter(row => row.origin === 'development').map(row => row.id);
 const receipt = (await client.query(
  `INSERT INTO account_deletion_receipt(id,universe_id,account_id,request_id,epoch_before,epoch_after,sessions_deleted,development_session_ids)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8::uuid[]) RETURNING id,epoch_before,epoch_after,sessions_deleted,deleted_at`,
  [randomUUID(), scope.universeId, accountId, input.requestId, scope.privacyEpoch, nextEpoch, sessions, developmentSessionIds],
 )).rows[0];

 // Order is the foreign keys': tokens name the sessions they minted; sessions and the universe
 // name the account.
 await client.query('DELETE FROM sign_in_token WHERE account_id=$1', [accountId]);
 await client.query('DELETE FROM device_session WHERE universe_id=$1', [scope.universeId]);
 await client.query('UPDATE universe SET account_id=NULL WHERE id=$1', [scope.universeId]);
 for (const table of ['history_clear_receipt', 'privacy_recording_receipt', 'privacy_export_receipt', 'privacy_reset_receipt']) {
  await client.query(`DELETE FROM ${table} WHERE universe_id=$1`, [scope.universeId]);
 }
 const account = await client.query('DELETE FROM account WHERE id=$1', [accountId]);
 if (account.rowCount !== 1) throw new Error('Account row is missing');
 return {
  receiptId: String(receipt.id),
  epochBefore: Number(receipt.epoch_before),
  epochAfter: Number(receipt.epoch_after),
  sessionsDeleted: Number(receipt.sessions_deleted),
  deletedAt: isoDate(receipt.deleted_at),
 };
}
