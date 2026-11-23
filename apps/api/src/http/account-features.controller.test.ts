import 'reflect-metadata';
import { call } from '@orpc/server';
import { describe, expect, it } from 'vitest';
import { AccountFeaturesSchema } from '@knowscroll/contracts';
import type { ApiConfig } from '@knowscroll/backend/infrastructure/config';
import { AccountController } from './account.controller.js';

/** The features route reads only the process's configuration: every other dependency is out of reach. */
const controllerWith = (madeToOrderEnabled: boolean) =>
  new AccountController(
    { madeToOrderEnabled } as ApiConfig,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
  );

describe('GET /v1/account/features (D-436)', () => {
  it('says the made-to-order Scrolls are off when the process has the switch off', async () => {
    const answer = await call(controllerWith(false).featuresRoute(), undefined);
    expect(AccountFeaturesSchema.parse(answer)).toEqual({ version: 'account-features.v1', madeToOrder: false });
  });

  it('says they are on only when the process has the switch on', async () => {
    const answer = await call(controllerWith(true).featuresRoute(), undefined);
    expect(answer).toEqual({ version: 'account-features.v1', madeToOrder: true });
  });
});
