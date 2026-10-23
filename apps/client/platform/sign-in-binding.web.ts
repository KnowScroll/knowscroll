import type { SignInBinding } from '@knowscroll/client-core';

/**
 * Web: no device binding. A web link is redeemed only after the person confirmed whose account it
 * opens ("Continue as m•••@example.com", review m8), and only from this origin.
 */
export const signInBinding: SignInBinding | undefined = undefined;
