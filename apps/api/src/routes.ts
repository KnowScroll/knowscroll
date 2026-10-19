import { AuthController } from './http/auth.controller.js';
import { ExperienceController } from './http/experience.controller.js';
import { HealthController } from './http/health.controller.js';

/**
 * Explicit route index: every controller the API serves. Each controller implements routes of
 * `apiContract` from `@knowscroll/contracts`; nothing is discovered by scanning.
 */
export const apiControllers = [HealthController, AuthController, ExperienceController];
