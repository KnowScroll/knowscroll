import type { ReactElement } from 'react';
import { AppState, ScrollView, Text } from 'react-native';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { content, spacing, space } from '@knowscroll/design-tokens';
import { deriveGesture, walkBlocks, type ScrollDocument } from '@knowscroll/scroll-model';
import { DisplayProvider, type Display } from '../display/display';
import { ScrollArticle } from './article';
import { bridgesPoster, bridgesWithServerFallback, lighthouseEditorial } from './fixtures/documents';
import type { ScrollDiagnostics, ScrollReadingObserver } from './observer';
import { prepareScrollDocument } from './prepare';
import { createMemoryBlockStateStore } from './state';
import { interactionProblems } from '../test-support/interactions';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(() => Promise.resolve(true)) }));

/**
 * The poster and editorial renderers over labelled fixture documents (original, never product
 * content), through the client parse (`prepareScrollDocument`). Native project; the web modules
 * (IntersectionObserver, visibilitychange, the drop cap) are in the `*.web.test.tsx` files.
 */

/** A stand-in for the route's chrome: plain text. */
function ScrollSlot({ label }: { label: string }) {
  return <Text>{label}</Text>;
}

type DisplayPin = Partial<Pick<Display, 'width' | 'textScale' | 'reducedMotion'>>;

function wrap(element: ReactElement, display: DisplayPin = {}) {
  return (
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true, ...display }}>{element}</DisplayProvider>
  );
}

function show(element: ReactElement, display: DisplayPin = {}) {
  return render(wrap(element, display));
}

function ready(document: ScrollDocument): ScrollDocument {
  const prepared = prepareScrollDocument(document);
  if (prepared.kind !== 'ready') throw new Error('the fixture must parse on the client path');
  return prepared.document;
}

function observer() {
  return {
    onBlockVisibility: jest.fn(),
    onBlockInteraction: jest.fn(),
    onActivity: jest.fn(),
  } satisfies ScrollReadingObserver;
}

function diagnostics() {
  return { onRenderFallback: jest.fn(), onFallbackRetry: jest.fn() } satisfies ScrollDiagnostics;
}

const anyNumber = expect.any(Number) as number;
const copyText = Clipboard.setStringAsync as jest.Mock;
const scrollTo = (ScrollView.prototype as unknown as { scrollTo: jest.Mock }).scrollTo;

beforeAll(() => {
  // Queries find text wherever it is; hiding from assistive technology is asserted explicitly.
  configure({ defaultIncludeHiddenElements: true });
});

afterAll(() => {
  configure({ defaultIncludeHiddenElements: false });
});

const appState = AppState as unknown as { currentState: unknown };
let originalState: unknown;

beforeEach(() => {
  copyText.mockClear();
  scrollTo.mockClear();
  // The jest preset's AppState has no current state: here the app is in the foreground.
  originalState = appState.currentState;
  appState.currentState = 'active';
});

afterEach(() => {
  appState.currentState = originalState;
  jest.restoreAllMocks();
});

