import { z } from 'zod';

// ADR-0026 — real sign-in: one owner account, email magic link. `email`/`token` are never
// transformed here (normalization is the sign-in module's job, over the exact caller-supplied
// string) so a schema failure never itself distinguishes anything about the value's content.
export const magicLinkRequestInput = z
  .object({ email: z.string().min(1).max(320) })
  .strict();
export type MagicLinkRequestInput = z.infer<typeof magicLinkRequestInput>;
export const signInConfirmQuery = z
  .object({ token: z.string().min(1).max(512) })
  .strict();
export type SignInConfirmQuery = z.infer<typeof signInConfirmQuery>;
export type SignInConfirmReceipt = { valid: boolean };
export type MagicLinkRequestReceipt = { status: 'requested' };
export type SignInSessionReceipt = {
  sessionToken: string;
  sessionId: string;
  deviceId: string;
  universeId: string;
  privacyEpoch: number;
  expiresAt: string;
  accountId: string;
  origin: 'magic_link';
};
