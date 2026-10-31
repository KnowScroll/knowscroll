import { expect, type Locator } from '@playwright/test';

/**
 * Taps a tap target that follows an orbiting planet in the Universe's 3D system view.
 *
 * The target is placed at the planet's projected point every frame, so it glides a few pixels a
 * second by design. Playwright's `click()` waits until the target's box is the same on two
 * consecutive animation frames; on a loaded runner the frames are as slow as the glide, no two
 * frames agree, and the click times out ("element is not stable"). A finger does not wait for that:
 * it lands inside a target of at least 48 px. This waits until the target is visible, then presses
 * the centre of its current box with a real pointer click. The click still lands on whatever is on
 * top at that point, so a covered target is still caught (the caller then expects the opened view).
 */
export async function tapOrbitingTarget(target: Locator): Promise<void> {
  await expect(target).toBeVisible();
  const box = await target.boundingBox();
  if (box === null) throw new Error('The orbiting target has no box to tap');
  await target.page().mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
