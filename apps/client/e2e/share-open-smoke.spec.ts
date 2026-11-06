import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import { id } from './encounter-fixture';
import { talkFixture } from './talk-fixture';

/**
 * The Share sheet on a Scroll's own address (`/scroll/<id>`), in the production export over labelled HTTP fixtures (no
 * backend): "Open thread" and "Open chat" close the sheet and must then reach the thread or the conversation. On the web
 * the sheet's history entry is removed by an asynchronous Back, and a navigation that does not wait for it is popped
 * with it: the address stays on the Scroll (D-238). Only the browser can show that, so this is an e2e.
 */
const phone = { width: 390, height: 844 };
const scope = { accountId: id(1), privacyEpoch: 1 };
const ravi = { kind: 'person' as const, personId: id(11), handle: 'ci.ravi', displayName: 'Ravi fixture' };
const conversation = { conversationId: id(20), membershipId: id(21), membershipRevision: 1 };
const thread = { threadId: id(60), membershipId: id(61), membershipRevision: 1 };
const scrollId = id(301);

async function openScrollWithFriend(page: Page) {
  await page.setViewportSize(phone);
  await page.route('**/auth/session', (route) =>
    route.fulfill({
      json: {
        account: { ...scope, universeId: id(2), email: 'share@fixture.test' },
        client: 'web',
        expiresAt: '2099-10-24T00:00:00.000Z',
      },
    }),
  );
  await page.route('**/v1/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
    const direct = { version: 'direct-conversation.v1', readId: body['readId'], scope };
    const receipt = (version: string) => ({
      version,
      scope,
      commandId: body['commandId'],
      recordedAt: '2026-10-24T08:00:00.000Z',
      replayed: false,
      outcome: 'accepted',
    });
    switch (path) {
      case '/v1/privacy/recording/read':
        return route.fulfill({
          json: { version: 'recording-policy.v1', ...body, scope, revision: 0, policy: { on: true, generation: 1 } },
        });
      case '/v1/experience/open':
        return route.fulfill({
          json: {
            commandId: body['commandId'],
            exposureId: id(401),
            assetId: scrollId,
            assetRevision: 1,
            kind: 'scroll',
            revision: 1,
            replayed: false,
          },
        });
      case '/v1/experience/activate':
        return route.fulfill({
          json: {
            commandId: body['commandId'],
            exposureId: body['exposureId'],
            activatedAt: '2026-10-24T10:00:00.000Z',
            revision: 1,
            replayed: false,
          },
        });
      case '/v1/observations/recording-batch': {
        const events = body['events'] as { eventId: string }[];
        return route.fulfill({
          json: {
            version: 'observation-batch.v2',
            result: 'processed',
            recordingGeneration: body['recordingGeneration'],
            currentGeneration: body['recordingGeneration'],
            scope,
            accepted: events.length,
            duplicates: 0,
            rejected: 0,
            results: events.map((event) => ({ eventId: event.eventId, status: 'accepted' })),
            revision: 1,
          },
        });
      }
      case '/v1/play/results/read':
        return route.fulfill({
          json: { assetId: body['assetId'], revision: body['revision'], calls: [], sparks: 0, combo: 0 },
        });
      // The people the person can share with: Ravi, a friend they already talk to.
      case '/v1/social/conversations/inbox':
        return route.fulfill({
          json: {
            ...direct,
            status: 'ready',
            limit: body['limit'],
            viewRevision: 1,
            items: [
              {
                conversation,
                peer: ravi,
                latestMessageSequence: 1,
                own: { readThroughSequence: 1, muted: false },
                lastMessage: {
                  messageId: id(101),
                  sequence: 1,
                  status: 'available',
                  author: ravi,
                  recordedAt: '2026-10-24T08:00:00.000Z',
                  body: { kind: 'text', text: 'Fixture hello.' },
                },
              },
            ],
            continuation: { kind: 'end' },
          },
        });
      case '/v1/social/friends/page':
        return route.fulfill({
          json: {
            version: 'friend-pages.v2',
            requestId: body['requestId'],
            scope,
            filter: body['filter'],
            snapshotRevision: 1,
            items: [{ state: 'friends', peer: ravi, pairRevision: 1, availability: { state: 'unknown' } }],
          },
        });
      case '/v1/social/conversations/send':
        return route.fulfill({
          json: {
            ...receipt('direct-conversation.v1'),
            operation: 'message.send',
            conversation,
            messageId: id(102),
            messageSequence: 2,
            sent: { kind: 'content', target: { assetId: scrollId, assetRevision: 1 } },
          },
        });
      case '/v1/social/threads/create':
        return route.fulfill({ json: { ...receipt('content-thread.v1'), operation: 'thread.create', thread } });
      // Where "Open" leads: the screens say the conversation or the thread is not there, which is enough to be on them.
      case '/v1/social/conversations/read':
        return route.fulfill({ json: { ...direct, status: 'unavailable' } });
      case '/v1/social/threads/read':
        return route.fulfill({
          json: { version: 'content-thread.v1', readId: body['readId'], scope, status: 'unavailable' },
        });
      default:
        if (path.endsWith('/document'))
          return route.fulfill({
            json: {
              exposureId: path.split('/').at(-2),
              assetId: scrollId,
              assetRevision: 1,
              document: { ...seasons, assetId: scrollId, title: 'CI part 1' },
              degradedEssential: [],
            },
          });
        return route.fulfill({ status: 404, json: {} });
    }
  });
  await page.goto(`/scroll/${scrollId}`);
  await expect(page.getByTestId('stop-scroller')).toBeVisible();
}

