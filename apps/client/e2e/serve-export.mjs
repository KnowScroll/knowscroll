// Serves an Expo `web.output: "single"` export the way the edge does (D-008): files as they are,
// every other path falls back to index.html. `/health` answers 502, as with no API behind it.
// Every answer carries the headers Caddy gives the v2 web app (S1.3 review m7), the
// Content-Security-Policy read from the very file the Caddy role deploys, so the smoke proves
// the export runs under the policy that ships.
// Usage: node serve-export.mjs <export directory> <port>
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'dist');
const port = Number(process.argv[3] ?? 4310);
const policy = readFileSync(
  new URL('../../../ops/vps/ansible/roles/caddy/files/app-content-security-policy.txt', import.meta.url),
  'utf8',
)
  .trim()
  .replace('{socket_origin}', `ws://127.0.0.1:${port}`);
const edgeHeaders = {
  'content-security-policy': policy,
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
};
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.css': 'text/css',
};

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

createServer((request, response) => {
  const pathname = normalize(decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname));
  if (pathname === '/health') {
    response.writeHead(502, { ...edgeHeaders, 'content-type': 'text/plain' });
    response.end('no API behind this server');
    return;
  }
  const candidate = join(root, pathname);
  const file = candidate.startsWith(root) && isFile(candidate) ? candidate : join(root, 'index.html');
  response.writeHead(200, { ...edgeHeaders, 'content-type': types[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(response);
}).listen(port, '127.0.0.1', () => {
  console.log(`serving ${root} on http://127.0.0.1:${port}`);
});
