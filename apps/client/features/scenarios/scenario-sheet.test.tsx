import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { AccountScope } from '@knowscroll/client-core';
import type { ContentThreadRef, ScenarioCard } from '@knowscroll/contracts';
import { DisplayProvider } from '@knowscroll/ui';
import { ScenarioSheet, type ScenarioStart } from './scenario-sheet';

const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const thread: ContentThreadRef = { threadId: id(1), membershipId: id(2), membershipRevision: 1 };
const traffic = { subject: 'Traffic', statement: 'Traffic is ten times higher than in the original' };
const model = { subject: 'Model', statement: 'The same model serves every request' };
const option = {
  optionId: 'o1',
  title: 'Ten times the traffic, same model',
  explanation: 'Shows what one answer costs at that load.',
  changes: [traffic],
  kept: [model],
  needsConfirmation: false,
};
const second = { ...option, optionId: 'o2', title: 'Ten times the traffic, tighter latency' };
const card: ScenarioCard = {
  nodeId: id(9),
  kind: 'what_if',
  origin: 'root',
  title: option.title,
  changes: [traffic],
  kept: [model],
  hypothetical: true,
  assumptions: [traffic],
  status: 'preparing',
  revision: 1,
  createdAt: '2026-10-24T10:00:00.000Z',
};
const start: ScenarioStart = {
  kind: 'what_if',
  origin: { kind: 'root' },
  fromLabel: 'the whole thread',
  parent: { kind: 'root', assetRevision: 1 },
  premises: [],
};

type Api = Record<string, (input: never) => Promise<unknown>>;
function scopeOf(api: Api) {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const stored = new Map<string, string>();
  const wrapped = Object.fromEntries(
    Object.entries(api).map(([name, handler]) => [
      name,
      (input: never) => {
        calls.push({ name, input });
        return handler(input);
      },
    ]),
  );
  const scope = {
    active: true,
    api: { scenarios: wrapped },
    storage: {
      get: (key: string) => stored.get(key),
      set: (key: string, value: string) => void stored.set(key, value),
      remove: (key: string) => void stored.delete(key),
    },
  } as unknown as AccountScope;
  return { scope, calls, stored };
}

async function open(
  api: Api,
  callbacks: { onClose?: () => void; onChosen?: (card: ScenarioCard) => void; start?: ScenarioStart } = {},
) {
  const harness = scopeOf(api);
  const onChosen = callbacks.onChosen ?? jest.fn();
  await render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <ScenarioSheet
        start={callbacks.start ?? start}
        scope={harness.scope}
        thread={thread}
        onClose={callbacks.onClose ?? jest.fn()}
        onChosen={onChosen}
      />
    </DisplayProvider>,
  );
  return { ...harness, onChosen };
}

async function ask(words = 'What if traffic increases tenfold?') {
  await fireEvent.changeText(screen.getByLabelText('Your idea'), words);
  await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
}

describe('the What if… sheet from a message', () => {
  it('asks which kind first, in the same sheet, then goes on to the idea with the same source', async () => {
    const harness = scopeOf({});
    await render(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <ScenarioSheet
          start={{
            origin: { kind: 'message', messageId: id(5) },
            fromLabel: 'Ravi’s message',
            quote: { authorName: 'Ravi', preview: 'What would change if the tilt were different?' },
            parent: { kind: 'root', assetRevision: 1 },
            premises: [],
          }}
          scope={harness.scope}
          thread={thread}
          onClose={jest.fn()}
          onChosen={jest.fn()}
        />
      </DisplayProvider>,
    );
    expect(screen.getByText('What would change if the tilt were different?')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Your idea')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Another perspective' }));
    expect(screen.getByText('FROM: RAVI’S MESSAGE')).toBeOnTheScreen();
    expect(screen.getByLabelText('Your idea')).toBeOnTheScreen();
    expect(harness.calls).toEqual([]);
  });
});

