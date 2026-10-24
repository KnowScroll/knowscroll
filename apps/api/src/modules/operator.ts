import { READ_ACCOUNT_ADDRESS } from '@knowscroll/backend/modules/identity';
import { operatorProviders } from '@knowscroll/backend/modules/operator/nest-providers';
import { DATABASE } from '../tokens.js';

/**
 * Operator wiring for the API composition root: the panels and journey use cases over the
 * application database role, and the check of who is an operator (`KS_OPERATOR_ACCOUNTS`).
 */
export function operatorWiring(operatorAccounts: readonly string[]) {
  return operatorProviders({ database: DATABASE, readAccountAddress: READ_ACCOUNT_ADDRESS, operatorAccounts });
}
