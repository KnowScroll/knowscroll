import { fireEvent, render, screen } from '@testing-library/react-native';
import type { SnippetCard as SnippetCardData } from '@knowscroll/contracts';
import { DisplayProvider } from '@knowscroll/ui';
import { SnippetCard, snippetAction, snippetDescription } from './snippet-card';

const target = { assetId: '0199a000-0000-7000-8000-000000000001', assetRevision: 1 };
const available = {
  status: 'available' as const,
  target,
  metadata: { kind: 'reel' as const, title: 'The edge', summary: '', language: 'en' },
};
const corrected = {
  status: 'corrected' as const,
  target,
  current: { ...target, assetRevision: 2, metadata: available.metadata },
};
const unavailable = { status: 'unavailable' as const, target };

async function show(snippet: SnippetCardData, partLabel: string | undefined = 'Part 2') {
  const onOpen = jest.fn();
  await render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <SnippetCard snippet={snippet} partLabel={partLabel} onOpen={onOpen} />
    </DisplayProvider>,
  );
  return onOpen;
}

describe('snippet cards', () => {
  it('shows a Reel moment as its range with Play, and opens it', async () => {
    const snippet: SnippetCardData = { kind: 'reel_range', startMs: 18_000, endMs: 31_000, content: available };
    const onOpen = await show(snippet);
    expect(screen.getByText('0:18–0:31')).toBeOnTheScreen();
    expect(screen.getByText('Play')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: /Moment 0:18–0:31 of Part 2, The edge/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(snippetAction(snippet)).toBe('Play');
  });

  it('shows a passage as its quote with Read in context', async () => {
    const snippet: SnippetCardData = {
      kind: 'scroll_passage',
      blockId: 'crowd-p1',
      quote: 'Time itself runs slower down there.',
      content: { ...available, metadata: { ...available.metadata, kind: 'scroll' } },
    };
    await show(snippet);
    expect(screen.getByText('“Time itself runs slower down there.”')).toBeOnTheScreen();
    expect(screen.getByText('Read in context')).toBeOnTheScreen();
  });

  it('says whether a block carries its settings, and whether they include the sender’s own value', async () => {
    const base = { kind: 'scroll_block' as const, blockId: 'length-sim', blockType: 'simulation', content: available };
    await show({ ...base, label: 'Sentence length', settings: { included: false } });
    expect(screen.getByText('Settings not included')).toBeOnTheScreen();
    expect(screen.getByText('Open')).toBeOnTheScreen();
    await screen.unmount();
    await show({
      ...base,
      label: 'Sentence length',
      settings: { included: true, description: 'Sentence length · 4,096 words', personalIncluded: true },
    });
    expect(screen.getByText('Sentence length · 4,096 words')).toBeOnTheScreen();
    expect(screen.getByText('Includes the sender’s own value')).toBeOnTheScreen();
    expect(screen.getByText('Open as set')).toBeOnTheScreen();
  });

  it('marks a corrected source and says opening it tells whether the moment holds', async () => {
    await show({ kind: 'reel_range', startMs: 1_000, endMs: 9_000, content: corrected });
    expect(screen.getByText('Updated')).toBeOnTheScreen();
    expect(screen.getByText(/Opening it says whether the moment still holds/)).toBeOnTheScreen();
  });

  it('leaves a quiet note for withdrawn content, with no quote and nothing to open', async () => {
    const snippet: SnippetCardData = { kind: 'scroll_passage', blockId: 'a', content: unavailable };
    const onOpen = await show(snippet);
    expect(screen.getByText('This moment is no longer available.')).toBeOnTheScreen();
    expect(screen.queryByRole('button')).toBeNull();
    expect(snippetAction(snippet)).toBe('');
    expect(onOpen).not.toHaveBeenCalled();
    expect(snippetDescription(snippet, undefined)).toContain('no longer available');
  });
});