async function openShareSheet(page: Page) {
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  // The More sheet has stepped aside: only the Share sheet is open, so a tap lands on it.
  await expect(page.getByRole('dialog', { name: 'More' })).toHaveCount(0);
}

test('Open thread, after Explore with friends on a Scroll’s own address, reaches the thread', async ({ page }) => {
  await openScrollWithFriend(page);
  await openShareSheet(page);
  await page.getByRole('button', { name: 'Explore with friends' }).click();
  await page.getByRole('checkbox', { name: /Ravi fixture/ }).click();
  await page.getByRole('button', { name: /^Create thread/ }).click();
  await page.getByRole('button', { name: 'Open thread' }).click();
  await expect(page).toHaveURL(new RegExp(`/threads/${thread.threadId}`));
  // The thread is the screen shown (the fixture says it is not there), not the Scroll with its sheet left over it.
  await expect(page.getByRole('heading', { name: /This thread isn.t available/ })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('Open chat, after Send to a conversation on a Scroll’s own address, reaches the conversation', async ({
  page,
}) => {
  await openScrollWithFriend(page);
  await openShareSheet(page);
  await page.getByRole('button', { name: 'Send to a conversation' }).click();
  await page.getByRole('radio', { name: /Ravi fixture/ }).click();
  await page.getByRole('button', { name: /^Send to Ravi fixture/ }).click();
  await page.getByRole('button', { name: 'Open chat' }).click();
  await expect(page).toHaveURL(new RegExp(`/conversations/${conversation.conversationId}`));
  await expect(page.getByRole('heading', { name: /isn.t available/ })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

const conversationAddress = `/conversations/${conversation.conversationId}?m=${conversation.membershipId}&r=1`;
const threadAddress = `/threads/${thread.threadId}?m=${thread.membershipId}&r=1`;

/** A created thread over labelled HTTP fixtures; no real invitations, messages or encounters. */
async function conversationWithCreate(page: Page, viewport: { width: number; height: number }) {
  const { calls } = await talkFixture(page, viewport, { sharedCard: true, listThread: true });
  const creates: Record<string, unknown>[] = [];
  await page.route('**/v1/social/threads/create', (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    creates.push(body);
    return route.fulfill({
      json: {
        version: 'content-thread.v1',
        scope,
        commandId: body['commandId'],
        recordedAt: '2026-10-24T08:00:00.000Z',
        replayed: false,
        outcome: 'accepted',
        operation: 'thread.create',
        thread,
      },
    });
  });
  await page.route('**/v1/social/threads/read', (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    calls.push({ path: '/v1/social/threads/read', body });
    return route.fulfill({
      json: {
        version: 'content-thread.v1',
        scope,
        readId: body['readId'],
        status: 'ready',
        thread,
        name: 'CI created thread',
        root: {
          status: 'available',
          target: { assetId: id(320), assetRevision: 1 },
          metadata: {
            kind: 'scroll',
            title: 'CI why the Moon and Sun make tides',
            summary: 'Fixture summary.',
            language: 'en',
          },
        },
        participants: [
          {
            person: { kind: 'person', personId: id(10), handle: 'ci.asha', displayName: 'Asha fixture' },
            role: 'starter',
            joined: true,
            you: true,
          },
          { person: ravi, role: 'member', joined: false, you: false },
        ],
        sequence: { kind: 'single' },
        episodes: [
          {
            assetId: id(320),
            assetRevision: 1,
            kind: 'scroll',
            part: 1,
            title: 'CI why the Moon and Sun make tides',
            state: 'ready',
            visited: false,
          },
        ],
        own: { readThroughSequence: 0, muted: false },
        latestMessageSequence: 0,
        messages: [],
        limit: body['limit'],
        history: { kind: 'end' },
        catchUpCursor: `kcc1_${'A'.repeat(25)}0`,
      },
    });
  });
  await page.goto(conversationAddress);
  await expect(page.getByRole('button', { name: 'Start a thread', exact: true })).toBeVisible();
  return { calls, creates };
}

async function threadShot(page: Page, name: string) {
  const folder = process.env['KS_THREAD_OPEN_SHOTS'];
  if (folder === undefined) return;
  mkdirSync(folder, { recursive: true });
  await page.screenshot({ path: join(folder, `${name}.png`) });
}

for (const viewport of [phone, { width: 1440, height: 900 }]) {
  for (const entry of ['header', 'card'] as const) {
    test(`Open thread from the Talk ${entry} at ${String(viewport.width)} px survives sheet dismissal and reload`, async ({
      page,
    }) => {
      const { calls, creates } = await conversationWithCreate(page, viewport);
      await page
        .getByRole('button', { name: entry === 'header' ? 'Start a thread' : 'Watch together', exact: true })
        .click();
      const sheet = page.getByRole('dialog', {
        name: entry === 'header' ? 'Start a thread' : 'Watch together',
        exact: true,
      });
      await sheet
        .getByRole('button', { name: entry === 'header' ? 'Start thread' : 'Watch together', exact: true })
        .click();
      await expect(sheet.getByText('Thread started', { exact: true })).toBeVisible();
      await threadShot(page, `${entry}-${String(viewport.width)}-created`);
      try {
        await sheet.getByRole('button', { name: 'Open thread', exact: true }).click();
        await expect(page).toHaveURL(threadAddress);
        await expect(page.getByRole('heading', { level: 1, name: 'CI created thread' })).toBeVisible();
        await expect(page.getByRole('dialog')).toHaveCount(0);
      } finally {
        await threadShot(page, `${entry}-${String(viewport.width)}-opened`);
      }
      expect(creates).toHaveLength(1);
      expect(creates[0]).toMatchObject({
        root: { assetId: id(320), assetRevision: 1 },
        friendPersonIds: [ravi.personId],
      });
      expect(calls.filter((call) => call.path === '/v1/social/threads/read').at(-1)?.body).toMatchObject({ thread });
      await expect(page.getByRole('textbox', { name: 'Message Ravi', exact: true })).toBeVisible();
      await expect(
        page.getByRole('button', {
          name:
            viewport.width === phone.width
              ? 'Open Scroll, CI why the Moon and Sun make tides'
              : 'Scroll, CI why the Moon and Sun make tides, selected',
          exact: true,
        }),
      ).toBeVisible();
      await page.reload();
      await expect(page.getByRole('heading', { level: 1, name: 'CI created thread' })).toBeVisible();
      await page.goto(`/threads/${thread.threadId}`);
      await expect(page.getByRole('heading', { level: 1, name: 'CI created thread' })).toBeVisible();
      expect(creates).toHaveLength(1);
      expect(
        calls.filter((call) => /\/experience\/(open|activate|navigate)$|\/conversations\/send$/.test(call.path)),
      ).toEqual([]);
    });
  }
}

test('Talk creation ignores a double press and retries a lost response with the same command before opening', async ({
  page,
}) => {
  const { creates } = await conversationWithCreate(page, phone);
  const attempts: Record<string, unknown>[] = [];
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/v1/social/threads/create', async (route) => {
    attempts.push(route.request().postDataJSON() as Record<string, unknown>);
    if (attempts.length === 1) {
      await pending;
      await route.abort('failed');
    } else await route.fallback();
  });
  await page.getByRole('button', { name: 'Start a thread', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Start a thread', exact: true });
  await sheet.getByRole('button', { name: 'Start thread', exact: true }).dblclick();
  await expect.poll(() => attempts.length).toBe(1);
  release?.();
  await expect(sheet.getByText('Couldn’t confirm it was started.', { exact: true })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Open thread', exact: true })).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Retry', exact: true }).click();
  await sheet.getByRole('button', { name: 'Open thread', exact: true }).click();
  await expect(page).toHaveURL(threadAddress);
  await expect(page.getByRole('heading', { level: 1, name: 'CI created thread' })).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(creates).toHaveLength(1);
});

test('a created thread whose membership is unavailable explains the failed open', async ({ page }) => {
  const { creates } = await conversationWithCreate(page, { width: 1440, height: 900 });
  await page.route('**/v1/social/threads/read', (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({
      json: { version: 'content-thread.v1', scope, readId: body['readId'], status: 'unavailable' },
    });
  });
  await page.getByRole('button', { name: 'Start a thread', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Start a thread', exact: true });
  await sheet.getByRole('button', { name: 'Start thread', exact: true }).click();
  await sheet.getByRole('button', { name: 'Open thread', exact: true }).click();
  await expect(page).toHaveURL(threadAddress);
  await expect(page.getByRole('heading', { name: /This thread isn.t available/ })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(creates).toHaveLength(1);
});
