import { identityProviders } from '@knowscroll/backend/modules/identity/nest-providers';
import { DATABASE } from '../tokens.js';

/** Identity wiring for the API composition root: the read ports callers and sockets use. */
export const identityWiring = identityProviders({ database: DATABASE });
