import { formationPresentationContract } from './formation-presentation.js';
import { privacyContract } from './privacy.js';
import { keepContract } from './keep.js';
import { removeKeepEntryContract } from './keep-remove.js';
import { sharingContract } from './sharing.js';
import { readSceneManifestContract, readSceneChunkContract } from './scenes.js';
import { readGeographyContract, readUniverseDeltasContract } from './geography.js';
import { mediaGrantContract } from './media.js';
import { cancelContentRequestContract, createContentRequestContract, readContentRequestContract } from './supply.js';
import { exposureContextContract, navigateExperienceContract } from './navigation.js';
import { previewRegionEncounterContract, openRegionEncounterContract } from './region-encounter.js';
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

/** The HTTP declarations of the KnowScroll API, including explicitly documented future consumers.
 * A declaration alone does not mount a controller or establish implemented behavior. */
export const apiContract = {
  health: healthContract,
  privacy: privacyContract,
  keep: { ...keepContract, remove: removeKeepEntryContract },
  sharing: sharingContract,
  scenes: { manifest: readSceneManifestContract, chunk: readSceneChunkContract },
  formation: formationPresentationContract,
  geography: { read: readGeographyContract, deltas: readUniverseDeltasContract },
  media: { grant: mediaGrantContract },
  supply: {
    create: createContentRequestContract,
    read: readContentRequestContract,
    cancel: cancelContentRequestContract,
  },
  identity: {
    requestSignIn: requestSignInContract,
    peekSignIn: peekSignInContract,
    redeemSignIn: redeemSignInContract,
    session: sessionContract,
    signOut: signOutContract,
  },
  experience: {
    previewRegionEncounter: previewRegionEncounterContract,
    openRegionEncounter: openRegionEncounterContract,
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
