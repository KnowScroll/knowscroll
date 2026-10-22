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

/** Read once on web mount and erase even an invalid fragment without putting it in router state. */
export function takeBrowserFriendToken(): string | undefined {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return undefined;
  const token = friendTokenFromLink(window.location.hash);
  if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
  return token;
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
