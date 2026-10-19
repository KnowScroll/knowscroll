import { applyActionContract, listSavedContract } from './experience.js';
import { healthContract } from './health.js';
import { redeemSignInContract, requestSignInContract, sessionContract, signOutContract } from './identity.js';

/** The complete HTTP contract of the KnowScroll API. Every route the API serves is listed here. */
export const apiContract = {
  health: healthContract,
  identity: {
    requestSignIn: requestSignInContract,
    redeemSignIn: redeemSignInContract,
    session: sessionContract,
    signOut: signOutContract,
  },
  experience: {
    applyAction: applyActionContract,
    listSaved: listSavedContract,
  },
};

export type ApiContract = typeof apiContract;
