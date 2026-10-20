import { mediaGrantContract } from './media.js';
import { exposureContextContract, navigateExperienceContract } from './navigation.js';
import {
  activateExposureContract,
  applyActionContract,
  exposureDocumentContract,
  listSavedContract,
  openExposureContract,
} from './experience.js';
import { healthContract } from './health.js';
import {
  peekSignInContract,
  redeemSignInContract,
  requestSignInContract,
  sessionContract,
  signOutContract,
} from './identity.js';
import { evidenceDiagnosticsContract, submitObservationsContract } from './interactions.js';

/** The complete HTTP contract of the KnowScroll API. Every route the API serves is listed here. */
export const apiContract = {
  health: healthContract,
  media: { grant: mediaGrantContract },
  identity: {
    requestSignIn: requestSignInContract,
    peekSignIn: peekSignInContract,
    redeemSignIn: redeemSignInContract,
    session: sessionContract,
    signOut: signOutContract,
  },
  experience: {
    applyAction: applyActionContract,
    listSaved: listSavedContract,
    openExposure: openExposureContract,
    navigate: navigateExperienceContract,
    activateExposure: activateExposureContract,
    exposureDocument: exposureDocumentContract,
    exposureContext: exposureContextContract,
  },
  observations: {
    submit: submitObservationsContract,
  },
  diagnostics: {
    evidence: evidenceDiagnosticsContract,
  },
};

export type ApiContract = typeof apiContract;
