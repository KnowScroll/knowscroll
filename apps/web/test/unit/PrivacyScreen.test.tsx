import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PrivacyScreen } from '../../src/components/PrivacyScreen.tsx';
import type { PrivacyActionState, PrivacyView } from '../../src/state/readerStore.ts';
import { privacyExportResultOf, privacyResetReceiptOf, universeOf } from './fakeApi.ts';

function loadedUniverse(overrides: Parameters<typeof universeOf>[0] = {}) {
  return { status: 'loaded' as const, universe: universeOf(overrides) };
}

function open(action: PrivacyActionState): PrivacyView {
  return { status: 'open', action };
}

const noop = {
  onReturn: () => {},
  onPause: () => {},
  onResume: () => {},
  onExport: () => {},
  onBeginReset: () => {},
  onCancelReset: () => {},
  onConfirmReset: (_typed: string) => {},
  onAcknowledgeReset: () => {},
  onEnterScroll: () => {},
};

describe('PrivacyScreen', () => {
  it('shows an honest unavailable state when the universe behind it is not loaded', () => {
    render(<PrivacyScreen universe={{ status: 'unavailable', message: 'Connection interrupted.' }} privacy={{ status: 'idle' }} {...noop} />);
    expect(screen.getByText(/privacy controls are unavailable/i)).toBeInTheDocument();
  });

  it('shows recording is on and offers Pause, stating plainly that pausing does not erase anything already recorded', () => {
    const onPause = vi.fn();
    render(<PrivacyScreen universe={loadedUniverse({ recordingPausedAt: null })} privacy={open({ status: 'idle' })} {...noop} onPause={onPause} />);

    expect(screen.getByText(/recording is on/i)).toBeInTheDocument();
    const button = screen.getByRole('button', { name: /pause recording/i });
    fireEvent.click(button);
    expect(onPause).toHaveBeenCalledTimes(1);

    // Honesty rule: pausing must not be described as erasing history.
    expect(screen.getByText(/does not erase|does not delete/i)).toBeInTheDocument();
  });

  it('shows recording is paused (with the real timestamp) and offers Resume, never a local guess', () => {
    const onResume = vi.fn();
    render(
      <PrivacyScreen
        universe={loadedUniverse({ recordingPausedAt: '2026-09-21T09:00:00.000Z' })}
        privacy={open({ status: 'idle' })}
        {...noop}
        onResume={onResume}
      />,
    );

    expect(screen.getByText(/recording is paused/i)).toBeInTheDocument();
    const button = screen.getByRole('button', { name: /resume recording/i });
    fireEvent.click(button);
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('disables the pause/resume control while the action is pending', () => {
    render(
      <PrivacyScreen
        universe={loadedUniverse({ recordingPausedAt: null })}
        privacy={open({ status: 'pending', kind: 'pause', requestId: 'r1' })}
        {...noop}
      />,
    );
    expect(screen.getByRole('button', { name: /pause recording/i })).toBeDisabled();
  });

  it('shows a real failure message and a working retry that re-invokes the same action', () => {
    const onPause = vi.fn();
    render(
      <PrivacyScreen
        universe={loadedUniverse({ recordingPausedAt: null })}
        privacy={open({ status: 'failed', kind: 'pause', requestId: 'r1', message: 'Connection interrupted.' })}
        {...noop}
        onPause={onPause}
      />,
    );
    expect(screen.getByText('Connection interrupted.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onPause).toHaveBeenCalledTimes(1);
  });

  it('requests an export and offers a real downloadable file once it is ready, with the real row counts', () => {
    const onExport = vi.fn();
    const { rerender } = render(
      <PrivacyScreen universe={loadedUniverse()} privacy={open({ status: 'idle' })} {...noop} onExport={onExport} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /take your data|export/i }));
    expect(onExport).toHaveBeenCalledTimes(1);

    const result = privacyExportResultOf();
    rerender(<PrivacyScreen universe={loadedUniverse()} privacy={open({ status: 'export-ready', requestId: 'r1', result })} {...noop} />);

    const link = screen.getByRole('link', { name: /download/i });
    expect(link).toHaveAttribute('download');
    const href = link.getAttribute('href') ?? '';
    expect(href.startsWith('data:application/json')).toBe(true);
    const decoded = JSON.parse(decodeURIComponent(href.slice(href.indexOf(',') + 1))) as typeof result;
    expect(decoded).toEqual(result);
    expect(screen.getByText(new RegExp(`${result.rowCounts.ledger}`))).toBeInTheDocument();
  });

  it('gates reset behind an exact typed confirmation matching the wire literal, and states the real irreversible consequence', () => {
    const onBeginReset = vi.fn();
    const onConfirmReset = vi.fn();
    const { rerender } = render(
      <PrivacyScreen universe={loadedUniverse()} privacy={open({ status: 'idle' })} {...noop} onBeginReset={onBeginReset} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /reset your universe/i }));
    expect(onBeginReset).toHaveBeenCalledTimes(1);

    rerender(
      <PrivacyScreen universe={loadedUniverse()} privacy={open({ status: 'confirming-reset' })} {...noop} onConfirmReset={onConfirmReset} />,
    );
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
    const confirmButton = screen.getByRole('button', { name: /^confirm reset$/i });
    expect(confirmButton).toBeDisabled();

    const input = screen.getByLabelText(/type.*reset-personal-universe/i);
    fireEvent.change(input, { target: { value: 'not it' } });
    expect(confirmButton).toBeDisabled();

    fireEvent.change(input, { target: { value: 'reset-personal-universe' } });
    expect(confirmButton).toBeEnabled();
    fireEvent.click(confirmButton);
    expect(onConfirmReset).toHaveBeenCalledWith('reset-personal-universe');
  });

  it('cancelling reset confirmation calls onCancelReset', () => {
    const onCancelReset = vi.fn();
    render(<PrivacyScreen universe={loadedUniverse()} privacy={open({ status: 'confirming-reset' })} {...noop} onCancelReset={onCancelReset} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancelReset).toHaveBeenCalledTimes(1);
  });

  it('shows the real reset receipt -- epoch change and sessions revoked -- and a Continue that acknowledges it', () => {
    const onAcknowledgeReset = vi.fn();
    const receipt = privacyResetReceiptOf({ epochBefore: 0, epochAfter: 1, sessionsRevoked: 1 });
    render(
      <PrivacyScreen universe={loadedUniverse()} privacy={open({ status: 'reset-complete', receipt })} {...noop} onAcknowledgeReset={onAcknowledgeReset} />,
    );
    expect(screen.getByText(/0.*(→|to).*1|epoch 1/i)).toBeInTheDocument();
    expect(screen.getByText(/session/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(onAcknowledgeReset).toHaveBeenCalledTimes(1);
  });

  it('returns to Universe on Escape, Home and the back pill, and carries the shared dock', () => {
    const onReturn = vi.fn();
    render(<PrivacyScreen universe={loadedUniverse()} privacy={open({ status: 'idle' })} {...noop} onReturn={onReturn} />);

    fireEvent.click(screen.getByRole('button', { name: 'Return to Universe' }));
    expect(onReturn).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onReturn).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(window, { key: 'Home' });
    expect(onReturn).toHaveBeenCalledTimes(3);

    const dock = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(dock).toBeInTheDocument();
    expect(dock.querySelector('[aria-current]')).toBeNull();
  });
});
