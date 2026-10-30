import type { Provider } from '@nestjs/common';
import { PLAY_USE_CASES } from '@knowscroll/backend/modules/play';
import { playProviders } from '@knowscroll/backend/modules/play/nest-providers';
import { WITH_PERSONAL_SCOPE } from '../tokens.js';

/**
 * Play for the API composition root. The use cases read Scroll calls and exposures through content's
 * and experience's ports and gate on identity's recording fence, which the content, experience and
 * recording wiring already bind.
 */
export const playWiring: Provider[] = playProviders({ withPersonalScope: WITH_PERSONAL_SCOPE });

export { PLAY_USE_CASES };
