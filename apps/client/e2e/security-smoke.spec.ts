import { expect, test } from '@playwright/test';

/**
 * The production export under the headers the edge sends it (S1.3 review m7): `serve-export.mjs`
 * serves the Content-Security-Policy from the Caddy role's own policy file. Every page must run
 * under it without a single violation (no inline script, no eval, nothing from elsewhere), and no
 * page may be framed.
 */
const fixtureToken = `ksl_${'A'.repeat(43)}`;

test('every page runs under the Content-Security-Policy with no violation, and refuses to be framed', async ({
  page,
}) => {
  const violations: string[] = [];
  await page.exposeFunction('reportPolicyViolation', (violation: string) => violations.push(violation));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      const report = (window as unknown as { reportPolicyViolation: (violation: string) => void })
        .reportPolicyViolation;
      report(`${event.effectiveDirective} ${event.blockedURI} ${event.sourceFile}:${String(event.lineNumber)}`);
    });
  });
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy/i.test(message.text()))
      consoleErrors.push(message.text());
  });
  await page.route('**/auth/peek', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ email: 'mary@example.test' }),
    }),
  );

  const response = await page.goto('/welcome');
  const headers = response?.headers() ?? {};
  // Parsed, so a source added to a directive cannot hide behind a substring match.
  const policy = new Map(
    (headers['content-security-policy'] ?? '')
      .split(';')
      .map((directive) => directive.trim().split(/\s+/))
      .filter((parts) => parts[0] !== undefined && parts[0] !== '')
      .map(([name = '', ...sources]) => [name, sources.sort()] as const),
  );
  expect(policy.get('default-src')).toEqual(["'self'"]);
  // Scripts only from this origin: no inline script, no eval.
  expect(policy.get('script-src')).toEqual(["'self'"]);
  // React Native Web and expo-font write their styles into <style> elements at run time.
  expect(policy.get('style-src')).toEqual(["'self'", "'unsafe-inline'"].sort());
  expect(policy.get('frame-ancestors')).toEqual(["'none'"]);
  expect(policy.get('object-src')).toEqual(["'none'"]);
  expect(policy.get('base-uri')).toEqual(["'none'"]);
  for (const [name, sources] of policy) expect(sources, name).not.toContain("'unsafe-eval'");
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  await expect(page.getByRole('heading', { name: 'KnowScroll', level: 1 })).toBeVisible();

  for (const path of ['/explore', '/universe', '/conversations', '/saved', '/account', '/signin', '/recover']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
  }
  await page.goto(`/redeem#token=${fixtureToken}`);
  await expect(page.getByRole('button', { name: 'Continue as mary@example.test' })).toBeVisible();
  await page.waitForLoadState('networkidle');

  expect(violations).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
