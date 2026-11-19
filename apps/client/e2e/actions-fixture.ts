import type { Page } from '@playwright/test';

/**
 * Answers `/v1/actions` the way the server does for the Scroll that is open: the target echoed back, `saved` or `liked`
 * as the command says (labelled fixture, no backend). Like and Save each take effect once the answer arrives, so a
 * button shows its pressed state. Returns the commands sent, in order. Register it after `encounterFixture`: the later
 * route answers first.
 */
export async function answerActions(page: Page): Promise<{ kind: string }[]> {
  const sent: { kind: string }[] = [];
  await page.route('**/v1/actions', async (route) => {
    const body = route.request().postDataJSON() as {
      commandId: string;
      kind: 'save' | 'like' | 'unlike' | 'hide';
      target: { assetId: string; assetRevision: number };
    };
    sent.push({ kind: body.kind });
    const common = {
      commandId: body.commandId,
      actionId: '00000000-0000-4000-8000-000000000a01',
      kind: body.kind,
      assetId: body.target.assetId,
      assetRevision: body.target.assetRevision,
      changed: true,
      revision: sent.length,
      replayed: false,
    };
    await route.fulfill({
      json:
        body.kind === 'save'
          ? { ...common, saved: true }
          : { ...common, liked: body.kind === 'like', hidden: body.kind === 'hide' },
    });
  });
  return sent;
}
