import type { JourneyEvent, RelatedKeys } from '../domain/journey.js';
import type {
  CartographerSummary,
  ErrorRow,
  OutcomeCount,
  Piece,
  PrivacySummary,
  ProductionRunRow,
  QueueRow,
  RefusedAnswerRow,
  ReelOrderRow,
  UsageSummary,
} from '../domain/panels.js';

/** Reads `ops.journey_events`. It changes nothing and holds no lock. */
export interface JourneyStore {
  /**
   * The newest steps (at most `limit`) that carry `id` in a key column. A universe ID answers only
   * when `includeUniverse` is set: it is a person's whole journey.
   */
  findById(id: string, limit: number, includeUniverse: boolean): Promise<readonly JourneyEvent[]>;
  /**
   * Steps that carry any of `keys`, restricted to shared records and to the records of `universeIds`:
   * a journey never reads into another person's records.
   */
  findRelated(keys: RelatedKeys, universeIds: readonly string[], limit: number): Promise<readonly JourneyEvent[]>;
}

/** Reads the other `ops` views. Each piece says for itself when its view cannot be read. */
export interface PanelStore {
  queues(): Promise<Piece<readonly QueueRow[]>>;
  providerOutcomes(windowHours: number): Promise<Piece<readonly OutcomeCount[]>>;
  usage(windowHours: number): Promise<Piece<UsageSummary>>;
  recentErrors(limit: number): Promise<Piece<readonly ErrorRow[]>>;
  productionRuns(limit: number): Promise<Piece<readonly ProductionRunRow[]>>;
  refusedAnswers(limit: number): Promise<Piece<readonly RefusedAnswerRow[]>>;
  reelOrders(limit: number): Promise<Piece<readonly ReelOrderRow[]>>;
  cartographer(limit: number): Promise<Piece<CartographerSummary>>;
  privacy(limit: number): Promise<Piece<PrivacySummary>>;
}