describe('the What if… sheet', () => {
  it('starts from where the request began, keeps the member’s words, and asks nothing until Continue', async () => {
    const { calls, stored } = await open({});
    expect(screen.getByText('FROM: THE WHOLE THREAD')).toBeOnTheScreen();
    expect(screen.getByText('Nothing is made yet. You’ll see what we’d explore, and choose.')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await fireEvent.changeText(screen.getByLabelText('Your idea'), 'What if traffic grew?');
    expect(stored.get(`scenario.draft.${thread.threadId}`)).toBe('What if traffic grew?');
    expect(calls).toEqual([]);
  });

  it('shows one clear idea as a summary and commissions only when the member presses Explore', async () => {
    const onChosen = jest.fn();
    const { calls } = await open(
      {
        draft: () => Promise.resolve({ draftId: id(7) }),
        readDraft: () => Promise.resolve({ status: 'ready', mode: 'direct', options: [option] }),
        choose: () => Promise.resolve({ node: card, reused: false }),
      },
      { onChosen },
    );
    await ask();
    expect(await screen.findByText('WE’LL EXPLORE')).toBeOnTheScreen();
    expect(screen.getByText('Changed: traffic is ten times higher than in the original')).toBeOnTheScreen();
    expect(screen.getByText('Kept: the same model serves every request')).toBeOnTheScreen();
    expect(calls.map((call) => call.name)).toEqual(['draft', 'readDraft']);
    await fireEvent.press(screen.getByRole('button', { name: 'Explore' }));
    expect(await screen.findByText('Branch started.')).toBeOnTheScreen();
    expect(calls.map((call) => call.name)).toEqual(['draft', 'readDraft', 'choose']);
    expect(calls[2]?.input['selection']).toEqual({ kind: 'suggestion', optionId: 'o1' });
    await fireEvent.press(screen.getByRole('button', { name: 'Back to the thread' }));
    expect(onChosen).toHaveBeenCalledWith(card);
  });

  it('lists a few directions to pick from and chooses the one the member presses', async () => {
    const { calls } = await open({
      draft: () => Promise.resolve({ draftId: id(7) }),
      readDraft: () => Promise.resolve({ status: 'ready', mode: 'options', options: [option, second] }),
      choose: () => Promise.resolve({ node: card, reused: false }),
    });
    await ask();
    expect(await screen.findByText('Suggestions. Nothing is made until you choose one.')).toBeOnTheScreen();
    expect(screen.getByText(second.title)).toBeOnTheScreen();
    const choices = screen.getAllByRole('button', { name: 'Explore this' });
    expect(choices).toHaveLength(2);
    await fireEvent.press(choices[1]!);
    expect(await screen.findByText('Branch started.')).toBeOnTheScreen();
    expect(calls.at(-1)?.input['selection']).toEqual({ kind: 'suggestion', optionId: 'o2' });
  });

  it('asks the member to confirm a speculative idea before anything is made', async () => {
    const { calls } = await open({
      draft: () => Promise.resolve({ draftId: id(7) }),
      readDraft: () =>
        Promise.resolve({ status: 'ready', mode: 'direct', options: [{ ...option, needsConfirmation: true }] }),
      choose: () => Promise.resolve({ node: card, reused: false }),
    });
    await ask('What if a black hole were a portal?');
    expect(await screen.findByText('Speculative scenario · not established science')).toBeOnTheScreen();
    expect(calls.map((call) => call.name)).not.toContain('choose');
    await fireEvent.press(screen.getByRole('button', { name: 'Create branch' }));
    expect(await screen.findByText('Branch started.')).toBeOnTheScreen();
  });

  it('keeps the subjects of an edited suggestion, so the edit replaces what it was and nothing beside it', async () => {
    const { calls } = await open({
      draft: () => Promise.resolve({ draftId: id(7) }),
      readDraft: () => Promise.resolve({ status: 'ready', mode: 'direct', options: [option] }),
      choose: () => Promise.resolve({ node: card, reused: false }),
    });
    await ask();
    await fireEvent.press(await screen.findByRole('button', { name: 'Edit' }));
    await fireEvent.changeText(screen.getByLabelText('What changes 1'), 'Traffic is twenty times higher');
    await fireEvent.press(screen.getByRole('button', { name: 'Explore' }));
    expect(await screen.findByText('Branch started.')).toBeOnTheScreen();
    expect(calls.at(-1)?.input['selection']).toEqual({
      kind: 'own',
      changes: [{ subject: 'Traffic', statement: 'Traffic is twenty times higher' }],
      kept: [{ subject: 'Model', statement: 'The same model serves every request' }],
    });
  });

  describe('continuing a branch that already assumes something', () => {
    const below: ScenarioStart = { ...start, premises: [traffic, model] };
    const writeOwn = async (callbacks: Record<string, () => Promise<unknown>> = {}) => {
      const opened = await open(
        {
          draft: () => Promise.resolve({ draftId: id(7) }),
          readDraft: () => Promise.resolve({ status: 'failed', reason: 'could_not_suggest' }),
          choose: () => Promise.resolve({ node: card, reused: false }),
          ...callbacks,
        },
        { start: below },
      );
      await ask();
      await fireEvent.press(await screen.findByRole('button', { name: 'Write my own version' }));
      return opened;
    };

    it('lists what already holds, and says that a new line adds a premise', async () => {
      await writeOwn();
      expect(screen.getByText('Already assumed from earlier branches')).toBeOnTheScreen();
      expect(screen.getByText(`· ${traffic.statement}`)).toBeOnTheScreen();
      expect(screen.getByText(/A line you add below is a new premise/)).toBeOnTheScreen();
    });

    it('adds a premise of its own unless the member says which one the line replaces', async () => {
      const { calls } = await writeOwn();
      await fireEvent.changeText(screen.getByLabelText('What changes 1'), 'Traffic is twenty times higher');
      await fireEvent.press(screen.getByRole('button', { name: 'Explore' }));
      expect(await screen.findByText('Branch started.')).toBeOnTheScreen();
      expect(calls.at(-1)?.input['selection']).toEqual({
        kind: 'own',
        changes: [{ subject: 'Traffic is twenty', statement: 'Traffic is twenty times higher' }],
        kept: [],
      });
    });

    it('replaces the premise the member names, keeping its subject', async () => {
      const { calls } = await writeOwn();
      await fireEvent.changeText(screen.getByLabelText('What changes 1'), 'Traffic is twenty times higher');
      await fireEvent.press(screen.getByText('Replaces: Traffic'));
      await fireEvent.press(screen.getByRole('button', { name: 'Explore' }));
      expect(await screen.findByText('Branch started.')).toBeOnTheScreen();
      expect(calls.at(-1)?.input['selection']).toEqual({
        kind: 'own',
        changes: [{ subject: 'Traffic', statement: 'Traffic is twenty times higher' }],
        kept: [],
      });
    });
  });

  it('says honestly when no directions came and offers the member’s own version', async () => {
    await open({
      draft: () => Promise.resolve({ draftId: id(7) }),
      readDraft: () => Promise.resolve({ status: 'failed', reason: 'could_not_suggest' }),
    });
    await ask();
    expect(await screen.findByText(/We couldn’t think of directions this time\./)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Write my own version' }));
    expect(screen.getByLabelText('What changes 1')).toBeOnTheScreen();
  });

  it('says what stopped it, and retries a lost answer', async () => {
    let drafts = 0;
    await open({
      draft: () => (drafts++ === 0 ? Promise.reject(new Error('network')) : Promise.resolve({ draftId: id(7) })),
      readDraft: () => Promise.resolve({ status: 'thinking' }),
    });
    await ask();
    expect(await screen.findByText(/Couldn’t reach KnowScroll\. Nothing was lost; try again\./)).toBeOnTheScreen();
    await act(async () => {
      await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(await screen.findByText('Thinking of directions…')).toBeOnTheScreen();
  });
});
