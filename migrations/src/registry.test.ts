import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { migrationDirectory, migrationRegistry } from './index.js';

describe('the static migration registry', () => {
  const files = readdirSync(fileURLToPath(migrationDirectory))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  it('lists exactly the SQL files in migrations/, in ascending order', () => {
    expect(migrationRegistry.map((entry) => `${entry.name}.sql`)).toEqual(files);
  });

  it('names every migration NNNN_purpose', () => {
    for (const entry of migrationRegistry) expect(entry.name).toMatch(/^\d{4}_[a-z0-9_]+$/);
  });

  it('records the SHA-256 of each reviewed file', () => {
    for (const entry of migrationRegistry) {
      const text = readFileSync(new URL(`${entry.name}.sql`, migrationDirectory));
      expect({ name: entry.name, sha256: createHash('sha256').update(text).digest('hex') }).toEqual({
        name: entry.name,
        sha256: entry.sha256,
      });
    }
  });
});
