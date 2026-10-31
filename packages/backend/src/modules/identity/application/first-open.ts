import type { ClaimFirstOpen } from '../public.js';
import type { FirstOpenPorts } from './ports.js';

/**
 * `claimFirstOpen`: the Universe tab's first-open animation belongs to the account, not to a device
 * (D-114). The first caller to ask wins and starts the animation; every later request, from any device or
 * after a reinstall, is told it was already claimed. The flag is set when the animation starts, so a crash
 * or a closed app never plays it again, and Skip changes nothing. Retrying after an unknown outcome is
 * safe: at worst the opening is not shown, never shown twice.
 */
export function makeClaimFirstOpen(ports: FirstOpenPorts): ClaimFirstOpen {
  return async function claimFirstOpen(caller) {
    return { claimed: await ports.claim(caller.accountId) };
  };
}
