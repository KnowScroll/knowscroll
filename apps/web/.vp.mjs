import { chromium } from '@playwright/test';
const b = await chromium.launch();
for (const [w, h] of [[1440, 900], [1024, 768]]) {
  const page = await b.newPage({ viewport: { width: w, height: h } });
  await page.goto('http://127.0.0.1:4393/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: /Privacy/i }).first().click();
  await page.waitForTimeout(500);
  const covered = await page.evaluate(() => {
    const hit = (a, b) => !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
    const dock = document.querySelector('.universe-dock'); const stage = document.querySelector('.privacy-stage');
    if (!dock || !stage) return ['missing'];
    const d = dock.getBoundingClientRect(), s = stage.getBoundingClientRect();
    const vis = r => { const top = Math.max(r.top, s.top), bottom = Math.min(r.bottom, s.bottom),
      left = Math.max(r.left, s.left), right = Math.min(r.right, s.right);
      return (bottom <= top || right <= left) ? null : new DOMRect(left, top, right - left, bottom - top); };
    return [...document.querySelectorAll('.privacy-section')].flatMap(sec => {
      const v = vis(sec.getBoundingClientRect());
      return v && hit(v, d) ? [(sec.textContent || '').trim().slice(0, 32)] : [];
    });
  });
  console.log(`  [${w}x${h}] painted sections under the dock:`, covered.length ? covered : 'none');
  await page.close();
}
await b.close();
