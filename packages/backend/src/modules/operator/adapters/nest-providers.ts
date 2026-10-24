import type { Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/index.js';
import { operatorAddressMatcher, type ReadAccountAddress } from '../../identity/public.js';
import { makeIsOperator } from '../application/operator-access.js';
import { makeReadJourney, type ReadJourney } from '../application/read-journey.js';
import { makeReadOperatorPanels, type ReadOperatorPanels } from '../application/read-panels.js';
import { IS_OPERATOR, READ_JOURNEY, READ_OPERATOR_PANELS } from '../public.js';
import { makeJourneyStore, makePanelStore } from './ops-store.js';

/** The journey use case over one database handle (framework-free; also used by the worker's operator command). */
export function readJourneyFor(db: Kysely<Database>): ReadJourney {
  return makeReadJourney({ store: makeJourneyStore(db), now: () => new Date() });
}

/** The panels use case over one database handle. */
export function readOperatorPanelsFor(db: Kysely<Database>): ReadOperatorPanels {
  return makeReadOperatorPanels({ store: makePanelStore(db), now: () => new Date() });
}

/**
 * Nest wiring of the operator use cases for the API composition root. `entries` are the world's
 * `KS_OPERATOR_ACCOUNTS`; an entry that is not a valid address pattern was already refused when
 * the configuration was read, so an unreadable one here matches nobody.
 */
export function operatorProviders(tokens: {
  readonly database: symbol;
  readonly readAccountAddress: symbol;
  readonly operatorAccounts: readonly string[];
}) {
  return [
    {
      provide: READ_OPERATOR_PANELS,
      inject: [tokens.database],
      useFactory: (db: Kysely<Database>): ReadOperatorPanels => readOperatorPanelsFor(db),
    },
    {
      provide: READ_JOURNEY,
      inject: [tokens.database],
      useFactory: (db: Kysely<Database>): ReadJourney => readJourneyFor(db),
    },
    {
      provide: IS_OPERATOR,
      inject: [tokens.readAccountAddress],
      useFactory: (readAddress: ReadAccountAddress) =>
        makeIsOperator({
          readAddress,
          matchers: tokens.operatorAccounts.flatMap((entry) => {
            const matches = operatorAddressMatcher(entry);
            return matches === undefined ? [] : [matches];
          }),
        }),
    },
  ];
}
