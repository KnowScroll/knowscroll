import type { CutroomScopeTx, CutroomB, CutroomCandidate } from '../../../reasoning/public.js';
export interface CommissionBusiness {
  readonly worldId: 'dev' | 'stage';
  readonly businessRunId: string;
  readonly commandSha256: string;
  readonly attemptId: string | null;
}
export interface CommissionStore {
  lock(scope: CutroomScopeTx, businessRunId: string): Promise<CommissionBusiness | undefined>;
  insert(
    scope: CutroomScopeTx,
    candidate: CutroomCandidate,
    commandSha256: string,
    packageUtf8: string,
  ): Promise<boolean>;
  bind(scope: CutroomScopeTx, businessRunId: string, attemptId: string): Promise<void>;
}
export interface CommissionPorts {
  readonly reasoning: Pick<CutroomB, 'withScope' | 'admitted' | 'reserve' | 'readScoped'>;
  readonly store: CommissionStore;
  readonly sha256: (input: string) => string;
  /** Connected composition only: review and required maintenance commit with B reservation.
   * A false result rolls the whole new business/attempt/pool job transaction back. */
  readonly admitReview?: (scope: CutroomScopeTx, candidate: CutroomCandidate, attemptId: string) => Promise<boolean>;
}
