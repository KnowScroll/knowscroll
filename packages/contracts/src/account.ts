import { oc } from '@orpc/contract';
import { z } from 'zod';
import { CommandIdSchema, UuidSchema } from './ids.js';

/**
 * Account: signed-in sessions, personal data export and account deletion (#246, D-043).
 * Every `/v1` route needs the scope claim (`X-KS-Scope`); the two receipt routes under `/auth` need
 * no session, because deletion signs the person out everywhere and their device must still be able
 * to ask how it is going. The export file itself is served by `GET /auth/exports/{token}` (not a
 * contract route: it answers a file, not JSON).
 */

/** What every other person sees where a deleted account's shared history remains (D-043). */
export const DELETED_ACCOUNT_LABEL = 'Deleted account';

/** The words a person confirms account deletion with; the wire carries it so a client cannot send it by accident. */
export const DELETE_ACCOUNT_CONFIRMATION = 'delete-account-erase-everything';

const Epoch = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

// ── Sessions ────────────────────────────────────────────────────────────────────────────────

/**
 * One live session of the caller: coarse device label ("Chrome on macOS"), when it signed in, when
 * it was last used (to the nearest few minutes), and whether it is the one making this request.
 * `id` names a session only for ending it; it is no credential.
 */
export const SessionSummarySchema = z.strictObject({
  id: UuidSchema,
  client: z.enum(['web', 'native']),
  deviceLabel: z.string().min(1).max(80),
  signedInAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime(),
  current: z.boolean(),
});

export const SessionListSchema = z.strictObject({ sessions: z.array(SessionSummarySchema).max(20) });

/** The caller's live sessions, most recently used first. Read-only. */
export const listSessionsContract = oc
  .route({ method: 'GET', path: '/v1/account/sessions', successStatus: 200, tags: ['account'] })
  .output(SessionListSchema);

/**
 * Signs one other session out. `CONFLICT` (409) for the presented session (signing out here is
 * `/auth/sign-out`, which also clears the cookie); `NOT_FOUND` (404) for an id that is unknown,
 * already ended or another person's, all the same answer.
 */
export const EndSessionSchema = z.strictObject({ sessionId: UuidSchema });
export const endSessionContract = oc
  .route({ method: 'POST', path: '/v1/account/sessions/end', successStatus: 200, tags: ['account'] })
  .input(EndSessionSchema)
  .output(z.strictObject({ status: z.literal('ended') }));

/** Signs out every session except the presented one. */
export const endOtherSessionsContract = oc
  .route({ method: 'POST', path: '/v1/account/sessions/end-others', successStatus: 200, tags: ['account'] })
  .output(z.strictObject({ revoked: z.number().int().min(0) }));

// ── Export ──────────────────────────────────────────────────────────────────────────────────

export const DataExportStateSchema = z.enum(['preparing', 'ready', 'downloaded', 'expired', 'failed']);

/** One export receipt: its state and, when ready, until when the file can be downloaded. */
export const DataExportSummarySchema = z.strictObject({
  id: UuidSchema,
  state: DataExportStateSchema,
  requestedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
});

/**
 * Asks for an export. `exportId` is chosen by the client once per intent and reused on retry: the
 * same id answers with the same export. While one is preparing, asking again returns that one.
 * 202 means the request is durable and the file is being built; it is ready when a read says so.
 */
export const RequestDataExportSchema = z.strictObject({ exportId: CommandIdSchema });
export const requestDataExportContract = oc
  .route({ method: 'POST', path: '/v1/account/exports', successStatus: 202, tags: ['account'] })
  .input(RequestDataExportSchema)
  .output(z.strictObject({ export: DataExportSummarySchema }));

/** The caller's newest exports (at most five), most recent first. Read-only. */
export const listDataExportsContract = oc
  .route({ method: 'GET', path: '/v1/account/exports', successStatus: 200, tags: ['account'] })
  .output(z.strictObject({ exports: z.array(DataExportSummarySchema).max(5) }));

/**
 * A link for downloading a ready export once. `path` is relative to the API origin (under
 * `/auth`, the prefix every world already proxies without a session), carries a one-time token and
 * works for one minute and one download: keep it in memory, open it, never log or store it. `NOT_FOUND` (404) for an unknown export, `CONFLICT` (409) when it is not ready.
 */
export const DataExportLinkSchema = z.strictObject({
  path: z.string().startsWith('/auth/exports/').max(200),
  expiresAt: z.iso.datetime(),
});
export const mintDataExportLinkContract = oc
  .route({ method: 'POST', path: '/v1/account/exports/link', successStatus: 200, tags: ['account'] })
  .input(z.strictObject({ exportId: UuidSchema }))
  .output(DataExportLinkSchema);

// ── Deletion ────────────────────────────────────────────────────────────────────────────────

/**
 * Deletes the caller's account. `receiptId` is chosen by the client and kept: it is the only
 * handle a device has once every session has ended, and it names no one. The answer is 202 and
 * the session is over: the cookie is cleared, and the work runs in the background. `CONFLICT`
 * (409) when the request raced another or the receipt id is taken; `PRIVACY_EPOCH_CHANGED` (409)
 * when `expectedPrivacyEpoch` is stale.
 */
export const DeleteAccountSchema = z.strictObject({
  receiptId: CommandIdSchema,
  expectedPrivacyEpoch: Epoch,
  confirmation: z.literal(DELETE_ACCOUNT_CONFIRMATION),
});
export const AccountDeletionAcceptanceSchema = z.strictObject({
  receiptId: UuidSchema,
  requestedAt: z.iso.datetime(),
});
export const deleteAccountContract = oc
  .route({ method: 'POST', path: '/v1/account/delete', successStatus: 202, tags: ['account'] })
  .input(DeleteAccountSchema)
  .output(AccountDeletionAcceptanceSchema);

/**
 * How a deletion is going: still being removed (`in_progress`), waiting for a retry that the
 * person or the system may ask for (`needs_retry`), or done (`completed`). Needs no session; the
 * receipt id is the capability, and the answer says nothing about the person.
 */
export const AccountDeletionStateSchema = z.enum(['in_progress', 'needs_retry', 'completed']);
export const AccountDeletionStatusSchema = z.strictObject({ state: AccountDeletionStateSchema });
export const readAccountDeletionContract = oc
  .route({ method: 'GET', path: '/auth/deletion/{receiptId}', successStatus: 200, tags: ['account'] })
  .input(z.strictObject({ receiptId: UuidSchema }))
  .output(AccountDeletionStatusSchema);

/** Asks for the same deletion to be worked on again now. No session; `NOT_FOUND` (404) for an unknown receipt. */
export const retryAccountDeletionContract = oc
  .route({ method: 'POST', path: '/auth/deletion/retry', successStatus: 200, tags: ['account'] })
  .input(z.strictObject({ receiptId: UuidSchema }))
  .output(AccountDeletionStatusSchema);

export const accountContract = {
  sessions: listSessionsContract,
  endSession: endSessionContract,
  endOtherSessions: endOtherSessionsContract,
  delete: deleteAccountContract,
  deletionStatus: readAccountDeletionContract,
  retryDeletion: retryAccountDeletionContract,
  exports: {
    request: requestDataExportContract,
    list: listDataExportsContract,
    link: mintDataExportLinkContract,
  },
};

export type SessionSummary = z.infer<typeof SessionSummarySchema>;
export type DataExportSummary = z.infer<typeof DataExportSummarySchema>;
export type DataExportState = z.infer<typeof DataExportStateSchema>;
export type AccountDeletionState = z.infer<typeof AccountDeletionStateSchema>;
