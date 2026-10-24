import { AccountController } from './http/account.controller.js';
import { OperatorController } from './http/operator.controller.js';
import { ExportDownloadController } from './http/export-download.controller.js';
import { SocialController } from './http/social.controller.js';
import { VisibilityController } from './http/visibility.controller.js';
import { ConversationsController } from './http/conversations.controller.js';
import { ThreadsController } from './http/threads.controller.js';
import { RoomsController } from './http/rooms.controller.js';
import { ShareLandingController } from './http/share-landing.controller.js';
import { RecordingController } from './http/recording.controller.js';
import { FormationController } from './http/formation.controller.js';
import { KeepRemoveController } from './http/keep-remove.controller.js';
import { RegionEncounterController } from './http/region-encounter.controller.js';
import { KeepController } from './http/keep.controller.js';
import { PrivacyController } from './http/privacy.controller.js';
import { ScenesController } from './http/scenes.controller.js';
import { SupplyController } from './http/supply.controller.js';
import { GeographyController } from './http/geography.controller.js';
import { MediaController } from './http/media.controller.js';
import { AuthController } from './http/auth.controller.js';
import { ExperienceController } from './http/experience.controller.js';
import { HealthController } from './http/health.controller.js';
import { ObservationsController } from './http/observations.controller.js';

/**
 * Explicit route index: every controller the API serves. Each controller implements routes of
 * `apiContract` from `@knowscroll/contracts`; nothing is discovered by scanning.
 */
export const apiControllers = [
  HealthController,
  AuthController,
  AccountController,
  OperatorController,
  ExportDownloadController,
  ExperienceController,
  ObservationsController,
  RecordingController,
  MediaController,
  SupplyController,
  GeographyController,
  ScenesController,
  KeepController,
  KeepRemoveController,
  PrivacyController,
  SocialController,
  VisibilityController,
  ConversationsController,
  ThreadsController,
  RoomsController,
  ShareLandingController,
  RegionEncounterController,
  FormationController,
];
