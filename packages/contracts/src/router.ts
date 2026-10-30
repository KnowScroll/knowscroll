import { accountContract } from './account.js';
import { feedbackContract } from './feedback.js';
import { operatorContract } from './operator.js';
import { publicContentSharesContract } from './public-content-shares.js';
import { conversationsContract } from './conversations.js';
import { threadsContract } from './threads.js';
import { roomsContract } from './rooms.js';
import { scenariosContract } from './scenarios.js';
import { contentSharesContract } from './content-shares.js';
import { friendPagesContract } from './friend-pages.js';
import { formationPresentationContract } from './formation-presentation.js';
import { playContract } from './play.js';
import { privacyContract } from './privacy.js';
import { recordingContract } from './recording.js';
import { keepContract } from './keep.js';
import { removeKeepEntryContract } from './keep-remove.js';
import { sharingContract } from './sharing.js';
import { readSceneManifestContract, readSceneChunkContract } from './scenes.js';
import { readEmergingUniverseContract, readGeographyContract, readUniverseDeltasContract } from './geography.js';
import { mediaGrantContract } from './media.js';
import {
  cancelContentRequestContract,
  retryContentRequestContract,
  createContentRequestContract,
  listContentRequestsContract,
  readContentRequestContract,
} from './supply.js';
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
import { submitRecordingObservationsContract } from './interactions.js';

/** The HTTP declarations of the KnowScroll API, including explicitly documented future consumers.
 * A declaration alone does not mount a controller or establish implemented behavior. */
// Named procedure references keep declaration emission bounded as the shared protocol grows.
export const apiContract: {
  health: typeof healthContract;
  account: typeof accountContract;
  operator: typeof operatorContract;
  feedback: typeof feedbackContract;
  play: typeof playContract;
  privacy: typeof privacyContract;
  recording: typeof recordingContract;
  keep: typeof keepContract & { remove: typeof removeKeepEntryContract };
  sharing: typeof sharingContract;
  friendPages: typeof friendPagesContract;
  conversations: typeof conversationsContract;
  threads: typeof threadsContract;
  rooms: typeof roomsContract;
  scenarios: typeof scenariosContract;
  contentShares: typeof contentSharesContract;
  publicContentShares: typeof publicContentSharesContract;
  scenes: { manifest: typeof readSceneManifestContract; chunk: typeof readSceneChunkContract };
  formation: typeof formationPresentationContract;
  geography: {
    read: typeof readGeographyContract;
    deltas: typeof readUniverseDeltasContract;
    emerging: typeof readEmergingUniverseContract;
  };
  media: { grant: typeof mediaGrantContract };
  supply: {
    create: typeof createContentRequestContract;
    read: typeof readContentRequestContract;
    list: typeof listContentRequestsContract;
    cancel: typeof cancelContentRequestContract;
    retry: typeof retryContentRequestContract;
  };
  identity: {
    requestSignIn: typeof requestSignInContract;
    peekSignIn: typeof peekSignInContract;
    redeemSignIn: typeof redeemSignInContract;
    session: typeof sessionContract;
    signOut: typeof signOutContract;
  };
  experience: {
    previewRegionEncounter: typeof previewRegionEncounterContract;
    openRegionEncounter: typeof openRegionEncounterContract;
    applyAction: typeof applyActionContract;
    listSaved: typeof listSavedContract;
    openExposure: typeof openExposureContract;
    navigate: typeof navigateExperienceContract;
    activateExposure: typeof activateExposureContract;
    exposureDocument: typeof exposureDocumentContract;
    exposureContext: typeof exposureContextContract;
  };
  observations: {
    submit: typeof submitObservationsContract;
    submitRecording: typeof submitRecordingObservationsContract;
  };
  diagnostics: { evidence: typeof evidenceDiagnosticsContract };
} = {
  health: healthContract,
  account: accountContract,
  operator: operatorContract,
  feedback: feedbackContract,
  play: playContract,
  privacy: privacyContract,
  recording: recordingContract,
  keep: { ...keepContract, remove: removeKeepEntryContract },
  sharing: sharingContract,
  friendPages: friendPagesContract,
  conversations: conversationsContract,
  threads: threadsContract,
  rooms: roomsContract,
  scenarios: scenariosContract,
  contentShares: contentSharesContract,
  publicContentShares: publicContentSharesContract,
  scenes: { manifest: readSceneManifestContract, chunk: readSceneChunkContract },
  formation: formationPresentationContract,
  geography: {
    read: readGeographyContract,
    deltas: readUniverseDeltasContract,
    emerging: readEmergingUniverseContract,
  },
  media: { grant: mediaGrantContract },
  supply: {
    create: createContentRequestContract,
    read: readContentRequestContract,
    list: listContentRequestsContract,
    cancel: cancelContentRequestContract,
    retry: retryContentRequestContract,
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
    submitRecording: submitRecordingObservationsContract,
  },
  diagnostics: {
    evidence: evidenceDiagnosticsContract,
  },
};

export type ApiContract = typeof apiContract;