describe('the poster template', () => {
  it('opens with a title card: topic tag, the title as the level-1 heading, the dek and the reading time', async () => {
    const document = ready(bridgesPoster());
    await show(<ScrollArticle document={document} />);

    expect(screen.getByRole('header', { name: 'Why bridges stay up' })).toBeOnTheScreen();
    expect(screen.getByText('Engineering')).toBeOnTheScreen();
    expect(screen.getByText(document.dek)).toBeOnTheScreen();
    expect(screen.getByText(`A Scroll · ${document.measures.readingMinutes} min`)).toBeOnTheScreen();
  });

  it('has real headings for the rotor: the title, each section heading and each subheading', async () => {
    await show(<ScrollArticle document={ready(bridgesPoster())} />);

    const headings = screen.getAllByRole('header').map((heading) => heading.props.children as string);
    expect(headings).toEqual([
      'Why bridges stay up',
      'Pushing and pulling',
      'Where the force goes',
      'Reading a load check',
    ]);
  });

  it('draws marks on the text runs and keeps the paragraph text whole', async () => {
    await show(<ScrollArticle document={ready(bridgesPoster())} />);

    expect(screen.getByText('Every shape')).toHaveStyle({ fontWeight: '700' });
    expect(screen.getByText('How')).toHaveStyle({ fontStyle: 'italic' });
    expect(screen.getByText('load path')).toHaveStyle({ fontFamily: 'DMMono', backgroundColor: content.paper2 });
    expect(
      screen.getByText(
        'Pushing squeezes a material. Pulling stretches it. Every shape a bridge takes is a decision about where to put each.',
      ),
    ).toBeOnTheScreen();
  });

  it('draws the list with its own marker column, hidden from assistive technology', async () => {
    await show(<ScrollArticle document={ready(bridgesPoster())} />);

    expect(screen.getByLabelText('List')).toBeOnTheScreen();
    expect(screen.getAllByText('•')).toHaveLength(3);
    expect(screen.queryAllByText('•', { includeHiddenElements: false })).toHaveLength(0);
  });

  it('labels the quote and each kind of callout, and shows the callout title', async () => {
    await show(<ScrollArticle document={ready(bridgesPoster())} />);

    expect(screen.getByLabelText('Pull quote')).toBeOnTheScreen();
    expect(screen.getByLabelText('Quotation')).toBeOnTheScreen();
    expect(screen.getByLabelText('Key idea: The whole idea')).toBeOnTheScreen();
    expect(screen.getByLabelText('Example: A plank')).toBeOnTheScreen();
    expect(screen.getByLabelText('Limits: What this cannot do')).toBeOnTheScreen();
    expect(screen.getByLabelText('Try it')).toBeOnTheScreen();
    expect(screen.getByText('The whole idea')).toBeOnTheScreen();
    expect(screen.getByText('— A saying among bridge builders')).toBeOnTheScreen();
  });

  it('marks the end of the article for assistive technology, and holds the app chrome slots', async () => {
    await show(
      <ScrollArticle
        document={ready(bridgesPoster())}
        afterHeader={<ScrollSlot label="Actions strip" />}
        endSlot={<ScrollSlot label="Continue this idea" />}
      />,
    );

    expect(screen.getByLabelText('End of this Scroll')).toBeOnTheScreen();
    expect(screen.getByText('Actions strip')).toBeOnTheScreen();
    expect(screen.getByText('Continue this idea')).toBeOnTheScreen();
  });

  it('declares the gesture of every block it draws as the package derives it', () => {
    for (const { block } of walkBlocks(bridgesPoster().sections)) expect(block.gesture).toBe(deriveGesture(block));
  });
});

describe('the editorial template', () => {
  it('sets the kicker, title and dek as an essay, with an initial cap that leaves the text whole', async () => {
    const document = ready(lighthouseEditorial());
    await show(<ScrollArticle document={document} />);

    expect(screen.getByRole('header', { name: 'How lighthouse keepers kept the night' })).toBeOnTheScreen();
    expect(screen.getByText('Essay · The age of lamps')).toBeOnTheScreen();
    expect(screen.getByText('F')).toHaveStyle({ fontFamily: 'BricolageGrotesque', fontSize: 34 });
    expect(
      screen.getByText(
        'For a century the safest thing on a dangerous coast was a person awake at the right moment. The lamp itself was simple: a flame, a lens and a reflector. What made it work was the watch.',
      ),
    ).toBeOnTheScreen();
  });

  it('shows the framing and the correction above the first section, where they cannot be hidden', async () => {
    await show(<ScrollArticle document={ready(lighthouseEditorial())} />);

    expect(screen.getByText('Hypothetical')).toBeOnTheScreen();
    expect(screen.getByText('What changes')).toBeOnTheScreen();
    expect(screen.getByText('The lamp has no clockwork and must be turned by hand.')).toBeOnTheScreen();
    expect(screen.getByText('What stays the same')).toBeOnTheScreen();
    expect(screen.getByText('Corrected 14 Oct.')).toBeOnTheScreen();
    expect(screen.getByLabelText(/^Corrected 14 Oct\. The second paragraph/)).toBeOnTheScreen();
  });

  it('draws no cap on the poster', async () => {
    await show(<ScrollArticle document={ready(bridgesPoster())} />);
    expect(screen.queryByText('A')).toBeNull();
  });
});

describe('the reading measure', () => {
  it('is the full width on phones, 500 px on tablets and 680 px on desktops (880 for code)', async () => {
    const document = ready(bridgesPoster());
    const phone = await show(<ScrollArticle document={document} />);
    expect(screen.getByTestId('block-p-open-1')).not.toHaveStyle({ maxWidth: 500 });
    await phone.unmount();

    const tablet = await show(<ScrollArticle document={document} />, { width: 834 });
    expect(screen.getByTestId('block-p-open-1')).toHaveStyle({ maxWidth: 500 });
    await tablet.unmount();

    await show(<ScrollArticle document={document} />, { width: 1440 });
    expect(screen.getByTestId('block-p-open-1')).toHaveStyle({ maxWidth: 680 });
    expect(screen.getByTestId('block-code-load')).toHaveStyle({ maxWidth: 880 });
  });
});

