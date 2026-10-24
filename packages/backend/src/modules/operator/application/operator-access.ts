/**
 * Whether an account may use the operator routes: its address matches one of the world's operator
 * entries (`KS_OPERATOR_ACCOUNTS`, an exact address or a one-`*` pattern, D-044).
 *
 * Authority: this is the check; it runs on the server for every operator call and reads the
 * account's address now, so removing an entry or an account takes effect on the next request.
 * Side effects: one read. An unreadable or inactive account is not an operator.
 */
export type IsOperator = (accountId: string) => Promise<boolean>;

export function makeIsOperator(deps: {
  readonly readAddress: (accountId: string) => Promise<string | undefined>;
  /** One matcher per configured entry. */
  readonly matchers: readonly ((address: string) => boolean)[];
}): IsOperator {
  return async (accountId) => {
    if (deps.matchers.length === 0) return false;
    const address = await deps.readAddress(accountId);
    return address !== undefined && deps.matchers.some((matches) => matches(address));
  };
}
