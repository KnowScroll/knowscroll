/** Labelled fixtures for report tests: the real report use cases over the test database, no HTTP. */
import type { Kysely } from 'kysely';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { FIND_ASSET_FOR_ACTION } from '@knowscroll/backend/modules/content';
import { contentProviders } from '@knowscroll/backend/modules/content/nest-providers';
import { feedbackProviders, reportUseCases } from '@knowscroll/backend/modules/feedback/nest-providers';
import { accountAccessUseCases } from '@knowscroll/backend/modules/identity/nest-providers';
import {
  READ_REPORTABLE_ROOM_MESSAGE,
  READ_ROOM_REPORTS,
  type ReadRoomReports,
} from '@knowscroll/backend/modules/rooms';
import { roomsProviders } from '@knowscroll/backend/modules/rooms/nest-providers';
import { READ_PUBLIC_PEOPLE, READ_REPORTABLE_MESSAGE } from '@knowscroll/backend/modules/social';
import { socialPeopleProviders } from '@knowscroll/backend/modules/social/nest-providers';
import { openToEveryone } from './audience.js';

/** Looks a provider up by its token: the same value the API's composition root binds. */
function provided<T>(providers: readonly { provide: unknown; useValue?: unknown }[], token: symbol): T {
  const found = providers.find((provider) => provider.provide === token);
  if (found === undefined || !('useValue' in found)) throw new Error('CI provider missing');
  return found.useValue as T;
}

/** The report use cases as the API builds them; `now` can be moved to test the daily bound. */
export function reportCases(db: Kysely<Database>, now: () => Date = () => new Date()) {
  const access = accountAccessUseCases({ db, lockTimeoutMs: 10_000 });
  const people = socialPeopleProviders();
  const rooms = roomsProviders({
    withPersonalScope: Symbol('unused'),
    enqueueJob: Symbol('unused'),
    database: Symbol('unused'),
  });
  return reportUseCases({
    withScope: makeWithPersonalScope(db, { lockTimeoutMs: 10_000 }),
    fenceOwn: access.fenceOwnAccount,
    findAsset: provided(contentProviders(), FIND_ASSET_FOR_ACTION),
    // No Scroll in these tests is made for a thread.
    checkAudience: openToEveryone,
    readMessage: provided(people, READ_REPORTABLE_MESSAGE),
    readRoomMessage: provided(rooms, READ_REPORTABLE_ROOM_MESSAGE),
    readPeople: provided(people, READ_PUBLIC_PEOPLE),
    now,
  });
}

/** The read the Rooms module shows a room's moderators, as the API's composition root binds it. */
export const roomReportsReader = provided<ReadRoomReports>(
  feedbackProviders({ withPersonalScope: Symbol('unused') }),
  READ_ROOM_REPORTS,
);
