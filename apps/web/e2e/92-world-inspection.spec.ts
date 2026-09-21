import { expect, test } from './support/fixtures.ts';

for (const size of [{width:1440,height:900},{width:390,height:844},{width:700,height:560}]) {
  test(`world approach, return and Keep at ${size.width}x${size.height}`, async ({page}) => {
    await page.setViewportSize(size);
    await page.goto('/');
    await page.getByRole('button',{name:'Open the system view'}).click();
    const world = page.getByRole('button',{name:/Explore world:/}).first();
    await expect(world).toBeVisible();
    const label = await world.getAttribute('aria-label');
    await world.click();
    await expect(page.getByRole('main',{name:'World',exact:true})).toBeVisible();
    await expect(page.getByRole('heading',{level:1})).toBeFocused();
    await expect(page.getByRole('link',{name:/Open source:/})).toHaveAttribute('target','_blank');
    await page.getByRole('link',{name:/Open source:/}).scrollIntoViewIfNeeded();
    const sourceBounds = await page.getByRole('link',{name:/Open source:/}).boundingBox();
    const dockBounds = await page.getByRole('navigation',{name:'Main navigation'}).boundingBox();
    expect(sourceBounds!.y + sourceBounds!.height).toBeLessThanOrEqual(dockBounds!.y);
    await expect(page.getByText(/Encounters record what was shown/)).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect.poll(() => page.locator('main').evaluate(node => getComputedStyle(node).opacity)).toBe('1');
    await expect.poll(() => page.locator('.world-detail').evaluate(node => getComputedStyle(node).opacity)).toBe('1');
    await page.screenshot({path:`artifacts/ui-audit/world-${size.width}x${size.height}.png`,fullPage:true});
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button',{name:label!,exact:true})).toBeFocused();
    await page.getByRole('button',{name:'Keep — your saved Traces'}).click();
    await expect(page.getByRole('main',{name:'Keep',exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'Keep — your saved Traces'})).toHaveAttribute('aria-current','page');
    await page.getByRole('button',{name:/Revisit the saved Trace/}).first().click();
    await expect(page.getByRole('article')).toBeVisible();
    await page.getByRole('button',{name:'Keep — your saved Traces'}).click();
    await expect(page.getByRole('main',{name:'Keep',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Atlas — your universe'}).click();
    await expect(page.getByRole('main',{name:'Universe',exact:true})).toBeVisible();
    await expect.poll(() => page.locator('main').evaluate(node => getComputedStyle(node).opacity)).toBe('1');
    await page.screenshot({path:`artifacts/ui-audit/atlas-${size.width}x${size.height}.png`,fullPage:true});
    const clipped = await page.locator('.body-button').evaluateAll(nodes=>nodes.filter(node=>{const r=node.getBoundingClientRect();return r.x<0||r.right>innerWidth;}).map(node=>node.textContent));
    expect(clipped).toEqual([]);
  });
}

test('world inspection honours reduced motion',async({page})=>{
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto('/');
  await page.getByRole('button',{name:'Open the system view'}).click();
  await page.getByRole('button',{name:/Explore world:/}).first().click();
  expect(await page.locator('.world-detail').evaluate(node=>getComputedStyle(node).animationName)).toBe('none');
});