describe('a disclosure', () => {
  const key = { assetId: 'fixture-bridges', revision: 1, blockId: 'd-safety' };

  it('starts collapsed, expands on press without animation, and reports a deliberate interaction', async () => {
    const watcher = observer();
    await show(<ScrollArticle document={ready(bridgesPoster())} observer={watcher} />);
    expect(screen.getByRole('button', { name: 'Why a safety factor?' })).toBeCollapsed();
    expect(screen.queryByText('safety factor')).toBeNull();

    await fireEvent.press(screen.getByRole('button', { name: 'Why a safety factor?' }));

    expect(screen.getByRole('button', { name: 'Why a safety factor?' })).toBeExpanded();
    expect(screen.getByText('safety factor')).toBeOnTheScreen();
    expect(screen.getByText('The factor is chosen from long experience, not from a single formula.')).toBeOnTheScreen();
    expect(watcher.onBlockInteraction).toHaveBeenLastCalledWith({
      blockId: 'd-safety',
      blockType: 'disclosure',
      kind: 'expanded',
      at: anyNumber,
    });

    await fireEvent.press(screen.getByRole('button', { name: 'Why a safety factor?' }));

    expect(screen.getByRole('button', { name: 'Why a safety factor?' })).toBeCollapsed();
    expect(watcher.onBlockInteraction).toHaveBeenLastCalledWith({
      blockId: 'd-safety',
      blockType: 'disclosure',
      kind: 'collapsed',
      at: anyNumber,
    });
    // Both directions are kinds the package declares for a disclosure: the recorder can send them.
    expect(interactionProblems(watcher, ready(bridgesPoster()))).toEqual([]);
  });

  it('keeps its state by (revision, block id): it returns when the article does, and a new revision starts over', async () => {
    const store = createMemoryBlockStateStore();
    const first = await show(<ScrollArticle document={ready(bridgesPoster())} store={store} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Why a safety factor?' }));
    expect(store.get(key)).toEqual({ type: 'disclosure', expanded: true });
    await first.unmount();

    const again = await show(<ScrollArticle document={ready(bridgesPoster())} store={store} />);
    expect(screen.getByRole('button', { name: 'Why a safety factor?' })).toBeExpanded();
    await again.unmount();

    await show(<ScrollArticle document={ready(bridgesPoster(2))} store={store} />);
    expect(screen.getByRole('button', { name: 'Why a safety factor?' })).toBeCollapsed();
    expect(store.get({ ...key, revision: 2 })).toBeNull();
  });

  it('is a plain button with a 56 px target, reading before the code and after it in document order', async () => {
    await show(<ScrollArticle document={ready(bridgesPoster())} />);

    expect(screen.getByRole('button', { name: 'Why a safety factor?' })).toHaveStyle({ minHeight: 56 });
    // Focus order is reading order: the code's Copy comes before the disclosure that follows it.
    expect(screen.getAllByRole('button').map((button) => button.props.accessibilityLabel as string)).toEqual([
      'Copy',
      'Why a safety factor?',
    ]);
  });
});

describe('a code block', () => {
  it('scrolls horizontally inside its own frame, named for assistive technology, and shows the language', async () => {
    await show(<ScrollArticle document={ready(bridgesPoster())} />);

    expect(screen.getByLabelText('Code example, scrolls horizontally')).toHaveProp('horizontal', true);
    expect(screen.getByText('Python · load check')).toBeOnTheScreen();
    expect(screen.getByText('limit = 4200')).toBeOnTheScreen();
    expect(screen.getByText('The numbers here are for illustration.')).toBeOnTheScreen();
  });

  it('highlights the lines the block names', async () => {
    await show(<ScrollArticle document={ready(bridgesPoster())} />);

    expect(screen.getByText(/dead = 18\.5 \* span_m/)).toBeOnTheScreen();
    expect(screen.getByTestId('code-line-2')).toHaveStyle({ backgroundColor: space.s2 });
    expect(screen.getByTestId('code-line-3')).toHaveStyle({ backgroundColor: space.s2 });
    expect(screen.getByTestId('code-line-1')).not.toHaveStyle({ backgroundColor: space.s2 });
    expect(screen.getByTestId('code-line-4')).not.toHaveStyle({ backgroundColor: space.s2 });
  });

  it('copies the code on Copy, says "Copied" and reports the interaction', async () => {
    const watcher = observer();
    await show(<ScrollArticle document={ready(bridgesPoster())} observer={watcher} />);

    await fireEvent.press(screen.getByRole('button', { name: 'Copy' }));

    await waitFor(() => expect(copyText).toHaveBeenCalledTimes(1));
    expect((copyText.mock.calls[0] as [string] | undefined)?.[0]).toContain('def deck_load(span_m, traffic_kn):');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeOnTheScreen();
    expect(watcher.onBlockInteraction).toHaveBeenCalledWith({
      blockId: 'code-load',
      blockType: 'code',
      kind: 'copied',
      at: anyNumber,
    });
    expect(interactionProblems(watcher, ready(bridgesPoster()))).toEqual([]);
  });

  it('says so when the clipboard refuses, and reports no copy (it is evidence only once the write succeeded)', async () => {
    copyText.mockRejectedValueOnce(new Error('denied'));
    const watcher = observer();
    await show(<ScrollArticle document={ready(bridgesPoster())} observer={watcher} />);

    await fireEvent.press(screen.getByRole('button', { name: 'Copy' }));

    expect(await screen.findByRole('button', { name: 'Copy failed' })).toBeOnTheScreen();
    expect(watcher.onBlockInteraction).not.toHaveBeenCalled();
  });
});

describe('a block this build cannot draw', () => {
  it('shows its own words under a one-line label, with no Retry (retrying cannot help), and records a diagnostic', async () => {
    const watcher = diagnostics();
    const document = ready(bridgesPoster());
    await show(<ScrollArticle document={document} diagnostics={watcher} />);

    expect(screen.getByText('Needs an app update · text version')).toBeOnTheScreen();
    expect(
      screen.getByText(
        'The deck passes its load to the cables, the cables pass it to the towers, and the towers pass it down to the ground.',
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /retry|try again/i })).toBeNull();
    expect(watcher.onRenderFallback).toHaveBeenCalledWith({
      blockId: 'diagram-load',
      blockType: 'diagram',
      reason: 'unsupported-by-client',
      at: anyNumber,
    });
  });

  it("renders the server's fallback block the same way, naming the type it replaced", async () => {
    const watcher = diagnostics();
    await show(<ScrollArticle document={ready(bridgesWithServerFallback())} diagnostics={watcher} />);

    expect(screen.getByText('Needs an app update · text version')).toBeOnTheScreen();
    expect(watcher.onRenderFallback).toHaveBeenCalledWith(
      expect.objectContaining({ blockId: 'diagram-load', blockType: 'diagram', reason: 'unsupported-by-client' }),
    );
  });

  it('records no diagnostic when every block drew', async () => {
    const watcher = diagnostics();
    await show(<ScrollArticle document={ready(lighthouseEditorial())} diagnostics={watcher} />);
    expect(watcher.onRenderFallback).not.toHaveBeenCalled();
  });
});

