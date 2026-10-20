import type { SessionTokenStore } from '@knowscroll/client-core';

/** Web: no token store. The session is the HttpOnly cookie, which scripts can neither read nor keep. */
export const sessionTokens: SessionTokenStore | undefined = undefined;
