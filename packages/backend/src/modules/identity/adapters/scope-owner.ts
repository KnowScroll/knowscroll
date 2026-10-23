import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { CheckPersonalOwnerActive } from '../public.js';
/** The root is already locked. Identity suspension must lock its roots before changing status;
 * this read adds no account lock or inverse acquisition. It does not inspect sessions/devices.
 */
export const checkPersonalOwnerActive: CheckPersonalOwnerActive = async (scope) => {
  const owner = await transactionOf(scope)
    .selectFrom('identity.universes as u')
    .innerJoin('identity.accounts as a', 'a.id', 'u.account_id')
    .select('a.status')
    .where('u.id', '=', scope.authority.universeId)
    .executeTakeFirst();
  return owner?.status === 'active';
};