describe('a block the package does not accept', () => {
  it('shows its own text instead of a blank, keeps the rest of the article, and records a diagnostic', async () => {
    const original = bridgesPoster();
    const broken: ScrollDocument = {
      ...original,
      sections: original.sections.map((section) => ({
        ...section,
        blocks: section.blocks.map((block) =>
          block.type === 'list' ? { ...block, data: { ...block.data, items: block.data.items.slice(0, 1) } } : block,
        ),
      })),
    };
    const watcher = diagnostics();

    // Not through prepareScrollDocument: the block never went through the client parse, so the
    // article parses it defensively itself.
    await show(<ScrollArticle document={broken} diagnostics={watcher} />);

    expect(screen.getByText("This part couldn't load · text version")).toBeOnTheScreen();
    expect(screen.getByText('Compression pushes the ends of a part toward each other.')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /retry|try again/i })).toBeNull();
    expect(screen.getByRole('header', { name: 'Pushing and pulling' })).toBeOnTheScreen();
    expect(watcher.onRenderFallback).toHaveBeenCalledWith(
      expect.objectContaining({ blockId: 'l-forces', blockType: 'list', reason: 'invalid-block' }),
    );
  });
});

describe('a block that throws while rendering', () => {
  it('shows its fallback with Retry; Retry draws the block again, and records the retry as a diagnostic', async () => {
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const document = ready(bridgesPoster());
    const paragraph = document.sections[0]?.blocks[0];
    if (paragraph?.type !== 'paragraph') throw new Error('the fixture opens with a paragraph');
    const good = paragraph.data.spans;
    (paragraph.data as { spans: unknown }).spans = null;
    const watcher = observer();
    const diag = diagnostics();

    await show(<ScrollArticle document={document} observer={watcher} diagnostics={diag} />);

    expect(screen.getByText("This part couldn't load · text version")).toBeOnTheScreen();
    expect(screen.getByText("This part of the Scroll can't be shown right now.")).toBeOnTheScreen();
    expect(diag.onRenderFallback).toHaveBeenCalledWith(
      expect.objectContaining({ blockId: 'p-open-1', blockType: 'paragraph', reason: 'render-error' }),
    );
    // The rest of the article is still there.
    expect(screen.getByRole('header', { name: 'Pushing and pulling' })).toBeOnTheScreen();

    (paragraph.data as { spans: unknown }).spans = good;
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));

    expect(screen.queryByText("This part couldn't load · text version")).toBeNull();
    expect(
      screen.getByText(
        'A bridge has one job: carry weight from where it is to where it can safely go. How it does that is a story about two forces.',
      ),
    ).toBeOnTheScreen();
    // A Retry is a diagnostic for engineers, not a reader interaction: the package declares no
    // interaction kinds for a fallback, so the observer hears nothing and the diagnostic hook does.
    expect(watcher.onBlockInteraction).not.toHaveBeenCalled();
    expect(diag.onFallbackRetry).toHaveBeenCalledWith({ blockId: 'p-open-1', blockType: 'paragraph', at: anyNumber });
    quiet.mockRestore();
  });
});

