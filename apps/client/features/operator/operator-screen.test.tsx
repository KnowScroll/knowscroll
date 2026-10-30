import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { createAccountScope, memoryStore, type AccountScope } from '@knowscroll/client-core';
import { DisplayProvider } from '@knowscroll/ui';
import { OperatorPanels } from './operator-screen';

/**
 * The Operator screen over a labelled fixture `fetch`: no network, no API. The rows are authored
 * examples of what the API's contract allows; they are not records of any system.
 */
const account = {
  accountId: '0199a000-0000-7000-8000-00000000000a',
  universeId: '0199a000-0000-7000-8000-0000000000aa',
  privacyEpoch: 1,
  email: 'a@operator.test',
};
const REQUEST = '0199a000-0000-7000-8000-0000000000b1';
const ATTEMPT = '0199a000-0000-7000-8000-0000000000b2';

const unavailable = { status: 'unavailable', reason: 'no_tier0_source' };
const panels = {
  generatedAt: '2026-10-24T10:00:00.000Z',
  overview: {
    queues: {
      status: 'available',
      data: [
        {
          queue: 'content.produce-scroll',
          ready: 0,
          scheduled: 0,
          retrying: 1,
          active: 1,
          failed: 2,
          oldestWaitingSeconds: 420,
          lastCompletedAt: '2026-10-24T09:50:00.000Z',
        },
      ],
    },
    providerOutcomes: {
      status: 'available',
      data: [
        { state: 'succeeded', count: 12 },
        { state: 'unknown', count: 1 },
      ],
    },
    recentErrors: {
      status: 'available',
      data: [
        {
          occurredAt: '2026-10-24T09:58:00.000Z',
          source: 'model_attempt',
          refId: ATTEMPT,
          state: 'unknown',
          code: 'TIMEOUT_AFTER_DISPATCH',
          label: 'primary',
        },
      ],
    },
    serviceHealth: unavailable,
    requestLatency: unavailable,
    mediaDisk: unavailable,
  },
  production: {
    runs: {
      status: 'available',
      data: [
        {
          productionRunId: '0199a000-0000-7000-8000-0000000000c1',
          recipeKey: 'seasons',
          take: 1,
          state: 'rejected',
          writerRunState: 'completed',
          modelAttempts: 2,
          refusedAnswers: 2,
          assetId: null,
          createdAt: '2026-10-24T09:00:00.000Z',
          completedAt: '2026-10-24T09:02:00.000Z',
        },
      ],
    },
    refusedAnswers: {
      status: 'available',
      data: [
        {
          attemptId: ATTEMPT,
          step: 'primary',
          model: 'MiniMax-M3.1-Flash',
          reason: 'OUTPUT_SCHEMA_MISMATCH',
          issueCount: 3,
          issueCodes: ['required', 'too_long'],
          answerChars: 2048,
          truncated: false,
          recordedAt: '2026-10-24T09:01:00.000Z',
        },
      ],
    },
    reelOrders: {
      status: 'available',
      data: [
        {
          reelOrderId: '0199a000-0000-7000-8000-0000000000d1',
          scriptName: 'beam-angle',
          until: 'video',
          attempts: 1,
          settledCents: 0,
          claimedOpenCents: 75,
          latestAttemptState: 'dispatched',
          createdAt: '2026-10-24T08:00:00.000Z',
          publishedAt: null,
        },
      ],
    },
    usage: {
      status: 'available',
      data: { windowHours: 24, attempts: 13, tokensReported: 41_000, attemptsWithoutReportedUsage: 1 },
    },
  },
  universeChange: { cartographer: { status: 'unavailable', reason: 'view_missing' } },
  safety: {
    reports: {
      status: 'available',
      data: {
        last24Hours: 2,
        recent: [
          {
            reportId: '0199a000-0000-7000-8000-0000000000e1',
            kind: 'abuse',
            category: 'harassment',
            targetKind: 'room_message',
            assetId: null,
            messageId: '0199a000-0000-7000-8000-0000000000e2',
            roomId: '0199a000-0000-7000-8000-0000000000e3',
            hasNote: true,
            createdAt: '2026-10-24T09:30:00.000Z',
          },
          {
            reportId: '0199a000-0000-7000-8000-0000000000e4',
            kind: 'content_error',
            category: 'out_of_date',
            targetKind: 'asset',
            assetId: '0199a000-0000-7000-8000-0000000000e5',
            messageId: null,
            roomId: null,
            hasNote: false,
            createdAt: '2026-10-24T08:00:00.000Z',
          },
        ],
      },
    },
  },
  rooms: {
    calls: {
      status: 'available',
      data: {
        limits: {
          humanMessagesPerTurn: 3,
          roomPerHour: 8,
          roomPerDay: 40,
          explainerPerHour: 4,
          skepticPerHour: 3,
          skepticPerPersonPerHour: 1,
        },
        rooms: [
          {
            roomId: '0199a000-0000-7000-8000-0000000000f1',
            asked: 2,
            unprompted: 3,
            unpromptedLastHour: 1,
            refused: [{ cap: 'ratio', count: 4 }],
            lastAt: '2026-10-24T09:45:00.000Z',
          },
        ],
      },
    },
  },
  realtime: { delivery: unavailable },
  privacy: {
    operations: { status: 'available', data: { groups: [], failed: [] } },
    retentionJobs: { status: 'available', data: [] },
    droppedDiagnostics: unavailable,
  },
};
const journey = {
  subject: 'request',
  subjectId: REQUEST,
  steps: [
    {
      at: '2026-10-24T10:00:00.120Z',
      endedAt: '2026-10-24T10:00:02.620Z',
      stage: 'supply.request',
      title: 'Request',
      state: 'ready',
      code: 'create',
      label: null,
      count: null,
      ref: REQUEST,
      scope: 'personal',
    },
    {
      at: '2026-10-24T10:00:03.000Z',
      endedAt: null,
      stage: 'reasoning.production_attempt',
      title: 'Model attempt (production)',
      state: 'unknown',
      code: null,
      label: 'primary',
      count: null,
      ref: ATTEMPT,
      scope: 'shared',
    },
  ],
  gaps: [
    {
      stage: 'reasoning.production_attempt',
      ref: ATTEMPT,
      note: 'Outcome unknown. It is reconciled or written off, never sent again.',
    },
  ],
  truncated: false,
};

