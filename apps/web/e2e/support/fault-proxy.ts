/**
 * A real, in-process HTTP fault-injection proxy for journey evidence, not a
 * mock of the API. It transparently forwards every request to the real
 * disposable API using `fetch` (Node's built-in undici client, which handles
 * HTTP/1.1 framing correctly rather than a hand-rolled stream pass-through).
 * Three test-only controls let a spec provoke a genuine failure mode against
 * the real backend rather than faking one client-side:
 *
 * - arm-drop: the *next* matching request reaches the real upstream and is
 *   fully processed there (the server-side record genuinely exists), then
 *   the client connection is destroyed instead of relaying the response --
 *   "processed but the reply was lost", proving idempotent retry.
 * - outage: while enabled, every request's connection is destroyed
 *   immediately (nothing reaches the real API) -- a real transport failure
 *   for the "API unavailable, retry" journey.
 * - arm-invalidate-auth: the *next* matching request is forwarded with a
 *   corrupted Authorization header, so the real API's own auth code
 *   genuinely returns 401 (not a fabricated client-side 401).
 *
 * This sits between the Vite dev-auth proxy and the real API
 * (KS_WEB_API_URL points at this proxy's port).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface FaultProxy {
  readonly port: number;
  armDrop(method: string, path: string): void;
  armInvalidateAuth(method: string, path: string): void;
  setOutage(enabled: boolean): void;
  close(): Promise<void>;
}

type ArmedMatch = { method: string; path: string };

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'content-length', 'host']);

export async function startFaultProxy(targetOrigin: string): Promise<FaultProxy> {
  let armedDrop: ArmedMatch | null = null;
  let armedInvalidateAuth: ArmedMatch | null = null;
  let outage = false;

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(error => {
      if (!res.headersSent) res.writeHead(502);
      res.end(`fault-proxy error: ${String(error)}`);
    });
  });

  function matches(match: ArmedMatch | null, req: IncomingMessage, pathname: string): boolean {
    return match !== null && req.method === match.method && pathname === match.path;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', targetOrigin);

    if (req.method === 'POST' && url.pathname === '/__control__/arm-drop') {
      const parsed = await readJson(req);
      armedDrop = { method: (parsed.method ?? 'POST').toUpperCase(), path: parsed.path ?? '/v1/interactions' };
      res.writeHead(204).end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/__control__/arm-invalidate-auth') {
      const parsed = await readJson(req);
      armedInvalidateAuth = { method: (parsed.method ?? 'GET').toUpperCase(), path: parsed.path ?? '/v1/universe' };
      res.writeHead(204).end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/__control__/outage') {
      const parsed = await readJson(req);
      outage = Boolean(parsed.enabled);
      res.writeHead(204).end();
      return;
    }

    if (outage) {
      req.socket.destroy();
      return;
    }

    const shouldDrop = matches(armedDrop, req, url.pathname);
    if (shouldDrop) armedDrop = null;
    const shouldInvalidateAuth = matches(armedInvalidateAuth, req, url.pathname);
    if (shouldInvalidateAuth) armedInvalidateAuth = null;

    const body = await readBody(req);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
      headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    if (shouldInvalidateAuth) headers.set('authorization', 'Bearer invalidated-for-test');

    const upstreamResponse = await fetch(new URL(url.pathname + url.search, targetOrigin), {
      method: req.method,
      headers,
      body: body.length ? new Uint8Array(body) : undefined,
    });

    if (shouldDrop) {
      // The real API already fully processed the request; consume its body
      // (so the upstream connection closes cleanly) but never relay it.
      await upstreamResponse.arrayBuffer().catch(() => undefined);
      req.socket.destroy();
      return;
    }

    const responseHeaders: Record<string, string> = {};
    upstreamResponse.headers.forEach((value, name) => {
      if (!HOP_BY_HOP.has(name.toLowerCase())) responseHeaders[name] = value;
    });
    const buffer = Buffer.from(await upstreamResponse.arrayBuffer());
    res.writeHead(upstreamResponse.status, responseHeaders);
    res.end(buffer);
  }

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fault-proxy did not bind a TCP port');

  return {
    port: address.port,
    armDrop(method, path) {
      armedDrop = { method: method.toUpperCase(), path };
    },
    armInvalidateAuth(method, path) {
      armedInvalidateAuth = { method: method.toUpperCase(), path };
    },
    setOutage(enabled) {
      outage = enabled;
    },
    close() {
      return new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    },
  };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req: IncomingMessage): Promise<{ method?: string; path?: string; enabled?: boolean }> {
  const body = await readBody(req);
  return body.length ? JSON.parse(body.toString('utf8')) : {};
}
