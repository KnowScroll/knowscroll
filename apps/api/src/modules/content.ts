import { contentProviders } from '@knowscroll/backend/modules/content/nest-providers';

/** Content wiring for the API composition root: the asset lookup experience's commands use. */
export const contentWiring = contentProviders();
