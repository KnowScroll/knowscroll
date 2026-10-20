import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';

it('cold-imports every Scroll entry and parses without even probing dynamic code generation', async () => {
  // This file deliberately has no static Scroll/Zod import. Reset the module graph so this
  // catches schema-construction probes as well as compilation during the first parse.
  vi.resetModules();
  const { z } = await import('zod');
  const previous = z.config().jitless;
  z.config({ jitless: false });
  let attempts = 0;
  const refused = () => {
    attempts += 1;
    throw new EvalError('strict CSP refuses dynamic code generation');
  };
  vi.stubGlobal('Function', new Proxy(Function, { apply: refused, construct: refused }));
  try {
    const publicEntry = await import('./index.js');
    const admission = await import('./admission/index.js');
    const producer = await import('./producer/index.js');
    await import('./internal/index.js');
    expect(z.config().jitless).toBe(true);
    for (const name of ['weight-other-worlds', 'attention-slowly', 'spring-neap-tides']) {
      const read = (path: string): unknown => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
      const document = read(`../fixtures/documents/${name}.json`);
      const parsed = publicEntry.parseDocument(document, { verify: true });
      expect(parsed.kind).toBe('valid');
      if (parsed.kind !== 'valid') throw new Error('fixture refused');
      for (const { block } of publicEntry.walkBlocks(parsed.document.sections)) {
        expect(publicEntry.parseBlock(block).kind).toBe('block');
        expect(publicEntry.readEnvelope(block).id).toBe(block.id);
      }
      expect(publicEntry.negotiate(parsed.document, publicEntry.FULL_V1_CAPABILITIES).kind).toBe('negotiated');
      expect(admission.admitDocument(document).kind).toBe('valid');
      expect(
        producer.compileDraft(
          read(`../fixtures/producer/${name}.draft.json`),
          producer.DraftProvenance.parse(read(`../fixtures/producer/${name}.provenance.json`)),
        ).kind,
      ).toBe('compiled');
    }
    // Catching the exception in Zod is insufficient: a blocked probe itself violates CSP.
    expect(attempts).toBe(0);
  } finally {
    vi.unstubAllGlobals();
    z.config({ jitless: previous });
  }
});
