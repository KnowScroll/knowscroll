import { CONCEPTS } from '../../content/public.js';
import { catalogueOf, type Catalogue } from '../domain/catalogue.js';

/** The concept catalogue Content pins, as Cartographer evaluates against it (D-416). A later slice reads it from Postgres. */
export const PRODUCT_CATALOGUE: Catalogue = catalogueOf(CONCEPTS);
