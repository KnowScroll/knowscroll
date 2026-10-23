import { fc, test } from '@fast-check/vitest';
import { describe, expect } from 'vitest';
import { z } from 'zod';
import { uuidv7 } from './uuid-v7.js';

describe('uuidv7', () => {
  test.prop([fc.integer({ min: 0, max: 2 ** 48 - 1 })])(
    'is a valid RFC 9562 version 7 UUID carrying its millisecond timestamp',
    (millis) => {
      const id = uuidv7(millis);
      expect(z.uuid({ version: 'v7' }).safeParse(id).success).toBe(true);
      expect(Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16)).toBe(millis);
    },
  );
});
