// Serves an Expo `web.output: "single"` export the way the edge does (D-008): files as they are,
// every other path falls back to index.html. `/health` answers 502, as with no API behind it.
// Usage: node serve-export.mjs <export directory> <port>
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'dist');
const port = Number(process.argv[3] ?? 4310);
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
    response.writeHead(502, { 'content-type': 'text/plain' });
    response.end('no API behind this server');
    return;
  }
  const candidate = join(root, pathname);
  const file = candidate.startsWith(root) && isFile(candidate) ? candidate : join(root, 'index.html');
  response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(response);
}).listen(port, '127.0.0.1', () => {
  console.log(`serving ${root} on http://127.0.0.1:${port}`);
});
