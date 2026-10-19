import { applyActionContract, listSavedContract } from './experience.js';
import { healthContract } from './health.js';

/** The complete HTTP contract of the KnowScroll API. Every route the API serves is listed here. */
export const apiContract = {
  health: healthContract,
  experience: {
    applyAction: applyActionContract,
    listSaved: listSavedContract,
  },
};

export type ApiContract = typeof apiContract;
