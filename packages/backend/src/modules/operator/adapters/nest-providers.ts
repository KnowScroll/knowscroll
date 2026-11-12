import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/index.js';
import {
  operatorAddressMatcher,
  type IssueOperatorSignIn,
  type ListDisposableAddresses,
  type ReadAccountAddress,
} from '../../identity/public.js';
import type { CanaryPorts } from '../application/canary/ports.js';
import { makeIsOperator } from '../application/operator-access.js';
import { makeReadJourney, type ReadJourney } from '../application/read-journey.js';
import { makeReadOperatorPanels, type ReadOperatorPanels } from '../application/read-panels.js';
import { IS_OPERATOR, READ_JOURNEY, READ_OPERATOR_PANELS, RUN_WATCHDOG } from '../public.js';
import { makeRunWatchdog, type RunWatchdog } from '../application/run-watchdog.js';
import { signInOverHttp } from './canary/http-api.js';
import { makeCanaryReads } from './canary/reads-store.js';
import { makeJourneyStore, makePanelStore } from './ops-store.js';
import { makeWatchdogStore } from './watchdog-store.js';

/** The journey use case over one database handle (framework-free; also used by the worker's operator command). */
export function readJourneyFor(db: Kysely<Database>): ReadJourney {
  return makeReadJourney({ store: makeJourneyStore(db), now: () => new Date() });
}

/** The panels use case over one database handle. */
export function readOperatorPanelsFor(db: Kysely<Database>): ReadOperatorPanels {
  return makeReadOperatorPanels({ store: makePanelStore(db), now: () => new Date() });
}

/**
 * The canary's world (#674, D-413) over one database handle: accounts are minted with the existing operator
 * sign-in use case and redeemed through the real HTTP route at `baseUrl`; reads are the read-only operator views;
 * pacing is the wall clock. Framework-free; built by the worker's operator command, which owns the composition.
 */
export function canaryPortsFor(deps: {
  readonly db: Kysely<Database>;
  readonly issueSignIn: IssueOperatorSignIn;
  /** The disposable accounts' addresses, for cleanup of the canary's own. */
  readonly listDisposableAddresses: ListDisposableAddresses;
  /** Where the API answers (the world's public origin, or a loopback address on the server). */
  readonly baseUrl: string;
  /** The world's own origin, which cookie-authenticated writes must carry. */
  readonly publicOrigin: string;
}): CanaryPorts {
  const http = { baseUrl: deps.baseUrl, origin: deps.publicOrigin, newId: randomUUID };
  return {
    accounts: {
      async mint(address) {
        const issued = await deps.issueSignIn({ email: address });
        return issued.kind === 'issued'
          ? { kind: 'issued', link: issued.link }
          : { kind: 'refused', reason: issued.reason };
      },
      listCanaryAddresses: (query) => deps.listDisposableAddresses(query),
      signIn: (link) => signInOverHttp(http, link),
    },
    reads: makeCanaryReads(deps.db),
    pacer: {
      nowMs: () => performance.now(),
      sleep: (ms, signal) =>
        new Promise<void>((resolve) => {
          if (signal?.aborted === true) return resolve();
          const done = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', done);
            resolve();
          };
          const timer = setTimeout(done, ms);
          signal?.addEventListener('abort', done, { once: true });
        }),
    },
    newId: randomUUID,
  };
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

/** The worker's hourly watchdog pass over `ops.watchdog` (D-411). Reads only. */
export function watchdogProviders(tokens: { readonly database: symbol }) {
  return [
    {
      provide: RUN_WATCHDOG,
      inject: [tokens.database],
      useFactory: (db: Kysely<Database>): RunWatchdog =>
        makeRunWatchdog({ store: makeWatchdogStore(db), now: () => new Date() }),
    },
  ];
}
