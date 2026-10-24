import { DELETED_ACCOUNT_LABEL, type PublicPersonRef } from '@knowscroll/contracts';

/**
 * Who stands in for a person whose account was deleted, wherever their shared history remains for
 * someone else (D-043): a fixed, neutral person with no name, handle or ID of the deleted one.
 */
export const DELETED_PERSON: PublicPersonRef = {
  kind: 'person',
  personId: '00000000-0000-4000-8000-000000000000',
  handle: 'deleted.account',
  displayName: DELETED_ACCOUNT_LABEL,
};
