import * as Linking from 'expo-linking';
import { Platform } from 'react-native';

const inviteToken = /^ksfi_[A-Za-z0-9_-]{43}$/;
const validToken = (value: string) => value.length === 48 && inviteToken.test(value);

/** Invite capabilities travel only in a fragment, never in a route/query or scoped storage. */
export function friendTokenFromLink(value: string): string | undefined {
  if (validToken(value)) return value;
  const match = /#invite=(ksfi_[A-Za-z0-9_-]{43})$/.exec(value);
  if (!match || !value.endsWith(match[0]) || value.includes('?')) return undefined;
  if (value.startsWith('#')) return match[1];
  try {
    const url = new URL(value);
    if (!['https:', 'http:', 'knowscroll:'].includes(url.protocol) || url.username || url.password) return undefined;
    const path = url.protocol === 'knowscroll:' ? `${url.host}${url.pathname}` : url.pathname;
    return path.replace(/^\//, '') === 'friends/invite' ? match[1] : undefined;
  } catch {
    return undefined;
  }
}

/** Consume the current fragment and erase even invalid input without putting it in router state. */
export function takeBrowserFriendToken(): string | undefined {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return undefined;
  const token = friendTokenFromLink(window.location.hash);
  if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
  return token;
}

// Account-independent process fence only: never store a URL/token/promise or reset on remount.
let nativeLaunchDiscarded = false;
/** The OS may return the original launch URL forever. Consume/discard it once, including signed-out
 * intake. Initial native links require deliberate paste; no asynchronous launch callback can bind
 * that old capability to another account/session/epoch or revive it during StrictMode setup. */
export function discardInitialNativeFriendLink(): void {
  if (Platform.OS === 'web' || nativeLaunchDiscarded) return;
  nativeLaunchDiscarded = true;
  try {
    void Linking.getInitialURL().then(
      () => undefined,
      () => undefined,
    );
  } catch {
    // Claim remains consumed even if this platform cannot read the launch URL.
  }
}

/** The caller owns this ephemeral string only until the deliberate clipboard operation finishes. */
export function friendInviteLink(token: string): string | undefined {
  if (!validToken(token)) return undefined;
  const base =
    Platform.OS === 'web' && typeof window !== 'undefined'
      ? `${window.location.origin}/friends/invite`
      : Linking.createURL('friends/invite', { scheme: 'knowscroll' });
  return `${base.split(/[?#]/, 1)[0]}#invite=${token}`;
}
