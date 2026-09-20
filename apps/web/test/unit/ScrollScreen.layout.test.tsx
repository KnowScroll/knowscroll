import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ScrollScreen } from '../../src/components/ScrollScreen.tsx';
import type { ScrollView } from '../../src/state/readerStore.ts';
import { feedItem } from './fakeApi.ts';

/**
 * #107: presentation-layer tests for the ui-system.md-shaped desktop reader.
 * These check structure/behaviour that the pre-existing ScrollScreen.test.tsx
 * did not cover, without duplicating it.
 */

function readingState(overrides: Partial<Extract<ScrollView, { status: 'reading' }>> = {}): ScrollView {
  return {
    status: 'reading',
    item: feedItem(),
    exposureId: '',
    eventId: 'evt-1',
    keep: { status: 'idle' },
    readingPosition: 0,
    discovery: 'idle',
    origin: { type: 'discovery' },
    ...overrides,
  };
}

function renderReading(overrides: Partial<Extract<ScrollView, { status: 'reading' }>> = {}) {
  return render(
    <ScrollScreen
      state={readingState(overrides)}
      onVisible={vi.fn()}
      onKeep={vi.fn()}
      onNext={vi.fn()}
      onReturn={vi.fn()}
      onRetry={vi.fn()}
      onReadingPosition={vi.fn()}
    />,
  );
}

describe('ScrollScreen desktop structure (ui-system.md sec.4)', () => {
  it('renders a head band above the stage with back, origin and a monospace kind label', () => {
    const { container } = renderReading();
    const headBand = container.querySelector('.head-band');
    expect(headBand).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Return to Universe' })).toBeInTheDocument();
    expect(headBand?.querySelector('.head-band-origin')?.textContent).toMatch(/Deliberate discovery/);
    expect(headBand?.querySelector('.head-band-kind')?.textContent).toBe('Scroll');
  });

  it('applies the two-column reading grid (context rail + reading column), never a single full-width column', () => {
    const { container } = renderReading();
    const layout = container.querySelector('.scroll-layout');
    expect(layout).toBeTruthy();
    expect(layout?.querySelector('.context-rail')).toBeTruthy();
    const article = layout?.querySelector('article.reading-column');
    expect(article).toBeTruthy();
    expect(article?.getAttribute('role') ?? 'article').toBe('article');
  });

  it('keeps the truth pill adjacent to the claim it qualifies, never buried at the end', () => {
    const { container } = renderReading();
    const article = container.querySelector('article.reading-column');
    expect(article).toBeTruthy();
    const children = Array.from(article!.children);
    const truthLineIndex = children.findIndex(el => el.classList.contains('truth-line'));
    const headingIndex = children.findIndex(el => el.tagName === 'H2');
    expect(truthLineIndex).toBeGreaterThanOrEqual(0);
    expect(headingIndex).toBeGreaterThan(truthLineIndex);
    // Adjacent: nothing else sits between the pill row and the claim's heading.
    expect(headingIndex - truthLineIndex).toBe(1);
    const truthPill = article!.querySelector('.truth-pill');
    expect(truthPill?.textContent).toBe('DOCUMENTED');
  });

  it('never binds ArrowRight, and ArrowDown fires the same action as the Next pill', () => {
    const onNext = vi.fn();
    const onReturn = vi.fn();
    render(
      <ScrollScreen
        state={readingState()}
        onVisible={vi.fn()}
        onKeep={vi.fn()}
        onNext={onNext}
        onReturn={onReturn}
        onRetry={vi.fn()}
        onReadingPosition={vi.fn()}
      />,
    );
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(onNext).not.toHaveBeenCalled();
    expect(onReturn).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(onNext).toHaveBeenCalledTimes(1);
  });
});

describe('reduced motion (ui-system.md sec.3)', () => {
  it('suspends every transition/animation under prefers-reduced-motion: reduce', () => {
    const cssPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'styles.css');
    const css = readFileSync(cssPath, 'utf8');
    const match = /@media \(prefers-reduced-motion: reduce\)\s*{([^}]*{[^}]*})*[^}]*}/.exec(css);
    expect(match).toBeTruthy();
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(block).toMatch(/animation:\s*none\s*!important/);
    expect(block).toMatch(/transition:\s*none\s*!important/);
  });

  it('gates the only Universe-canvas motion behind prefers-reduced-motion: no-preference', () => {
    const cssPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'styles.css');
    const css = readFileSync(cssPath, 'utf8');
    const idx = css.indexOf('@media (prefers-reduced-motion: no-preference)');
    expect(idx).toBeGreaterThan(-1);
    expect(css.slice(idx, idx + 200)).toMatch(/cosmos-background/);
  });
});