describe('restoring to a block by its id', () => {
  it('scrolls to the block and flashes it on the highlight ground', async () => {
    await show(<ScrollArticle document={ready(bridgesPoster())} anchorBlockId="code-load" />);
    expect(screen.getByTestId('block-code-load')).not.toHaveStyle({ backgroundColor: content.highlight });

    await fireEvent(screen.getByTestId('block-code-load'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 900, width: 350, height: 290 } },
    });

    expect(scrollTo).toHaveBeenCalledWith({ y: 900 - spacing[4], animated: false });
    expect(screen.getByTestId('block-code-load')).toHaveStyle({ backgroundColor: content.highlight });
  });

  it('does nothing for a block the revision does not have', async () => {
    await show(<ScrollArticle document={ready(bridgesPoster())} anchorBlockId="no-such-block" />);
    await fireEvent(screen.getByTestId('block-code-load'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 900, width: 350, height: 290 } },
    });
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('opens the disclosure that holds a nested block before anything draws', async () => {
    await show(<ScrollArticle document={ready(bridgesPoster())} anchorBlockId="safety-why" />);

    expect(screen.getByRole('button', { name: 'Why a safety factor?' })).toBeExpanded();
    expect(screen.getByText('safety factor')).toBeOnTheScreen();
  });
});

