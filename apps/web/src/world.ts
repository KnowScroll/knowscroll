/**
 * Which world this bundle is being served as (#201). The same built bundle is promoted from dev to
 * stage to live, so the world is read from the address at runtime, never baked in at build time.
 * Only the exact app hosts count; anything else (loopback dev servers, previews) is local.
 */
export type WebWorld = 'live' | 'stage' | 'dev' | 'local';

const APP_HOSTS: Readonly<Record<string, WebWorld>> = {
  'app.knowscroll.space': 'live',
  'app.stage.knowscroll.space': 'stage',
  'app.dev.knowscroll.space': 'dev',
};

export function worldFromHostname(hostname: string): WebWorld {
  return APP_HOSTS[hostname.toLowerCase()] ?? 'local';
}

export function currentWorld(): WebWorld {
  return typeof window === 'undefined' ? 'local' : worldFromHostname(window.location.hostname);
}
