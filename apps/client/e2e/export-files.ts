import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Whether a built web export (`dist`, `dist-gallery`) contains a string in any of its JavaScript files: how a spec checks
 * that developer pages are dropped from production builds, as the `client` job's greps do for the other galleries.
 */
export function exportCarries(folder: string, text: string): boolean {
  for (const entry of readdirSync(folder)) {
    const path = join(folder, entry);
    if (statSync(path).isDirectory()) {
      if (exportCarries(path, text)) return true;
    } else if (entry.endsWith('.js') && readFileSync(path, 'utf8').includes(text)) {
      return true;
    }
  }
  return false;
}
