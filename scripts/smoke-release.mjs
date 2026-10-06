#!/usr/bin/env node
// Proves a release tarball runs as the server runs it (#201): unpacked into an empty folder with
// no node_modules, migrated and seeded into a fresh database, then the API started in server mode
// (NODE_ENV=production). /health must report the world and the release's commit, and a request
// without a session must be refused. The database is created and dropped here.
//
//   DATABASE_URL=<admin url to any database> node scripts/smoke-release.mjs <release.tar>

import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tarball = process.argv[2];
const admin = process.env.DATABASE_URL;
if (!tarball || !admin) {
  console.error(
    'usage: DATABASE_URL=<admin url> node scripts/smoke-release.mjs <release.tar>',
  );
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), 'ks-release-smoke-'));
const database = `knowscroll_test_release_smoke_${randomBytes(4).toString('hex')}`;
const url = new URL(admin);
const psql = (sql) =>
  execFileSync('psql', [admin, '-v', 'ON_ERROR_STOP=1', '-qc', sql], {
    stdio: 'pipe',
  });
url.pathname = `/${database}`;
const port = 4390 + Math.floor(Math.random() * 9);
let api;

function check(condition, message) {
  if (!condition) throw new Error(`release smoke: ${message}`);
  console.log(`ok - ${message}`);
}

try {
  execFileSync('tar', ['-C', dir, '-xf', tarball]);
  const manifest = JSON.parse(readFileSync(join(dir, 'release.json'), 'utf8'));
  check(
    !execFileSync('find', [dir, '-name', 'node_modules'], {
      encoding: 'utf8',
    }).trim(),
    'the release carries no node_modules',
  );

  psql(`CREATE DATABASE ${database}`);
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DATABASE_URL: url.toString(),
  };
  for (const program of ['migrate', 'seed'])
    execFileSync('node', ['--enable-source-maps', `dist/${program}.mjs`], {
      cwd: dir,
      env,
      stdio: 'pipe',
    });
  check(true, 'bundled migrate and seed ran against a fresh database');

  api = spawn('node', ['--enable-source-maps', 'dist/api.mjs'], {
    cwd: dir,
    env: {
      ...env,
      NODE_ENV: 'production',
      PORT: String(port),
      KS_WORLD: 'dev',
      KS_COMMIT: manifest.commit,
      KS_CSRF_SECRET: randomBytes(32).toString('hex'),
      KS_WEB_ORIGIN: 'https://app.dev.knowscroll.space',
      KS_MAIL_SENDER: 'agentmail',
      AGENTMAIL_API_KEY: 'release-smoke-never-sends',
      AGENTMAIL_INBOX_ID: 'release-smoke@example.invalid',
      KS_OWNER_EMAIL: 'owner@example.invalid',
      KS_MEDIA_ROOT: join(dir, 'media'),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const base = `http://127.0.0.1:${port}`;
  let health;
  for (let attempt = 0; attempt < 100 && !health; attempt++) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) health = await response.json();
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  check(
    health?.status === 'ok' && health.database === true,
    'the bundled API answers /health in server mode',
  );
  check(
    health.world === 'dev' && health.commit === manifest.commit,
    '/health names the world and the release commit',
  );
  const anonymous = await fetch(`${base}/v1/universe`);
  check(anonymous.status === 401, 'a request without a session is refused');
} finally {
  api?.kill('SIGTERM');
  if (api) await new Promise((r) => api.once('exit', r));
  try {
    psql(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