describe('what the reader sees, reported to the observer', () => {
  const layoutOf = (y: number, height: number) => ({ nativeEvent: { layout: { x: 0, y, width: 350, height } } });
  const scrolled = (y: number) => ({
    nativeEvent: { contentOffset: { x: 0, y }, layoutMeasurement: { width: 390, height: 800 } },
  });
  const fractions = (watcher: ReturnType<typeof observer>, blockId: string) =>
    watcher.onBlockVisibility.mock.calls
      .map(([event]: [{ blockId: string; visibleFraction: number }]) => event)
      .filter((event) => event.blockId === blockId)
      .map((event) => event.visibleFraction);

  it('reports every block as it mounts, then a change of a tenth or a crossing of 0, 0.5 or 1', async () => {
    const watcher = observer();
    await show(<ScrollArticle document={ready(bridgesPoster())} observer={watcher} testID="article" />);
    expect(fractions(watcher, 'p-open-1')).toEqual([0]);
    expect(watcher.onBlockVisibility).toHaveBeenCalledWith({
      blockId: 'code-load',
      visibleFraction: 0,
      at: anyNumber,
    });

    await fireEvent(screen.getByTestId('article'), 'layout', layoutOf(0, 800));
    await fireEvent(screen.getByTestId('block-p-open-1'), 'layout', layoutOf(100, 100));
    expect(fractions(watcher, 'p-open-1')).toEqual([0, 1]);

    await fireEvent.scroll(screen.getByTestId('article'), scrolled(150));
    expect(fractions(watcher, 'p-open-1')).toEqual([0, 1, 0.5]);
    await fireEvent.scroll(screen.getByTestId('article'), scrolled(160));
    expect(fractions(watcher, 'p-open-1')).toEqual([0, 1, 0.5, 0.4]);
    // 0.35: a move of 0.05 that crosses nothing is not an event.
    await fireEvent.scroll(screen.getByTestId('article'), scrolled(165));
    expect(fractions(watcher, 'p-open-1')).toEqual([0, 1, 0.5, 0.4]);
    await fireEvent.scroll(screen.getByTestId('article'), scrolled(250));
    expect(fractions(watcher, 'p-open-1')).toEqual([0, 1, 0.5, 0.4, 0]);
  });

  it('does not count what the screen chrome covers as read', async () => {
    const watcher = observer();
    await show(
      <ScrollArticle
        document={ready(bridgesPoster())}
        observer={watcher}
        testID="article"
        readingInset={{ top: 120, bottom: 0 }}
      />,
    );
    await fireEvent(screen.getByTestId('article'), 'layout', layoutOf(0, 800));

    await fireEvent(screen.getByTestId('block-p-open-1'), 'layout', layoutOf(40, 100));

    // 40..140 against a reading area that starts at 120: 20 of 100 px.
    expect(fractions(watcher, 'p-open-1')).toEqual([0, 0.2]);
  });

  it('reports a block that unmounts as 0 and the article as no longer active', async () => {
    const watcher = observer();
    const view = await show(<ScrollArticle document={ready(bridgesPoster())} observer={watcher} testID="article" />);
    watcher.onBlockVisibility.mockClear();
    watcher.onActivity.mockClear();

    await view.unmount();

    expect(watcher.onBlockVisibility).toHaveBeenCalledWith({
      blockId: 'p-open-1',
      visibleFraction: 0,
      at: anyNumber,
    });
    expect(watcher.onActivity).toHaveBeenCalledWith({ active: false, at: anyNumber });
  });

  it('works without an observer', async () => {
    await show(<ScrollArticle document={ready(bridgesPoster())} testID="article" />);
    await fireEvent(screen.getByTestId('article'), 'layout', layoutOf(0, 800));
    await fireEvent.scroll(screen.getByTestId('article'), scrolled(100));
    expect(screen.getByTestId('article')).toBeOnTheScreen();
  });
});

describe('whether the article is being read', () => {
  it('is active once it mounts, inactive while an overlay holds the reader, and active again after', async () => {
    const watcher = observer();
    const document = ready(bridgesPoster());
    const view = await show(<ScrollArticle document={document} observer={watcher} />);
    expect(watcher.onActivity).toHaveBeenLastCalledWith({ active: true, at: anyNumber });

    await view.rerender(wrap(<ScrollArticle document={document} observer={watcher} paused />));
    expect(watcher.onActivity).toHaveBeenLastCalledWith({ active: false, at: anyNumber });

    await view.rerender(wrap(<ScrollArticle document={document} observer={watcher} />));
    expect(watcher.onActivity).toHaveBeenLastCalledWith({ active: true, at: anyNumber });
    expect(watcher.onActivity).toHaveBeenCalledTimes(3);
  });

  it('is inactive while the app is in the background', async () => {
    const handlers: ((state: string) => void)[] = [];
    // The preset's AppState is a bare mock: capture the listener the article registers.
    (AppState.addEventListener as unknown as jest.Mock).mockImplementationOnce(
      (_type: string, handler: (state: string) => void) => {
        handlers.push(handler);
        return { remove: jest.fn() };
      },
    );
    const watcher = observer();
    await show(<ScrollArticle document={ready(bridgesPoster())} observer={watcher} />);
    expect(watcher.onActivity).toHaveBeenLastCalledWith({ active: true, at: anyNumber });

    handlers.forEach((handler) => handler('background'));
    expect(watcher.onActivity).toHaveBeenLastCalledWith({ active: false, at: anyNumber });

    handlers.forEach((handler) => handler('active'));
    expect(watcher.onActivity).toHaveBeenLastCalledWith({ active: true, at: anyNumber });
  });
});
