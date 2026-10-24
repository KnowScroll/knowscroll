import { describe, expect, it } from 'vitest';
import { OpenAPIGenerator } from '@orpc/openapi';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';
import {
  AccountDeletionAcceptanceSchema,
  DELETE_ACCOUNT_CONFIRMATION,
  DataExportLinkSchema,
  DataExportSummarySchema,
  DeleteAccountSchema,
  RequestDataExportSchema,
  SessionListSchema,
  SessionSummarySchema,
  accountContract,
} from './account.js';
import { SCOPE_HEADER, UNSCOPED_V1_ROUTES } from './identity.js';
import { apiContract } from './router.js';

const id = '3b0c6d3a-6d5f-4d0e-9b5f-1f6a2f0c9a11';

describe('account contracts', () => {
  it('lists sessions with a coarse label and nothing that could be a credential', () => {
    const session = {
      id,
      client: 'web',
      deviceLabel: 'Chrome on macOS',
      signedInAt: '2026-10-24T09:00:00.000Z',
      lastUsedAt: '2026-10-24T10:00:00.000Z',
      current: true,
    };
    expect(SessionSummarySchema.parse(session)).toEqual(session);
    expect(() => SessionSummarySchema.parse({ ...session, tokenHash: 'a'.repeat(64) })).toThrow();
    expect(() => SessionSummarySchema.parse({ ...session, deviceLabel: '' })).toThrow();
    expect(() => SessionListSchema.parse({ sessions: Array.from({ length: 21 }, () => session) })).toThrow();
  });

  it('requires the exact confirmation, a receipt id and the epoch the person saw to delete an account', () => {
    const request = { receiptId: id, expectedPrivacyEpoch: 3, confirmation: DELETE_ACCOUNT_CONFIRMATION };
    expect(DeleteAccountSchema.parse(request)).toEqual(request);
    expect(() => DeleteAccountSchema.parse({ ...request, confirmation: 'yes' })).toThrow();
    expect(() => DeleteAccountSchema.parse({ ...request, expectedPrivacyEpoch: 0 })).toThrow();
    expect(() => DeleteAccountSchema.parse({ ...request, receiptId: 'not-a-uuid' })).toThrow();
    expect(() => DeleteAccountSchema.parse({ ...request, accountId: id })).toThrow();
    expect(
      AccountDeletionAcceptanceSchema.parse({ receiptId: id, requestedAt: '2026-10-24T10:00:00.000Z' }),
    ).toBeDefined();
  });

  it('shapes export receipts and links', () => {
    expect(RequestDataExportSchema.parse({ exportId: id })).toEqual({ exportId: id });
    for (const state of ['preparing', 'ready', 'downloaded', 'expired', 'failed'])
      expect(
        DataExportSummarySchema.parse({ id, state, requestedAt: '2026-10-24T10:00:00.000Z', expiresAt: null }).state,
      ).toBe(state);
    expect(() =>
      DataExportSummarySchema.parse({ id, state: 'gone', requestedAt: '2026-10-24T10:00:00.000Z', expiresAt: null }),
    ).toThrow();
    expect(
      DataExportLinkSchema.parse({
        path: `/auth/exports/kse_${'A'.repeat(43)}`,
        expiresAt: '2026-10-24T10:01:00.000Z',
      }),
    );
    expect(() =>
      DataExportLinkSchema.parse({ path: 'https://elsewhere.example/x', expiresAt: '2026-10-24T10:01:00.000Z' }),
    ).toThrow();
  });

  it('puts every session-bound route under /v1 (scope claim required) and only the receipts outside it', async () => {
    const document = await new OpenAPIGenerator({ schemaConverters: [new ZodToJsonSchemaConverter()] }).generate(
      accountContract,
      { info: { title: 'account', version: '0' } },
    );
    expect(Object.keys(document.paths ?? {}).sort()).toEqual([
      '/auth/deletion/retry',
      '/auth/deletion/{receiptId}',
      '/v1/account/delete',
      '/v1/account/exports',
      '/v1/account/exports/link',
      '/v1/account/sessions',
      '/v1/account/sessions/end',
      '/v1/account/sessions/end-others',
    ]);
    expect(Object.keys(document.paths?.['/v1/account/exports'] ?? {}).sort()).toEqual(['get', 'post']);
    // No exemption from the scope claim exists for any of them, and the router serves them.
    expect(UNSCOPED_V1_ROUTES).toEqual([]);
    expect(SCOPE_HEADER).toBe('x-ks-scope');
    expect(apiContract.account).toBe(accountContract);
  });
});
