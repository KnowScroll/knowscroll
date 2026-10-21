import type { z } from 'zod';
import type {
  FriendCommandAcceptance,
  FriendPairResultSchema,
  OwnSharingProfileSchema,
  SharingPersonLookupSchema,
  SharingProfileAcceptanceSchema,
} from '@knowscroll/contracts';
import type { PersonalAuthority } from '../identity/public.js';
import type { Operation } from './domain/friends.js';
import type { Result } from './application/ports.js';
/** Backend-only ports. No HTTP routes, invitations, lists, presence or visitor implementation. */
export type { Result as SocialResult, SocialRefusal } from './application/ports.js';
export type { Operation as FriendOperation } from './domain/friends.js';
export interface SocialUseCases {
  readProfile(authority: PersonalAuthority): Promise<Result<z.infer<typeof OwnSharingProfileSchema>>>;
  setProfile(
    authority: PersonalAuthority,
    input: unknown,
  ): Promise<Result<z.infer<typeof SharingProfileAcceptanceSchema>>>;
  lookup(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof SharingPersonLookupSchema>>>;
  readPair(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof FriendPairResultSchema>>>;
  command(authority: PersonalAuthority, operation: Operation, input: unknown): Promise<Result<FriendCommandAcceptance>>;
}
export const SOCIAL_USE_CASES = Symbol('social.useCases');
