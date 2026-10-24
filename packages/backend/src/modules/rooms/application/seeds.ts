import type { InhabitantId } from '../domain/contribution.js';
import type { JoinRule } from '../domain/membership.js';

/** A room as the operator defines it. The slug is its stable name; seeding twice changes nothing. */
export interface RoomSeed {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly guidelines: string;
  readonly topic: { readonly kind: 'system' | 'planet'; readonly id: string };
  readonly joinRule: JoinRule;
  readonly inhabitants: readonly InhabitantId[];
}
