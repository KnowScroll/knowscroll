/// <reference types="node" />
// The test reads the route files from disk; Node types are scoped to this file, not the app.
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * The route map (README "Routes") as the file tree defines it. `/s/<token>` is reserved for share
 * links: on the web the edge sends `/s/*` to the API's public page (D-008), and the client's
 * `/s/[token]` screen arrives with sharing (H01–H02). Until then no client route may claim `/s`,
 * not even through a catch-all that would swallow it.
 */
const appDirectory = join(__dirname, '..', '..', 'app');

function routeFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });
}

/** URL segments of a route file: groups `(tabs)` vanish, `index` and `_layout` add none. */
function segments(file: string): string[] {
  return relative(appDirectory, file)
    .replace(/\.tsx?$/, '')
    .split(sep)
    .filter((segment) => !/^\(.*\)$/.test(segment) && segment !== 'index' && segment !== '_layout');
}

describe('route map', () => {
  const routes = routeFiles(appDirectory).map(segments);

  it('has the documented addresses', () => {
    const paths = routes.map((parts) => `/${parts.join('/')}`).sort();
    expect(paths).toEqual(
      [
        '/',
        '/',
        '/',
        '/',
        '/+not-found',
        '/account',
        '/account',
        '/account/privacy',
        '/account/privacy/clear',
        '/account/privacy/delete',
        '/account/privacy/export',
        '/account/requests',
        '/account/shared-links',
        '/conversations',
        '/conversations/[conversationId]',
        '/explore',
        '/friends',
        '/friends/invite',
        '/gallery',
        '/gallery-scroll',
        '/recover',
        '/redeem',
        '/reel/[assetId]',
        '/saved',
        '/scroll/[assetId]',
        '/signin',
        '/signin/link',
        '/universe',
        '/welcome',
      ].sort(),
    );
  });

  it('leaves /s to share links: no route, group or catch-all claims it', () => {
    for (const parts of routes) {
      const first = parts[0];
      expect(first).not.toBe('s');
      // A dynamic first segment ([id], [...rest]) would also match /s/<token>.
      expect(first?.startsWith('[') ?? false).toBe(false);
    }
  });
});
