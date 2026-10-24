import type { z } from 'zod';

type WireFile = 'responses' | 'record' | 'ready';
const cache = new Map<string, Promise<z.ZodType>>();

/**
 * One schema of Cutroom's pinned wire contract (CF-61). The vendored files are TypeScript with
 * `.ts` imports, so a source run loads them as they are and a built release loads the same files
 * compiled by `scripts/build-cutroom-wire.mjs`. Only the vendored schemas parse Cutroom's replies.
 */
export function wireSchema(file: WireFile, name: string): Promise<z.ZodType> {
  const key = `${file}/${name}`;
  let loaded = cache.get(key);
  if (loaded === undefined) {
    const source = import.meta.url.endsWith('.ts');
    const location = new URL(
      source ? `../cutroom/wire-v1/${file}.ts` : `../cutroom/wire-runtime/${file}.js`,
      import.meta.url,
    ).href;
    loaded = import(location).then((module: Record<string, z.ZodType>) => {
      const schema = module[name];
      if (schema === undefined) throw new Error(`CUTROOM_WIRE_SCHEMA_MISSING:${name}`);
      return schema;
    });
    cache.set(key, loaded);
  }
  return loaded;
}
