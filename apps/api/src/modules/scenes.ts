import type { Provider } from '@nestjs/common';
import { sceneProviders } from '@knowscroll/backend/modules/scenes/nest-providers';
import { WITH_PERSONAL_SCOPE } from '../tokens.js';

/** Reuses existing ports. The projector function binding is inert: the API registers no consumer. */
export const sceneWiring: Provider[] = sceneProviders({ withPersonalScope: WITH_PERSONAL_SCOPE });