function json(status: number, body: unknown, type = 'application/json'): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });
}
const problemNotFound = {
  type: 'tag:knowscroll,2026:problem:NOT_FOUND',
  title: 'Not found.',
  status: 404,
  code: 'NOT_FOUND',
};

async function mount(answer: (path: string) => Response) {
  const paths: string[] = [];
  const scope: AccountScope = createAccountScope({
    account,
    baseUrl: 'https://app.operator.test',
    fetch: (request: Request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path === '/health')
        return Promise.resolve(
          json(200, {
            status: 'ok',
            world: 'local',
            commit: '0123456789abcdef',
            artifact: 'unknown',
            migration: '0057_ops_views',
            relay: 'listening',
          }),
        );
      return Promise.resolve(answer(path));
    },
    authorization: () => undefined,
    store: memoryStore(),
  });
  await render(
    <DisplayProvider value={{ width: 1280, textScale: 1, reducedMotion: true }}>
      <QueryClientProvider client={scope.queryClient}>
        <OperatorPanels scope={scope} />
      </QueryClientProvider>
    </DisplayProvider>,
  );
  return { paths };
}

const operatorAnswers = (path: string) => {
  if (path === '/v1/operator/panels') return json(200, panels);
  if (path === `/v1/operator/journeys/${REQUEST}`) return json(200, journey);
  return json(404, problemNotFound, 'application/problem+json');
};

