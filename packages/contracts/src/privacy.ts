import { z } from 'zod';
import { privacyEpoch, uuid } from './primitives.ts';

export const historyClearInput = z
  .object({
    requestId: uuid,
    expectedPrivacyEpoch: privacyEpoch,
    confirmation: z.literal('clear-scroll-history'),
  })
  .strict();
export type HistoryClearInput = z.infer<typeof historyClearInput>;
export type HistoryClearReceipt = {
  receiptId: string;
  privacyEpoch: number;
  clearedAt: string;
};

// ADR-0028 — privacy lifecycle: pause, export and reset. Pause/resume and export share one
// unconfirmed shape (no destructive confirmation literal is needed for either); reset requires
// its own deliberate confirmation literal, matching Clear's pattern, because it is irreversible.
export const privacyLifecycleInput = z
  .object({
    requestId: uuid,
    expectedPrivacyEpoch: privacyEpoch,
  })
  .strict();
export type PrivacyLifecycleInput = z.infer<typeof privacyLifecycleInput>;
export const privacyResetInput = z
  .object({
    requestId: uuid,
    expectedPrivacyEpoch: privacyEpoch,
    confirmation: z.literal('reset-personal-universe'),
  })
  .strict();
export type PrivacyResetInput = z.infer<typeof privacyResetInput>;
// ADR-0035: deleting the account is Reset plus the account, its sessions, sign-in tokens and dated
// privacy receipts; it has its own literal because it removes more than Reset does.
export const accountDeletionInput = z
  .object({
    requestId: uuid,
    expectedPrivacyEpoch: privacyEpoch,
    confirmation: z.literal('delete-my-account-and-history'),
  })
  .strict();
export type AccountDeletionInput = z.infer<typeof accountDeletionInput>;

export type PrivacyRecordingReceipt = {
  receiptId: string;
  action: 'pause' | 'resume';
  privacyEpoch: number;
  recordingPausedAt: string | null;
  appliedAt: string;
};
export type PrivacyExportRowCounts = {
  decisions: number;
  ledger: number;
  exposures: number;
  traces: number;
  jobs: number;
  deviceSessions: number;
  reasoningJobs: number;
  reasoningSteps: number;
  reasoningReceipts: number;
  reasoningAccounting: number;
  branchOpens: number;
  connectionFeedback: number;
  semanticProposals: number;
  attentionAccounts: number;
  hypotheses: number;
  encounterFeedback: number;
  askAnswers: number;
  inquiries: number;
  awayAcknowledgements: number;
  relics: number;
  objections: number;
  demands: number;
};
export type PrivacyExportDeviceSession = {
  deviceId: string;
  origin: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
};
export type PrivacyExportResult = {
  receiptId: string;
  privacyEpoch: number;
  exportedAt: string;
  rowCounts: PrivacyExportRowCounts;
  account: { email: string | null };
  universe: {
    id: string;
    revision: number;
    privacyEpoch: number;
    recordingPausedAt: string | null;
  };
  accounts: { keptAssetIds: string[]; revision: number };
  decisions: unknown[];
  ledger: unknown[];
  exposures: unknown[];
  traces: unknown[];
  jobs: unknown[];
  deviceSessions: PrivacyExportDeviceSession[];
  reasoning: {
    jobs: unknown[];
    steps: unknown[];
    receipts: unknown[];
    accounting: unknown[];
  };
  semantic: {
    branchOpens: unknown[];
    connectionFeedback: unknown[];
    proposals: unknown[];
    bridges: unknown[];
  };
  personalModel: {
    attentionAccounts: unknown[];
    hypotheses: unknown[];
    encounterFeedback: unknown[];
    atlasPlaces: unknown[];
    atlasDeltas: unknown[];
    /** #163: Idea Rooms, their inhabitants and deltas (ADR-0045). */
    rooms: unknown[];
    roomInhabitants: unknown[];
    roomDeltas: unknown[];
  };
  /** #132: answer requests and their applied outcomes (ADR-0033). */
  askAnswers: unknown[];
  /** #132: background inquiry consent, its requests, mail and inquiries (ADR-0038). */
  inquiries: {
    consent: unknown[];
    consentRequests: unknown[];
    mail: unknown[];
    inquiries: unknown[];
  };
  /** #134/#165: return markers, Relics and the reader's objections (ADR-0039, ADR-0044). */
  returns: {
    acknowledgements: unknown[];
    relics: unknown[];
    objections: unknown[];
  };
  /** #164: content demands, their waiters and bindings (ADR-0046). */
  inventory: { demands: unknown[]; waiters: unknown[]; bindings: unknown[] };
};
export type PrivacyResetReceipt = {
  receiptId: string;
  epochBefore: number;
  epochAfter: number;
  sessionsRevoked: number;
  resetAt: string;
};
export type AccountDeletionReceipt = {
  receiptId: string;
  epochBefore: number;
  epochAfter: number;
  sessionsDeleted: number;
  deletedAt: string;
};
