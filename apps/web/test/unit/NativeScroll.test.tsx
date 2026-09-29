import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NativeScroll, type NativeScrollBlock } from '../../src/components/NativeScroll.tsx';

const item = (overrides: Record<string, unknown> = {}) => ({ assetId: 'asset-private-id', title: 'A changing pattern', body: 'One paragraph.\n\nA second paragraph.', ...overrides });

describe('NativeScroll', () => {
  it('renders the existing body as editorial paragraphs while blocks are absent', () => {
    render(<NativeScroll item={item()} />);
    expect(screen.getByRole('heading', { level: 1, name: 'A changing pattern' })).toBeInTheDocument();
    expect(screen.getByText('One paragraph.')).toBeInTheDocument();
    expect(screen.getByText('A second paragraph.')).toBeInTheDocument();
    expect(screen.queryByText(/asset-private-id/)).not.toBeInTheDocument();
  });

  it('renders typed blocks and preserves text as text instead of interpreting markup', () => {
    const blocks: NativeScrollBlock[] = [
      { type: 'text', heading: 'A note', paragraphs: ['<img src=x onerror=alert(1)>'] },
      { type: 'disclosure', label: 'A closer look', body: 'Details stay closed until opened.' },
      { type: 'comparison', title: 'Two ways', left: { label: 'One', points: ['First'] }, right: { label: 'Two', points: ['Second'] } },
      { type: 'timeline', title: 'Sequence', events: [{ label: 'First', detail: 'Starts' }, { label: 'Then', detail: 'Changes' }] },
      { type: 'diagram', title: 'A small map', nodes: [{ id: 'a', label: 'One' }, { id: 'b', label: 'Two' }], edges: [{ from: 'a', to: 'b', label: 'leads to' }] },
      { type: 'visualization', title: 'A wave', description: 'Move the control to change the example curve.', frequency: 1 },
    ];
    render(<NativeScroll item={item({ blocks })} />);
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('Details stay closed until opened.')).not.toBeVisible();
    expect(screen.getByRole('heading', { name: 'Two ways' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'A small map' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Sample values, available without the canvas' })).toBeInTheDocument();
  });

  it('shows a visible safe fallback for malformed and unsupported blocks', () => {
    render(<NativeScroll item={item({ blocks: [{ type: 'html', value: '<script>alert(1)</script>' }, { type: 'diagram', nodes: [] }] })} />);
    expect(screen.getByRole('status')).toHaveTextContent('structured content is unavailable');
    expect(document.querySelector('script')).toBeNull();
  });

  it('provides a keyboard-operable range control and Keep action', () => {
    const onKeep = vi.fn();
    render(<NativeScroll item={item({ blocks: [{ type: 'visualization', title: 'A wave', description: 'An example.', frequency: 1 }] })} onKeep={onKeep} />);
    const slider = screen.getByRole('slider', { name: 'Wave cycles' });
    fireEvent.change(slider, { target: { value: '2' } });
    expect(screen.getByText('2.0')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep this Scroll' }));
    expect(onKeep).toHaveBeenCalledOnce();
  });
});
