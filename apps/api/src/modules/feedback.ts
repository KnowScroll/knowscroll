import type { Provider } from '@nestjs/common';
import { REPORT_USE_CASES } from '@knowscroll/backend/modules/feedback';
import { feedbackProviders } from '@knowscroll/backend/modules/feedback/nest-providers';
import { WITH_PERSONAL_SCOPE } from '../tokens.js';

/**
 * Reports for the API composition root. The report use cases read assets, social messages, room
 * messages and people through the neighbouring modules' ports, which the content, social and rooms
 * wiring already bind.
 */
export const feedbackWiring: Provider[] = feedbackProviders({ withPersonalScope: WITH_PERSONAL_SCOPE });

export { REPORT_USE_CASES };
