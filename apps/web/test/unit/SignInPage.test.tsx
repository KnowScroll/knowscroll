import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiException } from '../../src/api/client.ts';
import { SignInPage } from '../../src/components/SignInPage.tsx';

/**
 * #135, ADR-0034 section 6 (the link): `/sign-in#token=<token>`. The page must strip the fragment
 * at once (so a mail scanner or a reload never leaves a token in the address bar or its history)
 * and keep the token only in memory -- consumed by `POST /v1/auth/web-session` only on an explicit
 * click, never merely by loading the page.
 */
function setHash(hash: string): void {
  window.history.replaceState(null, '', `/sign-in${hash}`);
}

const webSessionResponse = {
  sessionId: 's1',
  deviceId: 'd1',
  universeId: 'u1',
  privacyEpoch: 0,
  expiresAt: '2026-01-01T00:00:00.000Z',
  accountId: 'a1',
  origin: 'magic_link' as const,
  csrfToken: 'x'.repeat(64),
};

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('SignInPage', () => {
  it('strips the token from the URL immediately, keeping it only in memory', () => {
    setHash('#token=abc123');
    render(<SignInPage apiClient={{ postWebSession: vi.fn(), setCsrfToken: vi.fn() }} onSignedIn={() => {}} onRequestNewLink={() => {}} />);
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain('abc123');
  });

  it('does not consume the token merely by loading the page -- only the click posts it', () => {
    setHash('#token=abc123');
    const postWebSession = vi.fn();
    render(<SignInPage apiClient={{ postWebSession, setCsrfToken: vi.fn() }} onSignedIn={() => {}} onRequestNewLink={() => {}} />);
    expect(postWebSession).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /sign in on this browser/i })).toBeInTheDocument();
  });

  it('clicking posts the token, keeps the returned CSRF token in memory via the client, and signs in', async () => {
    setHash('#token=abc123');
    const postWebSession = vi.fn(async () => webSessionResponse);
    const setCsrfToken = vi.fn();
    const onSignedIn = vi.fn();
    render(<SignInPage apiClient={{ postWebSession, setCsrfToken }} onSignedIn={onSignedIn} onRequestNewLink={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /sign in on this browser/i }));
    await waitFor(() => expect(postWebSession).toHaveBeenCalledWith('abc123'));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(setCsrfToken).toHaveBeenCalledWith('x'.repeat(64));
  });

  it('a 401 shows the expired/already-used message with a way to request a new link', async () => {
    setHash('#token=abc123');
    const postWebSession = vi.fn(async () => {
      throw new ApiException({ kind: 'server', statusCode: 401, body: 'unauthorized' });
    });
    const onRequestNewLink = vi.fn();
    render(<SignInPage apiClient={{ postWebSession, setCsrfToken: vi.fn() }} onSignedIn={() => {}} onRequestNewLink={onRequestNewLink} />);
    fireEvent.click(screen.getByRole('button', { name: /sign in on this browser/i }));
    await screen.findByText(/expired or was already used/i);
    fireEvent.click(screen.getByRole('button', { name: /request a new link/i }));
    expect(onRequestNewLink).toHaveBeenCalledTimes(1);
  });

  it('no token in the URL at all shows the same expired/used recovery, never a broken click', () => {
    setHash('');
    render(<SignInPage apiClient={{ postWebSession: vi.fn(), setCsrfToken: vi.fn() }} onSignedIn={() => {}} onRequestNewLink={() => {}} />);
    expect(screen.getByText(/expired or was already used/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign in on this browser/i })).not.toBeInTheDocument();
  });

  it('a non-401 failure shows a real retryable error, distinct from the expired/used message, and Try again resends the same token', async () => {
    setHash('#token=abc123');
    const postWebSession = vi.fn(async () => {
      throw new ApiException({ kind: 'network', message: 'dropped' });
    });
    render(<SignInPage apiClient={{ postWebSession, setCsrfToken: vi.fn() }} onSignedIn={() => {}} onRequestNewLink={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /sign in on this browser/i }));
    await screen.findByRole('alert');
    expect(screen.queryByText(/expired or was already used/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(postWebSession).toHaveBeenCalledTimes(2));
    expect(postWebSession).toHaveBeenNthCalledWith(2, 'abc123');
  });
});
