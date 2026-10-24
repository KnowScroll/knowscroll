import type { Provider } from '@nestjs/common';
import { roomsProviders } from '@knowscroll/backend/modules/rooms/nest-providers';
import { ENQUEUE_JOB, WITH_PERSONAL_SCOPE } from '../tokens.js';

/**
 * Rooms for the API composition root. The room use cases read people, friends, content and the
 * caller's visited markers through the neighbouring modules' ports, which the social, content and
 * experience wiring already bind.
 */
export const roomsWiring: Provider[] = roomsProviders({
  withPersonalScope: WITH_PERSONAL_SCOPE,
  enqueueJob: ENQUEUE_JOB,
});
