import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { createAccountScope, memoryStore } from '@knowscroll/client-core';
import type { SetRecordingPolicy } from '@knowscroll/contracts';
import { DisplayProvider } from '@knowscroll/ui';
import { RecordingControl } from './recording-control';

const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
/** Actual typed transport/session and RN control over labelled HTTP fixtures. */
it('keeps new collection paused through unknown send, retries exactly, and shows current rather than historical policy', async () => {
  let generation = 1;
  let loseReply = true;
  let next = 100;
  const commands: SetRecordingPolicy[] = [];
  const store = memoryStore();
  store.setItem(
    `ks.scope.${id(1)}:1.recorder.outbox.v1`,
    JSON.stringify({ v: 1, dropped: 0, batches: [{ events: [] }] }),
  );
  const scope = createAccountScope({
    account: { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'fixture@recording.test' },
    baseUrl: 'https://fixture.recording.test',
    authorization: () => undefined,
    store,
    fetch: async (request) => {
      const input = (await request.json()) as SetRecordingPolicy & { readId: string; target: unknown };
      if (request.url.endsWith('/set')) {
        commands.push(input);
        generation = 2;
        if (loseReply) throw new Error('fixture unknown outcome');
        // Another tab has since resumed. The old Pause receipt is still immutable.
        generation = 3;
        return new Response(
          JSON.stringify({
            version: 'recording-policy.v1',
            operation: 'privacy.recording-set',
            outcome: 'accepted',
            replayed: true,
            receipt: {
              commandId: input.commandId,
              requestedPrivacyEpoch: 1,
              fromGeneration: 1,
              toGeneration: 2,
              on: false,
              changed: true,
              recordedAt: '2026-10-23T00:00:00.000Z',
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          version: 'recording-policy.v1',
          readId: input.readId,
          target: input.target,
          scope: { accountId: id(1), privacyEpoch: 1 },
          revision: generation,
          policy: { on: generation % 2 === 1, generation },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  scope.recording!.useIdSource(() => id(next++));
  const app = await render(
    <DisplayProvider value={{ width: 390, textScale: 2, reducedMotion: true }}>
      <RecordingControl scope={scope} />
    </DisplayProvider>,
  );
  try {
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Shape my universe from what I watch', checked: true })).toBeTruthy(),
    );
    expect(screen.getByText(/1 group of unuploaded activity was discarded/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('switch', { name: 'Shape my universe from what I watch' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry the same recording choice' })).toBeTruthy());
    expect(scope.recording!.getState().collecting).toBe(false);
    expect(screen.queryByRole('button', { name: 'Resume recording' })).toBeNull();
    expect(screen.getByRole('switch', { name: 'Shape my universe from what I watch' })).toBeDisabled();
    loseReply = false;
    await fireEvent.press(screen.getByRole('button', { name: 'Retry the same recording choice' }));
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Shape my universe from what I watch', checked: true })).toBeTruthy(),
    );
    expect(commands[1]).toEqual(commands[0]);
    expect(scope.recording!.getState()).toMatchObject({ policy: { generation: 3 }, receipt: { toGeneration: 2 } });
    expect(screen.queryByText('Recording paused')).toBeNull();
    await act(() => scope.end());
    expect(scope.recording!.getState().collecting).toBe(false);
  } finally {
    await app.unmount();
    scope.end();
  }
});

it('draws a paused recording as an off switch with the Recording paused card, and Resume sends the same command as the switch', async () => {
  let generation = 2;
  const commands: SetRecordingPolicy[] = [];
  const scope = createAccountScope({
    account: { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'fixture@recording.test' },
    baseUrl: 'https://fixture.recording.test',
    authorization: () => undefined,
    store: memoryStore(),
    fetch: async (request) => {
      const input = (await request.json()) as SetRecordingPolicy & { readId: string; target: unknown };
      if (request.url.endsWith('/set')) {
        commands.push(input);
        generation = 3;
        return new Response(
          JSON.stringify({
            version: 'recording-policy.v1',
            operation: 'privacy.recording-set',
            outcome: 'accepted',
            replayed: false,
            receipt: {
              commandId: input.commandId,
              requestedPrivacyEpoch: 1,
              fromGeneration: 2,
              toGeneration: 3,
              on: true,
              changed: true,
              recordedAt: '2026-10-24T00:00:00.000Z',
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          version: 'recording-policy.v1',
          readId: input.readId,
          target: input.target,
          scope: { accountId: id(1), privacyEpoch: 1 },
          revision: generation,
          policy: { on: generation % 2 === 1, generation },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  scope.recording!.useIdSource(
    (
      (n) => () =>
        id(n++)
    )(300),
  );
  const app = await render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <RecordingControl scope={scope} />
    </DisplayProvider>,
  );
  try {
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Shape my universe from what I watch', checked: false })).toBeTruthy(),
    );
    expect(screen.getByText('Recording paused')).toBeTruthy();
    expect(screen.getByText('What stays the same')).toBeTruthy();
    expect(screen.getByText('What changes')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Resume recording' }));
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Shape my universe from what I watch', checked: true })).toBeTruthy(),
    );
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ on: true, expectedRecordingGeneration: 2 });
    expect(screen.getByText(/Open a new encounter to start recording again/)).toBeTruthy();
    expect(screen.queryByText('Recording paused')).toBeNull();
  } finally {
    await app.unmount();
    scope.end();
  }
});