describe('the Operator screen', () => {
  it('shows the panels and the reports from the views, and says plainly where Tier 0 has no source', async () => {
    await mount(operatorAnswers);
    expect(await screen.findByRole('heading', { name: 'Operator' })).toBeOnTheScreen();
    for (const title of [
      '1 · System overview',
      '2 · Journey search',
      '3 · Content production',
      '4 · Universe change',
      '5 · Realtime delivery',
      '6 · Privacy & diagnostics health',
      '7 · Reports',
    ])
      expect(screen.getByRole('heading', { name: title })).toBeOnTheScreen();
    expect(screen.getByText('content.produce-scroll')).toBeOnTheScreen();
    expect(screen.getByText('failed 2')).toBeOnTheScreen();
    expect(screen.getByText('unknown 1')).toBeOnTheScreen();
    expect(screen.getByText('seasons · take 1')).toBeOnTheScreen();
    expect(screen.getByText('OUTPUT_SCHEMA_MISMATCH')).toBeOnTheScreen();
    expect(screen.getByText('required, too_long')).toBeOnTheScreen();
    expect(screen.getByText('beam-angle · until video')).toBeOnTheScreen();
    expect(screen.getByText('settled 0¢ · claimed open 75¢')).toBeOnTheScreen();
    // Unavailable pieces are words, never numbers.
    expect(screen.getByLabelText('service health: unavailable')).toBeOnTheScreen();
    expect(screen.getByLabelText('request latency: unavailable')).toBeOnTheScreen();
    expect(screen.getByLabelText('delivery, reconnect and relay: unavailable')).toBeOnTheScreen();
    expect(screen.getByText('Unavailable · the view is not installed')).toBeOnTheScreen();
    expect(await screen.findByText(/world local · 01234567/)).toBeOnTheScreen();
  });

  it('lists the reports by kind, reason and what they are about, saying only whether a note exists', async () => {
    await mount(operatorAnswers);
    expect(await screen.findByRole('heading', { name: '7 · Reports' })).toBeOnTheScreen();
    expect(screen.getByText('2 in the last 24 hours')).toBeOnTheScreen();
    expect(screen.getByText('harassment')).toBeOnTheScreen();
    expect(screen.getByText('room message')).toBeOnTheScreen();
    expect(screen.getByText('with a note')).toBeOnTheScreen();
    expect(screen.getByText('out_of_date')).toBeOnTheScreen();
    expect(screen.getByText('Reel or Scroll')).toBeOnTheScreen();
    expect(screen.getByText('no note')).toBeOnTheScreen();
  });

  it('counts each room’s AI calls against the caps, with ids and counts only', async () => {
    await mount(operatorAnswers);
    expect(await screen.findByRole('heading', { name: '8 · Rooms' })).toBeOnTheScreen();
    expect(screen.getByText('0199a000')).toBeOnTheScreen();
    expect(screen.getByText('asked 2')).toBeOnTheScreen();
    expect(screen.getByText('on its own 3 (1 this hour)')).toBeOnTheScreen();
    expect(screen.getByText('ratio 4')).toBeOnTheScreen();
    expect(screen.getByText(/limits: 1 per 3 messages · 8\/h · 40\/day/)).toBeOnTheScreen();
  });

  it('looks up a journey and shows its steps and the gap an unknown outcome leaves', async () => {
    const { paths } = await mount(operatorAnswers);
    await screen.findByRole('heading', { name: '2 · Journey search' });
    await fireEvent.changeText(screen.getByLabelText('ID to look up'), `  ${REQUEST} `);
    await fireEvent.press(screen.getByRole('button', { name: 'Look up' }));
    expect(await screen.findByTestId('operator-journey-result')).toBeOnTheScreen();
    expect(paths).toContain(`/v1/operator/journeys/${REQUEST}`);
    expect(screen.getByText('supply.request')).toBeOnTheScreen();
    // Once as the step, once as the stage the gap belongs to.
    expect(screen.getAllByText('reasoning.production_attempt')).toHaveLength(2);
    expect(screen.getByText('Gap')).toBeOnTheScreen();
    expect(screen.getByText(/never sent again/)).toBeOnTheScreen();
  });

  it('opens the journey of a recent error from its row', async () => {
    const attemptJourney = { ...journey, subject: 'attempt', subjectId: ATTEMPT };
    const { paths } = await mount((path) =>
      path === `/v1/operator/journeys/${ATTEMPT}` ? json(200, attemptJourney) : operatorAnswers(path),
    );
    const buttons = await screen.findAllByRole('button', { name: 'Open the journey of this model attempt' });
    await fireEvent.press(buttons[0]!);
    await waitFor(() => expect(paths).toContain(`/v1/operator/journeys/${ATTEMPT}`));
    expect(await screen.findByTestId('operator-journey-result')).toBeOnTheScreen();
    expect(screen.getByLabelText('ID to look up').props.value).toBe(ATTEMPT);
  });

  it('refuses what is not an ID before asking the server, and says when nothing carries an ID', async () => {
    const { paths } = await mount(operatorAnswers);
    await screen.findByRole('heading', { name: '2 · Journey search' });
    await fireEvent.changeText(screen.getByLabelText('ID to look up'), 'someone@example.com');
    await fireEvent.press(screen.getByRole('button', { name: 'Look up' }));
    expect(await screen.findByText(/That is not an ID/)).toBeOnTheScreen();
    expect(paths.filter((path) => path.startsWith('/v1/operator/journeys'))).toEqual([]);
    await fireEvent.changeText(screen.getByLabelText('ID to look up'), '0199a000-0000-7000-8000-0000000000ff');
    await fireEvent.press(screen.getByRole('button', { name: 'Look up' }));
    expect(await screen.findByText(/No record carries this ID/)).toBeOnTheScreen();
  });

  it('shows an account that is not an operator the same page as an unknown address', async () => {
    await mount(() => json(404, problemNotFound, 'application/problem+json'));
    expect(await screen.findByText("This page isn't here")).toBeOnTheScreen();
    expect(screen.queryByTestId('operator-screen')).toBeNull();
    expect(screen.queryByText('1 · System overview')).toBeNull();
  });
});
